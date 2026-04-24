const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    downloadMediaMessage
} = require("@whiskeysockets/baileys")

const P = require("pino")
const QRCode = require("qrcode")
const http = require("http")
const fs = require("fs-extra")
const path = require("path")
const { Sticker, StickerTypes } = require("wa-sticker-formatter")
const ytSearch = require("yt-search")

// ================= PROTEÇÃO CONTRA CRASHES =================
process.on("unhandledRejection", (reason) => {
    console.error("⚠️ unhandledRejection (ignorado):", reason?.message || reason)
})
process.on("uncaughtException", (err) => {
    console.error("⚠️ uncaughtException (ignorado):", err?.message || err)
})

// ================= SERVIDOR WEB DO QR =================
let currentQR = null
let isConnected = false

const PORT = process.env.PORT || 3000

http.createServer(async (req, res) => {
    const hasBotPrefix = req.url.startsWith("/bot")
    const url = hasBotPrefix ? (req.url.replace(/^\/bot/, "") || "/") : req.url
    const base = hasBotPrefix ? "/bot" : ""

    if (url === "/qr.png" || url.startsWith("/qr.png?")) {
        if (!currentQR) {
            res.writeHead(404)
            return res.end("Sem QR no momento")
        }
        const buf = await QRCode.toBuffer(currentQR, { width: 400, margin: 2 })
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" })
        return res.end(buf)
    }

    if (url === "/qr.txt") {
        if (!currentQR) {
            res.writeHead(404)
            return res.end("Sem QR no momento")
        }
        const dataUrl = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 })
        res.writeHead(200, { "Content-Type": "text/plain" })
        return res.end(dataUrl)
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    if (isConnected) {
        return res.end(`
<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Bot</title>
<body style="font-family:system-ui;background:#0b141a;color:#e9edef;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
<div><h1 style="color:#25d366">✅ Bot Online</h1><p>O bot está conectado ao WhatsApp.</p></div>
</body>`)
    }
    if (!currentQR) {
        return res.end(`
<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Bot</title>
<meta http-equiv="refresh" content="3">
<body style="font-family:system-ui;background:#0b141a;color:#e9edef;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
<div><h1>⏳ Aguardando QR...</h1><p>Esta página recarrega sozinha.</p></div>
</body>`)
    }
    const dataUrl = await QRCode.toDataURL(currentQR, { width: 400, margin: 2 })
    return res.end(`
<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Bot — Escaneia o QR</title>
<meta http-equiv="refresh" content="25">
<body style="font-family:system-ui;background:#0b141a;color:#e9edef;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center">
<div>
<h1 style="color:#25d366;margin:0 0 8px">📱 Escaneia o QR no WhatsApp</h1>
<p style="opacity:.8;margin:0 0 16px">Aparelhos conectados → Conectar um aparelho</p>
<img src="${dataUrl}" style="background:#fff;padding:12px;border-radius:12px;max-width:90vw;width:400px;height:auto" alt="QR" />
<p style="opacity:.6;font-size:13px;margin-top:16px">A página recarrega sozinha a cada 25s</p>
</div>
</body>`)
}).listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 QR disponível em http://0.0.0.0:${PORT}`)
})

const PREFIX = "!"
const OWNER = "258864617807@s.whatsapp.net"

// ================= DATABASE =================
const dbFile = path.join(__dirname, "database.json")

let db = {
    avisos: {},
    xp: {},
    flood: {},
    modoSilencio: {},
    antiLink: {},
    antiPalavrao: {},
    boasVindas: {},
    regras: {},
    bemVindo: {}
}

if (fs.existsSync(dbFile)) {
    db = { ...db, ...fs.readJsonSync(dbFile) }
}

const saveDB = () => fs.writeJsonSync(dbFile, db, { spaces: 2 })

// ================= FILTROS =================
const BAD_WORDS = ["puta", "caralho", "fdp", "merda", "idiota", "burro", "lixo"]
const LINK_REGEX = /(https?:\/\/|www\.|\.(com|net|org|io))/i

// ================= CONTROLE DE RECONEXÃO =================
let reconnecting = false
let reconnectAttempts = 0
let connectedAt = 0

async function startBot() {

    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth"))
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: "silent" }),
        browser: Browsers.macOS("Safari"),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 25000,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
        getMessage: async () => ({ conversation: "" })
    })

    // ================= CONEXÃO =================
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            currentQR = qr
            isConnected = false
            const url = process.env.REPLIT_DEV_DOMAIN
                ? `https://${process.env.REPLIT_DEV_DOMAIN}/bot`
                : `http://localhost:${PORT}`
            console.log("\n========================================")
            console.log("📱 ABRE ESTE LINK NO NAVEGADOR E ESCANEIA O QR:")
            console.log(`\n   ${url}\n`)
            console.log("Depois: WhatsApp > Aparelhos conectados > Conectar um aparelho")
            console.log("========================================\n")
        }

        if (connection === "open") {
            currentQR = null
            isConnected = true
            connectedAt = Date.now()
            console.log("\n✅ BOT ONLINE NO WHATSAPP — conectado com sucesso!\n")
            reconnectAttempts = 0
            reconnecting = false
        }

        if (connection === "close") {

            const code = lastDisconnect?.error?.output?.statusCode

            console.log("❌ CONEXÃO FECHADA:", code)

            if (code === DisconnectReason.loggedOut) {
                console.log("⚠️ Sessão inválida. Apaga pasta auth e gera novo QR.")
                return
            }

            if (reconnecting) return
            reconnecting = true

            reconnectAttempts++

            let delay = 5000

            if (reconnectAttempts > 3) delay = 15000
            if (reconnectAttempts > 6) delay = 30000

            console.log(`🔄 Reconectando em ${delay / 1000}s...`)

            setTimeout(() => {
                reconnecting = false
                startBot()
            }, delay)
        }
    })

    sock.ev.on("creds.update", saveCreds)

    // ================= BOAS-VINDAS / DESPEDIDAS =================
    sock.ev.on("group-participants.update", async (ev) => {
        try {
            const { id, participants, action } = ev
            if (!db.boasVindas[id]) return

            for (const p of participants) {
                if (action === "add") {
                    const msg = (db.bemVindo[id] || "👋 Bem-vindo(a) @user ao grupo!")
                        .replace("@user", "@" + p.split("@")[0])
                    await sock.sendMessage(id, { text: msg, mentions: [p] })
                }
                if (action === "remove") {
                    await sock.sendMessage(id, {
                        text: `👋 Adeus @${p.split("@")[0]}`,
                        mentions: [p]
                    })
                }
            }
        } catch (err) {
            console.log("❌ ERRO BOAS-VINDAS:", err)
        }
    })

    // ================= MENSAGENS =================
    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {

            const msg = messages[0]
            if (!msg.message || msg.key.fromMe) return
            if (!isConnected) return
            if (Date.now() - connectedAt < 8000) return

            const from = msg.key.remoteJid
            const isGroup = from.endsWith("@g.us")
            const sender = msg.key.participant || from
            const isOwner = sender === OWNER

            let text = msg.message.conversation ||
                msg.message.extendedTextMessage?.text || ""

            const rawText = text.trim()
            text = rawText.toLowerCase()
            if (!text) return

            const args = rawText.split(/\s+/).slice(1)

            // mentions: tagged users + quoted user
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || []
            const quoted = msg.message.extendedTextMessage?.contextInfo?.participant
            const target = mentioned[0] || quoted

            // ================= XP =================
            db.xp[sender] = (db.xp[sender] || 0) + 1

            // ================= FLOOD =================
            db.flood[sender] = (db.flood[sender] || 0) + 1
            setTimeout(() => db.flood[sender] = 0, 5000)

            // ================= METADATA =================
            let isAdmin = false
            let isBotAdmin = false
            let participants = []
            let metadata = null

            if (isGroup) {
                metadata = await sock.groupMetadata(from)
                participants = metadata.participants
                isAdmin = !!participants.find(p => p.id === sender)?.admin || isOwner
                const botId = sock.user.id.split(":")[0] + "@s.whatsapp.net"
                isBotAdmin = !!participants.find(p => p.id === botId)?.admin
            }

            if (isGroup && db.flood[sender] > 6 && !isAdmin) {
                if (isBotAdmin) await sock.sendMessage(from, { delete: msg.key })
                return
            }

            // ================= AVISO =================
            async function warn(reason) {

                db.avisos[sender] = (db.avisos[sender] || 0) + 1

                if (db.avisos[sender] >= 4) {
                    if (isBotAdmin) {
                        await sock.groupParticipantsUpdate(from, [sender], "remove")
                    }
                    db.avisos[sender] = 0
                    saveDB()
                    return
                }

                saveDB()

                await sock.sendMessage(from, {
                    text: `⚠️ Aviso ${db.avisos[sender]}/3 (${reason})`,
                    mentions: [sender]
                })
            }

            // ================= FILTROS =================
            if (isGroup && !isAdmin) {

                if (db.antiLink[from] !== false && LINK_REGEX.test(text)) {
                    if (isBotAdmin) await sock.sendMessage(from, { delete: msg.key })
                    return warn("link")
                }

                if (db.antiPalavrao[from] !== false && BAD_WORDS.some(w => text.includes(w))) {
                    if (isBotAdmin) await sock.sendMessage(from, { delete: msg.key })
                    return warn("linguagem")
                }
            }

            if (isGroup && db.modoSilencio[from] && !isAdmin) return

            // ================= COMANDOS =================
            if (!text.startsWith(PREFIX)) return

            const cmd = text.split(/\s+/)[0].slice(1)

            const safeSend = async (jid, content, options = {}) => {
                for (let i = 0; i < 2; i++) {
                    try {
                        return await sock.sendMessage(jid, content, options)
                    } catch (e) {
                        console.error(`⚠️ envio falhou (tentativa ${i+1}):`, e?.message)
                        await new Promise(r => setTimeout(r, 1500))
                    }
                }
            }

            const reply = (t, mentions = []) =>
                safeSend(from, { text: t, mentions }, { quoted: msg })

            const needAdmin = async () => {
                if (!isGroup) { await reply("❌ Só funciona em grupos."); return false }
                if (!isAdmin) { await reply("❌ Só admins podem usar."); return false }
                return true
            }

            const needBotAdmin = async () => {
                if (!isBotAdmin) { await reply("❌ Preciso ser admin pra fazer isso."); return false }
                return true
            }

            // ============ PÚBLICO ============
            if (cmd === "menu" || cmd === "help") {
                return reply(
`🤖 *BOT WHATSAPP — MENU*

📌 *Geral*
!ping  !menu  !xp  !ranking
!regras  !grupoinfo  !meusavisos

🎨 *Mídia*
!sticker / !s (responder imagem)
!toimg (responder sticker)
!play <música>

🛡️ *Admin*
!ban @user (ou responder)
!promover @user
!rebaixar @user
!silenciar  !falar
!antilink on/off
!antipalavrao on/off
!boasvindas on/off
!setregras <texto>
!setbemvindo <texto>
!fechargrupo  !abrirgrupo
!todos  !marcartodos
!desavisar @user
!limparxp
!apagar (responder mensagem)

👑 *Dono*
!broadcast <texto>`
                )
            }

            if (cmd === "ping") return reply("🏓 Online")

            if (cmd === "xp") return reply(`✨ Seu XP: *${db.xp[sender] || 0}*`)

            if (cmd === "ranking") {
                let top = Object.entries(db.xp)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10)
                let txt = "🏆 *Ranking XP*\n\n"
                top.forEach((u, i) => {
                    txt += `${i + 1}. @${u[0].split("@")[0]} — ${u[1]}\n`
                })
                return reply(txt, top.map(u => u[0]))
            }

            if (cmd === "regras") {
                const r = db.regras[from] || "🚫 Links\n🚫 Palavrões\n⚠️ 3 avisos = ban"
                return reply(`📜 *REGRAS*\n\n${r}`)
            }

            if (cmd === "meusavisos") {
                return reply(`⚠️ Você tem *${db.avisos[sender] || 0}/3* avisos.`)
            }

            if (cmd === "grupoinfo") {
                if (!isGroup) return reply("❌ Só em grupos.")
                const admins = participants.filter(p => p.admin).length
                return reply(
`📋 *INFO DO GRUPO*

Nome: ${metadata.subject}
Membros: ${participants.length}
Admins: ${admins}
ID: ${from}`
                )
            }

            // ============ ADMIN ============
            if (cmd === "ban" || cmd === "kick") {
                if (!(await needAdmin())) return
                if (!(await needBotAdmin())) return
                if (!target) return reply("❌ Marque ou responda alguém.")
                await sock.groupParticipantsUpdate(from, [target], "remove")
                return reply(`🔨 Removido @${target.split("@")[0]}`, [target])
            }

            if (cmd === "promover") {
                if (!(await needAdmin())) return
                if (!(await needBotAdmin())) return
                if (!target) return reply("❌ Marque ou responda alguém.")
                await sock.groupParticipantsUpdate(from, [target], "promote")
                return reply(`⭐ Promovido @${target.split("@")[0]}`, [target])
            }

            if (cmd === "rebaixar") {
                if (!(await needAdmin())) return
                if (!(await needBotAdmin())) return
                if (!target) return reply("❌ Marque ou responda alguém.")
                await sock.groupParticipantsUpdate(from, [target], "demote")
                return reply(`⬇️ Rebaixado @${target.split("@")[0]}`, [target])
            }

            if (cmd === "silenciar") {
                if (!(await needAdmin())) return
                db.modoSilencio[from] = true
                saveDB()
                return reply("🔇 Modo silêncio ATIVADO. Só admins podem falar.")
            }

            if (cmd === "falar") {
                if (!(await needAdmin())) return
                db.modoSilencio[from] = false
                saveDB()
                return reply("🔊 Modo silêncio DESATIVADO.")
            }

            if (cmd === "antilink") {
                if (!(await needAdmin())) return
                const v = (args[0] || "").toLowerCase()
                if (v !== "on" && v !== "off") return reply("Uso: !antilink on/off")
                db.antiLink[from] = v === "on"
                saveDB()
                return reply(`🔗 Anti-link: *${v.toUpperCase()}*`)
            }

            if (cmd === "antipalavrao") {
                if (!(await needAdmin())) return
                const v = (args[0] || "").toLowerCase()
                if (v !== "on" && v !== "off") return reply("Uso: !antipalavrao on/off")
                db.antiPalavrao[from] = v === "on"
                saveDB()
                return reply(`🤬 Anti-palavrão: *${v.toUpperCase()}*`)
            }

            if (cmd === "boasvindas") {
                if (!(await needAdmin())) return
                const v = (args[0] || "").toLowerCase()
                if (v !== "on" && v !== "off") return reply("Uso: !boasvindas on/off")
                db.boasVindas[from] = v === "on"
                saveDB()
                return reply(`👋 Boas-vindas: *${v.toUpperCase()}*`)
            }

            if (cmd === "setregras") {
                if (!(await needAdmin())) return
                if (!args.length) return reply("Uso: !setregras <texto>")
                db.regras[from] = args.join(" ")
                saveDB()
                return reply("✅ Regras atualizadas.")
            }

            if (cmd === "setbemvindo") {
                if (!(await needAdmin())) return
                if (!args.length) return reply("Uso: !setbemvindo <texto>  (use @user)")
                db.bemVindo[from] = args.join(" ")
                saveDB()
                return reply("✅ Mensagem de boas-vindas atualizada.")
            }

            if (cmd === "fechargrupo") {
                if (!(await needAdmin())) return
                if (!(await needBotAdmin())) return
                await sock.groupSettingUpdate(from, "announcement")
                return reply("🔒 Grupo fechado. Só admins podem enviar mensagens.")
            }

            if (cmd === "abrirgrupo") {
                if (!(await needAdmin())) return
                if (!(await needBotAdmin())) return
                await sock.groupSettingUpdate(from, "not_announcement")
                return reply("🔓 Grupo aberto.")
            }

            if (cmd === "todos" || cmd === "marcartodos") {
                if (!(await needAdmin())) return
                const ids = participants.map(p => p.id)
                let txt = "📢 *Atenção!*\n\n"
                ids.forEach(i => txt += `• @${i.split("@")[0]}\n`)
                return sock.sendMessage(from, { text: txt, mentions: ids })
            }

            if (cmd === "desavisar") {
                if (!(await needAdmin())) return
                if (!target) return reply("❌ Marque ou responda alguém.")
                db.avisos[target] = 0
                saveDB()
                return reply(`✅ Avisos zerados de @${target.split("@")[0]}`, [target])
            }

            if (cmd === "limparxp") {
                if (!(await needAdmin())) return
                db.xp = {}
                saveDB()
                return reply("🧹 XP do grupo zerado.")
            }

            if (cmd === "apagar") {
                if (!(await needAdmin())) return
                if (!(await needBotAdmin())) return
                const ctx = msg.message.extendedTextMessage?.contextInfo
                if (!ctx?.stanzaId) return reply("❌ Responda à mensagem que quer apagar.")
                await sock.sendMessage(from, {
                    delete: {
                        remoteJid: from,
                        fromMe: false,
                        id: ctx.stanzaId,
                        participant: ctx.participant
                    }
                })
                return
            }

            // ============ MÍDIA ============
            if (cmd === "sticker" || cmd === "s") {
                const ctx = msg.message.extendedTextMessage?.contextInfo
                const quotedMsg = ctx?.quotedMessage
                const directImg = msg.message.imageMessage
                const directVid = msg.message.videoMessage

                let mediaMsg = null
                if (quotedMsg?.imageMessage || quotedMsg?.videoMessage) {
                    mediaMsg = {
                        key: {
                            remoteJid: from,
                            id: ctx.stanzaId,
                            participant: ctx.participant
                        },
                        message: quotedMsg
                    }
                } else if (directImg || directVid) {
                    mediaMsg = msg
                }

                if (!mediaMsg) {
                    return reply("❌ Envie uma imagem/vídeo ou responda a uma com !sticker")
                }

                await reply("⏳ Criando sticker...")

                try {
                    const buffer = await downloadMediaMessage(mediaMsg, "buffer", {})
                    const sticker = new Sticker(buffer, {
                        pack: "Bot",
                        author: "WhatsApp Bot",
                        type: StickerTypes.FULL,
                        quality: 70
                    })
                    const stickerBuffer = await sticker.toBuffer()
                    return sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg })
                } catch (e) {
                    console.log("STICKER ERR:", e)
                    return reply("❌ Falha ao criar sticker.")
                }
            }

            if (cmd === "toimg") {
                const ctx = msg.message.extendedTextMessage?.contextInfo
                const quotedMsg = ctx?.quotedMessage
                if (!quotedMsg?.stickerMessage) {
                    return reply("❌ Responda a um sticker com !toimg")
                }

                try {
                    const buffer = await downloadMediaMessage({
                        key: {
                            remoteJid: from,
                            id: ctx.stanzaId,
                            participant: ctx.participant
                        },
                        message: quotedMsg
                    }, "buffer", {})
                    return sock.sendMessage(from, {
                        image: buffer,
                        caption: "🖼️ Sticker convertido"
                    }, { quoted: msg })
                } catch (e) {
                    console.log("TOIMG ERR:", e)
                    return reply("❌ Falha ao converter.")
                }
            }

            if (cmd === "play") {
                if (!args.length) return reply("Uso: !play <nome da música>")
                await reply("🔎 Procurando...")
                try {
                    const r = await ytSearch(args.join(" "))
                    const video = r.videos[0]
                    if (!video) return reply("❌ Nada encontrado.")
                    return sock.sendMessage(from, {
                        text:
`🎵 *${video.title}*

👤 Canal: ${video.author.name}
⏱️ Duração: ${video.timestamp}
👀 Views: ${video.views.toLocaleString()}
📅 ${video.ago}

🔗 ${video.url}`,
                    }, { quoted: msg })
                } catch (e) {
                    console.log("PLAY ERR:", e)
                    return reply("❌ Falha na busca.")
                }
            }

            // ============ DONO ============
            if (cmd === "broadcast") {
                if (!isOwner) return reply("❌ Só o dono.")
                if (!args.length) return reply("Uso: !broadcast <texto>")
                const txt = args.join(" ")
                const groups = Object.keys(await sock.groupFetchAllParticipating())
                for (const g of groups) {
                    await sock.sendMessage(g, { text: `📣 *Broadcast*\n\n${txt}` })
                    await new Promise(r => setTimeout(r, 800))
                }
                return reply(`✅ Enviado para ${groups.length} grupos.`)
            }

        } catch (err) {
            console.log("❌ ERRO:", err)
        }
    })
}

// ================= PROTEÇÃO GLOBAL =================
process.on("uncaughtException", err => console.log("CRASH:", err))
process.on("unhandledRejection", err => console.log("REJECTION:", err))

startBot()
