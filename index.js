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

// ================= CONFIGURAÇÕES =================
const PREFIX = "!"
const OWNER = "258864617807@s.whatsapp.net" 
const PORT = process.env.PORT || 3000
const dbFile = path.join(__dirname, "database.json")

// ================= DATABASE COM PERSISTÊNCIA =================
let db = { groups: {}, users: {}, chatGPT: {} }
if (fs.existsSync(dbFile)) {
    try { db = fs.readJsonSync(dbFile) } catch (e) { console.log("Erro DB") }
}
const saveDB = () => fs.writeJsonSync(dbFile, db, { spaces: 2 })

const BAD_WORDS = ["puta", "caralho", "fdp", "merda", "lixo", "verme", "corno", "idiota", "desgraça"]
const LINK_REGEX = /((https?:\/\/)|(www\.))[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi

// ================= LÓGICA DE QR CODE (MANTIDA COMO PEDIDO) =================
let currentQR = null
let isConnected = false

http.createServer(async (req, res) => {
    if (req.url === "/qr.png") {
        if (!currentQR) return res.end("QR nao gerado ou ja conectado")
        const buf = await QRCode.toBuffer(currentQR)
        res.writeHead(200, { "Content-Type": "image/png" })
        return res.end(buf)
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    if (isConnected) return res.end("<body style='background:#0b141a;color:#25d366;text-align:center;padding-top:50px;font-family:sans-serif'><h1>✅ BOT CONECTADO COM SUCESSO!</h1></body>")
    if (!currentQR) return res.end("<h1>⏳ Carregando QR... Atualize em 5s</h1><script>setTimeout(()=>location.reload(),5000)</script>")
    
    const dataUrl = await QRCode.toDataURL(currentQR)
    res.end(`<body style='background:#0b141a;color:#fff;text-align:center;padding-top:20px;font-family:sans-serif'><h1>Escaneie o QR:</h1><img src="${dataUrl}" style='border:10px solid #fff;border-radius:10px;width:300px'><script>setTimeout(()=>location.reload(),20000)</script></body>`)
}).listen(PORT, "0.0.0.0")

// ================= FUNÇÃO PRINCIPAL =================
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
            console.log("🚀 BOT ONLINE NO RAILWAY!")
        }
        if (connection === "close") {
            isConnected = false
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
            if (shouldReconnect) startBot()
        }
    })

    // --- Boas-Vindas Automático ---
    sock.ev.on("group-participants.update", async (anu) => {
        if (!db.groups[anu.id]?.boasVindas) return
        try {
            const meta = await sock.groupMetadata(anu.id)
            for (let x of anu.participants) {
                if (anu.action === "add") {
                    let txt = `🌟 *BEM-VINDO(A)* @${x.split("@")[0]}\n🏢 Grupo: *${meta.subject}*\n📊 Membros: ${meta.participants.length}\n\n📜 *REGRAS:* ${db.groups[anu.id].regras || "Não definidas."}`
                    await sock.sendMessage(anu.id, { text: txt, mentions: [x] })
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

            // Setup de Database (AUTO-ON)
            if (isGroup && !db.groups[from]) {
                db.groups[from] = { antiLink: true, antiPalavrao: true, boasVindas: true, avisos: {}, regras: "Sem regras." }
                saveDB()
            }
            if (!db.users[sender]) { db.users[sender] = { xp: 0 }; saveDB() }

            // --- LÓGICA DE ADMIN (RECONHECIMENTO TOTAL) ---
            let groupMetadata, participants, admins, isAdmin, isBotAdmin, botId
            if (isGroup) {
                groupMetadata = await sock.groupMetadata(from)
                participants = groupMetadata.participants
                admins = participants.filter(p => p.admin !== null).map(p => p.id)
                botId = jidNormalizedUser(sock.user.id) // O bot agora se reconhece 100%
                isAdmin = admins.includes(sender) || sender === OWNER
                isBotAdmin = admins.includes(botId)
            }

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
                    return addAviso(from, sender, "Palavrão")
                }
            }

            async function addAviso(jid, user, motivo) {
                if (!db.groups[jid].avisos[user]) db.groups[jid].avisos[user] = 0
                db.groups[jid].avisos[user]++
                saveDB()
                let count = db.groups[jid].avisos[user]
                if (count >= 3) {
                    await reply(`🚫 *EXPULSÃO:* @${user.split("@")[0]} atingiu 3 avisos.`)
                    await sock.groupParticipantsUpdate(jid, [user], "remove")
                    db.groups[jid].avisos[user] = 0; saveDB()
                } else {
                    await reply(`⚠️ @${user.split("@")[0]} aviso ${count}/3.\nMotivo: ${motivo}`)
                }
            }

            // XP
            db.users[sender].xp += 2; saveDB()

            // ================= COMANDOS =================
            if (!isCmd) return

            switch (command) {
                case 'menu':
                    reply(`╔════════════════════╗\n      🌟 *ASSISTENTE PRO* 🌟\n╚════════════════════╝\n\n🛡️ *MODERAÇÃO*\n!ban !promover !rebaixar\n!silenciar !falar !apagar\n!antilink !antipalavrao\n!boasvindas !setregras\n\n🔍 *BUSCAS*\n!google !jw !gpt !play\n\n🎨 *MÍDIA*\n!s (sticker) !fix\n\n⚙️ *SISTEMA*\n!ping !id !say !agendar`)
                    break

                case 'gpt':
                    if (!q) return reply("Diga algo.")
                    if (!db.chatGPT[sender]) db.chatGPT[sender] = []
                    reply("🤖 *Pensando...*")
                    try {
                        const res = await axios.get(`https://api.paxsenix.biz.id/ai/gpt4?text=${encodeURIComponent(q)}`)
                        const resposta = res.data.message
                        db.chatGPT[sender].push({ role: "user", content: q }, { role: "assistant", content: resposta })
                        if (db.chatGPT[sender].length > 10) db.chatGPT[sender].shift()
                        reply(`✨ *GPT:* ${resposta}`)
                    } catch { reply("❌ Falha na IA. Tente novamente.") }
                    break

                // --- ADMINS ---
                case 'ban':
                    if (!isAdmin) return reply("❌ Só Admins.")
                    if (!isBotAdmin) return reply("❌ Preciso ser Admin.")
                    let targetBan = getMention()
                    if (!targetBan) return reply("Marque alguém.")
                    await sock.groupParticipantsUpdate(from, [targetBan], "remove")
                    reply("🔨 Banido.")
                    break

                case 'promover':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Sem permissão.")
                    let targetPro = getMention()
                    await sock.groupParticipantsUpdate(from, [targetPro], "promote")
                    reply("⭐ Promovido.")
                    break

                case 'rebaixar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Sem permissão.")
                    let targetDem = getMention()
                    await sock.groupParticipantsUpdate(from, [targetDem], "demote")
                    reply("⬇️ Rebaixado.")
                    break

                case 'silenciar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Sem permissão.")
                    await sock.groupSettingUpdate(from, 'announcement')
                    reply("🔇 Grupo Fechado.")
                    break

                case 'falar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Sem permissão.")
                    await sock.groupSettingUpdate(from, 'not_announcement')
                    reply("🔊 Grupo Aberto.")
                    break

                case 'apagar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Sem permissão.")
                    const citada = m.message.extendedTextMessage?.contextInfo
                    if (!citada?.stanzaId) return reply("Responda à mensagem.")
                    await sock.sendMessage(from, { delete: citada })
                    break

                case 'fix':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Sem permissão.")
                    const fixMsg = m.message.extendedTextMessage?.contextInfo
                    if (!fixMsg?.stanzaId) return reply("Responda à mensagem para fixar.")
                    await sock.sendMessage(from, { pin: fixMsg })
                    reply("📌 Mensagem fixada.")
                    break

                case 'setregras':
                    if (!isAdmin) return reply("Só Admins.")
                    db.groups[from].regras = q; saveDB()
                    reply("✅ Regras atualizadas.")
                    break

                case 'google':
                    reply(`🔎 *Google:* https://www.google.com/search?q=${encodeURIComponent(q)}`)
                    break

                case 'jw':
                    reply(`📖 *JW:* https://www.jw.org/pt/pesquisar/?q=${encodeURIComponent(q)}`)
                    break

                case 'play':
                    if (!q) return reply("Qual música?")
                    const search = await ytSearch(q)
                    const v = search.videos[0]
                    if (!v) return reply("Nada encontrado.")
                    reply(`🎵 *${v.title}*\n⏱️ ${v.timestamp}\n🔗 ${v.url}`)
                    break

                case 'agendar':
                    if (!isAdmin) return reply("Só Admins.")
                    const [tempo, ...msgAgendada] = q.split(" ")
                    const delay = parseInt(tempo) * 60000
                    reply(`📅 Agendado para daqui a ${tempo} minutos.`)
                    setTimeout(() => {
                        sock.sendMessage(from, { text: `📢 *AGENDADO:*\n\n${msgAgendada.join(" ")}` })
                    }, delay)
                    break

                case 'say':
                    if (!q) return;
                    reply(q)
                    break

                case 'ping': reply("🏓 Pong!"); break
            }
        } catch (e) { console.log(e) }
    })
}

startBot()
