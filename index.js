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

// ================= PROTEÇÃO CONTRA CRASHES =================
process.on("unhandledRejection", (reason) => console.error("⚠️ Erro Global Rejection:", reason))
process.on("uncaughtException", (err) => console.error("⚠️ Erro Global Exception:", err))

// ================= DATABASE LOCAL =================
let db = { groups: {}, users: {}, avisos: {}, xp: {}, antiLink: {}, antiPalavrao: {}, boasVindas: {}, regras: {} }
if (fs.existsSync(dbFile)) {
    try { db = fs.readJsonSync(dbFile) } catch (e) { console.log("Erro ao ler DB, criando nova.") }
}
const saveDB = () => fs.writeJsonSync(dbFile, db, { spaces: 2 })

// Filtros de Moderação
const BAD_WORDS = ["puta", "caralho", "fdp", "merda", "lixo", "verme", "corno", "idiota", "desgraça", "estupido", "vaca"]
const LINK_REGEX = /((https?:\/\/)|(www\.))[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi

// ================= SERVIDOR WEB (LÓGICA ANTIGA DO QR) =================
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
    if (isConnected) return res.end("<h1>✅ Bot Conectado!</h1>")
    if (!currentQR) return res.end("<h1>⏳ Carregando QR... Atualize em 5s</h1><script>setTimeout(()=>location.reload(),5000)</script>")
    
    const dataUrl = await QRCode.toDataURL(currentQR)
    res.end(`<h1>Escaneie o QR:</h1><img src="${dataUrl}"><script>setTimeout(()=>location.reload(),20000)</script>`)
}).listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 Servidor QR rodando na porta ${PORT}`)
})

// ================= FUNÇÃO PRINCIPAL DO BOT =================
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
            isConnected = true
            currentQR = null
            console.log("✅ BOT CONECTADO COM SUCESSO!")
        }
        if (connection === "close") {
            isConnected = false
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log("❌ Conexão fechada. Reconectando:", shouldReconnect)
            if (shouldReconnect) startBot()
        }
    })

    // --- Boas-Vindas Avançadas ---
    sock.ev.on("group-participants.update", async (anu) => {
        if (!db.groups[anu.id]?.boasVindas) return
        try {
            const meta = await sock.groupMetadata(anu.id)
            for (let x of anu.participants) {
                if (anu.action === "add") {
                    let txt = `🌟 *BEM-VINDO(A)* @${x.split("@")[0]}!\n\n` +
                              `🏢 *Grupo:* ${meta.subject}\n` +
                              `👥 *Membros:* ${meta.participants.length}\n\n` +
                              `📜 *REGRAS:* ${db.groups[anu.id].regras || "Não definidas."}\n\n` +
                              `Divirta-se!`
                    await sock.sendMessage(anu.id, { text: txt, mentions: [x] })
                }
            }
        } catch (e) { console.log(e) }
    })

    // --- Processamento de Mensagens ---
    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const m = messages[0]
            if (!m.message) return
            const from = m.key.remoteJid
            const type = Object.keys(m.message)[0]
            
            const body = (type === 'conversation') ? m.message.conversation : 
                         (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text : 
                         (type === 'imageMessage') ? m.message.imageMessage.caption : 
                         (type === 'videoMessage') ? m.message.videoMessage.caption : ''

            const isGroup = from.endsWith("@g.us")
            const sender = isGroup ? m.key.participant : from
            const pushname = m.pushName || "Usuário"
            const isCmd = body.startsWith(PREFIX)
            const command = isCmd ? body.slice(PREFIX.length).trim().split(/ +/).shift().toLowerCase() : null
            const args = body.trim().split(/ +/).slice(1)
            const q = args.join(" ")

            // Setup Automático de Banco de Dados
            if (isGroup && !db.groups[from]) {
                db.groups[from] = { antiLink: true, antiPalavrao: true, boasVindas: true, avisos: {}, regras: "" }
                saveDB()
            }
            if (!db.users[sender]) { db.users[sender] = { xp: 0 }; saveDB() }

            // Lógica de Admin Corrigida
            let groupMetadata, participants, admins, isAdmin, isBotAdmin, botId
            if (isGroup) {
                groupMetadata = await sock.groupMetadata(from)
                participants = groupMetadata.participants
                admins = participants.filter(p => p.admin !== null).map(p => p.id)
                botId = jidNormalizedUser(sock.user.id)
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
                    return addAviso(from, sender, "Palavra Imprópria")
                }
            }

            async function addAviso(jid, user, motivo) {
                if (!db.groups[jid].avisos[user]) db.groups[jid].avisos[user] = 0
                db.groups[jid].avisos[user]++
                saveDB()
                let count = db.groups[jid].avisos[user]
                if (count >= 3) {
                    await reply(`🚫 *EXPULSÃO:* @${user.split("@")[0]} atingiu 3 avisos e foi removido.`)
                    await sock.groupParticipantsUpdate(jid, [user], "remove")
                    db.groups[jid].avisos[user] = 0; saveDB()
                } else {
                    await reply(`⚠️ @${user.split("@")[0]} recebeu um aviso (${count}/3).\nMotivo: ${motivo}`)
                }
            }

            // XP
            db.users[sender].xp += 5; saveDB()

            // ================= COMANDOS =================
            if (!isCmd) return

            switch (command) {
                case 'menu': case 'help':
                    const menu = `
╔════════════════════╗
      🛡️ *BOT WHATSAPP PRO* 🛡️
╚════════════════════╝

✨ *XP:* ${db.users[sender].xp}

➤ !ban @user
➤ !promover @user
➤ !rebaixar @user
➤ !apagar (Responda a msg)
➤ !gpt <pergunta>
➤ !play <música>
➤ !google <termo>
➤ !jw <termo>
➤ !s (Criar figurinha)
➤ !toimg (Figurinha p/ Foto)
➤ !todos (Marcar membros)
➤ !id / !ping / !dono
`
                    reply(menu)
                    break

                case 'gpt':
                    if (!q) return reply("Diga o que deseja perguntar ao GPT.")
                    reply("🤖 *Pensando...*")
                    try {
                        const res = await axios.get(`https://api.paxsenix.biz.id/ai/gpt4?text=${encodeURIComponent(q)}`)
                        reply(`✨ *RESPOSTA GPT:*\n\n${res.data.message}`)
                    } catch (e) { reply("❌ Erro ao conectar com a IA.") }
                    break

                case 'ban':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Erro: Preciso ser Admin e você também.")
                    let userBan = getMention()
                    if (!userBan) return reply("Marque alguém.")
                    await sock.groupParticipantsUpdate(from, [userBan], "remove")
                    reply("🔨 Banido com sucesso.")
                    break

                case 'promover':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Erro de permissão.")
                    let userPro = getMention()
                    await sock.groupParticipantsUpdate(from, [userPro], "promote")
                    reply("✅ Promovido a Admin.")
                    break

                case 'rebaixar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Erro de permissão.")
                    let userDem = getMention()
                    await sock.groupParticipantsUpdate(from, [userDem], "demote")
                    reply("⬇️ Rebaixado para membro comum.")
                    break

                case 'apagar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Erro de permissão.")
                    if (!m.message.extendedTextMessage?.contextInfo?.stanzaId) return reply("Responda à mensagem.")
                    await sock.sendMessage(from, { delete: m.message.extendedTextMessage.contextInfo })
                    break

                case 'google':
                    if (!q) return reply("O que quer pesquisar?")
                    reply(`🔎 *Google:* https://www.google.com/search?q=${encodeURIComponent(q)}`)
                    break

                case 'jw':
                    if (!q) return reply("O que quer buscar no JW?")
                    reply(`📖 *JW:* https://www.jw.org/pt/pesquisar/?q=${encodeURIComponent(q)}`)
                    break

                case 'play':
                    if (!q) return reply("Nome da música?")
                    reply("⏳ Buscando no YouTube...")
                    const results = await ytSearch(q)
                    const v = results.videos[0]
                    if (!v) return reply("Nada encontrado.")
                    const vTxt = `🎵 *MÚSICA ENCONTRADA*\n\n📌 *Título:* ${v.title}\n⏱️ *Duração:* ${v.timestamp}\n🔗 *Link:* ${v.url}`
                    await sock.sendMessage(from, { image: { url: v.thumbnail }, caption: vTxt }, { quoted: m })
                    break

                case 's': case 'sticker':
                    if (type === 'imageMessage' || m.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                        const buffer = await downloadMediaMessage(m, 'buffer', {})
                        const st = new Sticker(buffer, { pack: "Meu Bot", author: pushname, type: StickerTypes.FULL })
                        await sock.sendMessage(from, { sticker: await st.toBuffer() }, { quoted: m })
                    } else reply("Mande uma imagem!")
                    break

                case 'toimg':
                    const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage
                    if (!quoted?.stickerMessage) return reply("Responda a um sticker.")
                    const stream = await downloadMediaMessage({ message: quoted }, 'buffer', {})
                    await sock.sendMessage(from, { image: stream, caption: "🖼️ Convertido!" }, { quoted: m })
                    break

                case 'todos':
                    if (!isAdmin) return reply("Só admins.")
                    const mems = participants.map(p => p.id)
                    sock.sendMessage(from, { text: `📢 *Marcando Todos...*`, mentions: mems })
                    break

                case 'id': reply(`🆔 *ID:* ${from}`); break
                case 'ping': reply("🏓 Pong!"); break
                case 'dono': reply(`👑 *Dono:* @${OWNER.split("@")[0]}`, [OWNER]); break
                case 'say': if (!q) return; reply(q); break
            }
        } catch (err) { console.log("❌ Erro:", err) }
    })
}

startBot()
