const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    downloadMediaMessage,
    jidNormalizedUser
} = require("@whiskeysockets/baileys")

const P = require("pino")
const QRCode = require("qrcode")
const http = require("http")
const fs = require("fs-extra")
const path = require("path")
const axios = require("axios")
const { Sticker, StickerTypes } = require("wa-sticker-formatter")
const ytSearch = require("yt-search")

// ================= CONFIGURAÇÕES DO DONO & BOT =================
const PREFIX = "!"
const OWNER = "258858285865@s.whatsapp.net" 
const BOT_NAME = "The one man Bot"
const PORT = process.env.PORT || 3000
const dbFile = path.join(__dirname, "database.json")

// ================= DATABASE (SISTEMA DE MEMÓRIA) =================
let db = { groups: {}, users: {} }
if (fs.existsSync(dbFile)) {
    try { db = fs.readJsonSync(dbFile) } catch (e) { db = { groups: {}, users: {} } }
}
const saveDB = () => fs.writeJsonSync(dbFile, db, { spaces: 2 })

const BAD_WORDS = ["puta", "caralho", "fdp", "merda", "lixo", "verme", "corno", "idiota", "desgraça"]
const LINK_REGEX = /((https?:\/\/)|(www\.))[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi

// ================= SERVIDOR QR CODE (LÓGICA ESTÁVEL) =================
let currentQR = null
let isConnected = false

http.createServer(async (req, res) => {
    if (req.url === "/qr.png") {
        if (!currentQR) return res.end("Gerando... Atualize a pagina")
        const buf = await QRCode.toBuffer(currentQR)
        res.writeHead(200, { "Content-Type": "image/png" })
        return res.end(buf)
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    if (isConnected) return res.end("<body style='background:#0b141a;color:#25d366;text-align:center;padding-top:100px;font-family:sans-serif'><h1>✅ BOT CONECTADO COM SUCESSO!</h1><p style='color:#fff'>O bot está operando agora.</p></body>")
    if (!currentQR) return res.end("<h1>⏳ Carregando QR... Atualize em 5s</h1><script>setTimeout(()=>location.reload(),5000)</script>")
    
    const dataUrl = await QRCode.toDataURL(currentQR)
    res.end(`<h1>Escaneie o QR para conectar:</h1><img src="${dataUrl}"><script>setTimeout(()=>location.reload(),20000)</script>`)
}).listen(PORT, "0.0.0.0")

// ================= NÚCLEO DO BOT =================

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth"))
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: "silent" }),
        browser: Browsers.macOS("Safari"),
        printQRInTerminal: true,
        markOnlineOnConnect: true
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) currentQR = qr
        if (connection === "open") {
            isConnected = true; currentQR = null
            console.log(`🚀 ${BOT_NAME} ONLINE!`)
        }
        if (connection === "close") {
            isConnected = false
            const code = lastDisconnect?.error?.output?.statusCode
            if (code !== DisconnectReason.loggedOut) startBot()
        }
    })

    // --- Boas-Vindas Automáticas ---
    sock.ev.on("group-participants.update", async (anu) => {
        if (!db.groups[anu.id]?.boasVindas) return
        try {
            const meta = await sock.groupMetadata(anu.id)
            for (let x of anu.participants) {
                if (anu.action === "add") {
                    let welcome = `┏━━━━ ✨ *BEM-VINDO(A)* ✨ ━━━━┓\n\n👋 Olá @${x.split("@")[0]}!\n🏢 *Grupo:* ${meta.subject}\n👥 *Membros:* ${meta.participants.length}\n\n📜 *REGRAS:* \n${db.groups[anu.id].regras || "Não definidas ainda."}\n\n┗━━━━━━━━━━━━━━━━━━━━━━━┛`
                    await sock.sendMessage(anu.id, { text: welcome, mentions: [x] })
                }
            }
        } catch (e) { console.log(e) }
    })

    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const m = messages[0]
            if (!m.message) return
            const from = m.key.remoteJid
            const type = Object.keys(m.message)[0]
            const body = (type === 'conversation') ? m.message.conversation : (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text : (type === 'imageMessage') ? m.message.imageMessage.caption : (type === 'videoMessage') ? m.message.videoMessage.caption : ''

            const isGroup = from.endsWith("@g.us")
            const sender = isGroup ? m.key.participant : from
            const pushname = m.pushName || "Usuário"
            const isCmd = body.startsWith(PREFIX)
            const command = isCmd ? body.slice(PREFIX.length).trim().split(/ +/).shift().toLowerCase() : null
            const args = body.trim().split(/ +/).slice(1)
            const q = args.join(" ")

            // --- LÓGICA DE ADMIN (SOLUÇÃO DEFINITIVA) ---
            let isAdmin = false, isBotAdmin = false, botId
            if (isGroup) {
                const groupMetadata = await sock.groupMetadata(from)
                const participants = groupMetadata.participants
                const admins = participants.filter(p => p.admin !== null).map(p => p.id)
                
                // Normaliza o ID do Bot para evitar erros de sufixo (:40)
                botId = jidNormalizedUser(sock.user.id)
                
                isAdmin = admins.includes(sender) || sender === OWNER
                isBotAdmin = admins.includes(botId)
                
                // Auto-ativar proteções em grupos novos
                if (!db.groups[from]) {
                    db.groups[from] = { antiLink: true, antiPalavrao: true, boasVindas: true, avisos: {}, regras: "Sem regras." }
                    saveDB()
                }
            }
            if (!db.users[sender]) { db.users[sender] = { xp: 0 }; saveDB() }

            const reply = (txt) => sock.sendMessage(from, { text: txt }, { quoted: m })
            const getMention = () => m.message.extendedTextMessage?.contextInfo?.mentionedJid[0] || m.message.extendedTextMessage?.contextInfo?.participant || null

            // ================= MODERAÇÃO AUTOMÁTICA =================
            if (isGroup && !isAdmin && isBotAdmin) {
                if (db.groups[from].antiLink && LINK_REGEX.test(body)) {
                    await sock.sendMessage(from, { delete: m.key })
                    return addAviso(from, sender, "Link Proibido")
                }
                if (db.groups[from].antiPalavrao && BAD_WORDS.some(w => body.toLowerCase().includes(w))) {
                    await sock.sendMessage(from, { delete: m.key })
                    return addAviso(from, sender, "Linguagem Ofensiva")
                }
            }

            async function addAviso(jid, user, motivo) {
                if (!db.groups[jid].avisos[user]) db.groups[jid].avisos[user] = 0
                db.groups[jid].avisos[user]++
                saveDB()
                let count = db.groups[jid].avisos[user]
                if (count >= 3) {
                    await reply(`🚫 *BAN:* @${user.split("@")[0]} banido por excesso de avisos (3/3).`)
                    await sock.groupParticipantsUpdate(jid, [user], "remove")
                    db.groups[jid].avisos[user] = 0; saveDB()
                } else {
                    await reply(`⚠️ *SISTEMA:* @${user.split("@")[0]} avisado [${count}/3]\nMotivo: ${motivo}`)
                }
            }

            // XP
            db.users[sender].xp += 5; saveDB()

            if (!isCmd) return

            switch (command) {
                case 'menu':
                    reply(`╔══════════════════════╗\n  🤖 *${BOT_NAME.toUpperCase()}* 🤖\n╚══════════════════════╝\n\n🛡️ *MODERAÇÃO*\n!ban !promover !rebaixar\n!silenciar !falar !apagar\n!antilink !antipalavrao\n!boasvindas !setregras !regras\n\n🔍 *PESQUISA*\n!gpt !google !jw !play\n\n⚙️ *SISTEMA*\n!ping !id !say !dono`)
                    break

                case 'gpt':
                    if (!q) return reply("Diga o que deseja perguntar.")
                    reply("🤖 *Pensando...*")
                    try {
                        const res = await axios.get(`https://api.paxsenix.biz.id/ai/gpt4?text=${encodeURIComponent(q)}`)
                        reply(`✨ *IA:* ${res.data.message}`)
                    } catch { 
                        // Fallback API caso a primeira falhe
                        try {
                            const res2 = await axios.get(`https://aivybots.com/api/chat?prompt=${encodeURIComponent(q)}`)
                            reply(`✨ *IA:* ${res2.data.response}`)
                        } catch { reply("❌ Erro ao conectar com as APIs de IA.") }
                    }
                    break

                case 'ban':
                    if (!isAdmin) return reply("❌ Só Admins.")
                    if (!isBotAdmin) return reply("❌ Preciso ser Admin.")
                    let targetBan = getMention()
                    if (!targetBan) return reply("Marque alguém.")
                    await sock.groupParticipantsUpdate(from, [targetBan], "remove")
                    reply("🔨 Banido com sucesso.")
                    break

                case 'promover':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Erro de permissão.")
                    let targetP = getMention()
                    await sock.groupParticipantsUpdate(from, [targetP], "promote")
                    reply("⭐ Promovido.")
                    break

                case 'rebaixar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Erro de permissão.")
                    let targetD = getMention()
                    await sock.groupParticipantsUpdate(from, [targetD], "demote")
                    reply("⬇️ Rebaixado.")
                    break

                case 'apagar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Erro de permissão.")
                    const citada = m.message.extendedTextMessage?.contextInfo
                    if (!citada?.stanzaId) return reply("Responda à mensagem.")
                    await sock.sendMessage(from, { delete: citada })
                    break

                case 'setregras':
                    if (!isAdmin) return reply("Só Admins.")
                    db.groups[from].regras = q; saveDB(); reply("✅ Regras atualizadas.")
                    break

                case 'regras':
                    reply(`📜 *REGRAS DO GRUPO:* \n\n${db.groups[from]?.regras || "Não definidas."}`)
                    break

                case 'antilink':
                    if (!isAdmin) return reply("Só Admins.")
                    db.groups[from].antiLink = (q === 'on'); saveDB()
                    reply(`🔗 Anti-link: *${db.groups[from].antiLink ? "ON" : "OFF"}*`)
                    break

                case 'antipalavrao':
                    if (!isAdmin) return reply("Só Admins.")
                    db.groups[from].antiPalavrao = (q === 'on'); saveDB()
                    reply(`🤬 Anti-palavrão: *${db.groups[from].antiPalavrao ? "ON" : "OFF"}*`)
                    break

                case 'boasvindas':
                    if (!isAdmin) return reply("Só Admins.")
                    db.groups[from].boasVindas = (q === 'on'); saveDB()
                    reply(`👋 Boas-vindas: *${db.groups[from].boasVindas ? "ON" : "OFF"}*`)
                    break

                case 'google':
                    reply(`🔎 *Google:* Encontrei isso sobre ${q}:\n🔗 https://www.google.com/search?q=${encodeURIComponent(q)}`)
                    break

                case 'jw':
                    reply(`📖 *JW SEARCH:* Resultados para ${q}:\n🔗 https://www.jw.org/pt/pesquisar/?q=${encodeURIComponent(q)}`)
                    break

                case 'play':
                    if (!q) return reply("Nome da música?")
                    reply("⏳ Buscando no YouTube...")
                    const search = await ytSearch(q)
                    const v = search.videos[0]
                    if (!v) return reply("Nada encontrado.")
                    const vDesc = `🎵 *TÍTULO:* ${v.title}\n⏱️ *DURAÇÃO:* ${v.timestamp}\n👀 *VIEWS:* ${v.views.toLocaleString()}\n👤 *CANAL:* ${v.author.name}\n🔗 *LINK:* ${v.url}`
                    await sock.sendMessage(from, { image: { url: v.thumbnail }, caption: vDesc }, { quoted: m })
                    break

                case 'silenciar':
                    if (!isAdmin || !isBotAdmin) return reply("Sem permissão.")
                    await sock.groupSettingUpdate(from, 'announcement')
                    reply("🔇 Apenas admins falam.")
                    break

                case 'falar':
                    if (!isAdmin || !isBotAdmin) return reply("Sem permissão.")
                    await sock.groupSettingUpdate(from, 'not_announcement')
                    reply("🔊 Todos podem falar.")
                    break

                case 'ping': reply("🏓 Pong! Ativo."); break
                case 'id': reply(`🆔 *ID:* ${from}`); break
                case 'say': reply(q); break
                case 'dono': reply(`👑 *DONO:* @${OWNER.split("@")[0]}`, [OWNER]); break
            }
        } catch (e) { console.log(e) }
    })
}

startBot()
