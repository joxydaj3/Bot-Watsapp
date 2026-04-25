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

// ================= CONFIGURAÇÕES BÁSICAS =================
const PREFIX = "!"
const OWNER = "258858285865@s.whatsapp.net" // Número do Dono
const BOT_NUMBER = "258858285865" // ID base do Bot
const dbFile = path.join(__dirname, "database.json")

// Banco de Dados
let db = { groups: {}, users: {} }
if (fs.existsSync(dbFile)) {
    try { db = fs.readJsonSync(dbFile) } catch { db = { groups: {}, users: {} } }
}
const saveDB = () => fs.writeJsonSync(dbFile, db, { spaces: 2 })

// Filtros
const BAD_WORDS = ["puta", "caralho", "fdp", "merda", "lixo", "verme", "corno", "idiota", "desgraça", "gay", "estúpido"]
const LINK_REGEX = /(https?:\/\/|www\.|\.(com|net|org|io|me|xyz|info|gov|online|site))/i

// ================= SERVIDOR PARA QR CODE (RAILWAY) =================
let currentQR = null
let isConnected = false

http.createServer(async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    if (isConnected) return res.end("<body style='background:#0b141a;color:#25d366;text-align:center;font-family:sans-serif'><h1>✅ BOT CONECTADO E ATIVO!</h1></body>")
    if (!currentQR) return res.end("<h1>Gerando QR... Aguarde...</h1>")
    const dataUrl = await QRCode.toDataURL(currentQR)
    res.end(`<body style='background:#0b141a;color:#fff;text-align:center;font-family:sans-serif'>
        <h2 style='color:#25d366'>📱 WHATSAPP BOT PROFISSIONAL</h2>
        <img src="${dataUrl}" style='border:10px solid #fff;border-radius:10px;width:300px'>
        <p>Acesse pelo WhatsApp em Aparelhos Conectados</p>
        <script>setTimeout(()=>location.reload(),15000)</script>
    </body>`)
}).listen(process.env.PORT || 3000)

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
            console.log("🚀 [CONECTADO] Bot pronto para operar!")
        }
        if (connection === "close") {
            isConnected = false
            const code = lastDisconnect?.error?.output?.statusCode
            if (code !== DisconnectReason.loggedOut) startBot()
        }
    })

    // --- Boas-Vindas ---
    sock.ev.on("group-participants.update", async (anu) => {
        if (!db.groups[anu.id]?.boasVindas) return
        try {
            const meta = await sock.groupMetadata(anu.id)
            for (let x of anu.participants) {
                if (anu.action === "add") {
                    let txt = `👋 *BEM-VINDO AO GRUPO!*\n\n` +
                              `👤 *Membro:* @${x.split("@")[0]}\n` +
                              `🏢 *Grupo:* ${meta.subject}\n` +
                              `📊 *Total:* ${meta.participants.length}\n\n` +
                              `📜 *REGRAS:* ${db.groups[anu.id].regras || "Não definidas."}\n\n` +
                              `🔥 Aproveite e divirta-se!`
                    await sock.sendMessage(anu.id, { text: txt, mentions: [x] })
                } else if (anu.action === "remove") {
                    await sock.sendMessage(anu.id, { text: `🏃 @${x.split("@")[0]} saiu do grupo.` })
                }
            }
        } catch (e) { console.log("Erro Boas-Vindas:", e) }
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

            // Setup DB
            if (isGroup && !db.groups[from]) {
                db.groups[from] = { antiLink: true, antiPalavrao: true, boasVindas: true, avisos: {}, liberadosLk: [], regras: "" }
                saveDB()
            }
            if (!db.users[sender]) { db.users[sender] = { xp: 0 }; saveDB() }

            // Lógica de Admin CORRIGIDA
            let groupMetadata, participants, admins, isAdmin, isBotAdmin, botId
            if (isGroup) {
                groupMetadata = await sock.groupMetadata(from)
                participants = groupMetadata.participants
                admins = participants.filter(p => p.admin !== null).map(p => p.id)
                botId = jidNormalizedUser(sock.user.id) // Normalização crucial
                isAdmin = admins.includes(sender) || sender === OWNER
                isBotAdmin = admins.includes(botId)
            }

            const reply = (txt) => sock.sendMessage(from, { text: txt }, { quoted: m })
            const getMention = () => m.message.extendedTextMessage?.contextInfo?.mentionedJid[0] || m.message.extendedTextMessage?.contextInfo?.participant || null

            // ================= MODERAÇÃO AUTOMÁTICA =================
            if (isGroup && !isAdmin && isBotAdmin) {
                const isLiberado = db.groups[from].liberadosLk.includes(sender)
                
                if (db.groups[from].antiLink && LINK_REGEX.test(body) && !isLiberado) {
                    await sock.sendMessage(from, { delete: m.key })
                    return addAviso(from, sender, "Envio de Link")
                }
                if (db.groups[from].antiPalavrao && BAD_WORDS.some(w => body.toLowerCase().includes(w))) {
                    await sock.sendMessage(from, { delete: m.key })
                    return addAviso(from, sender, "Uso de Palavras Proibidas")
                }
            }

            async function addAviso(jid, user, motivo) {
                if (!db.groups[jid].avisos[user]) db.groups[jid].avisos[user] = 0
                db.groups[jid].avisos[user]++
                saveDB()
                let count = db.groups[jid].avisos[user]
                if (count >= 3) {
                    await reply(`🚫 *EXPULSÃO:* @${user.split("@")[0]} banido por excesso de avisos (3/3).`)
                    await sock.groupParticipantsUpdate(jid, [user], "remove")
                    db.groups[jid].avisos[user] = 0; saveDB()
                } else {
                    await reply(`⚠️ *AVISO:* @${user.split("@")[0]}\n*Motivo:* ${motivo}\n*Avisos:* ${count}/3`)
                }
            }

            // XP
            db.users[sender].xp += 5; saveDB()

            // ================= COMANDOS =================
            if (!isCmd) return

            switch (command) {
                case 'menu':
                    const menu = `
╔════════════════════╗
      🌟 *ASSISTENTE PRO* 🌟
╚════════════════════╝

🛠️ *ESTATÍSTICAS:*
• Usuário: ${pushname}
• XP: ${db.users[sender].xp}

🛡️ *ADMINISTRAÇÃO:*
➤ !ban @user
➤ !promover @user
➤ !rebaixar @user
➤ !apagar (Responda)
➤ !silenciar / !falar
➤ !antilink on/off
➤ !liberarlk @user
➤ !limparavisos @user
➤ !boasvindas on/off
➤ !setregras <texto>

🤖 *INTELIGÊNCIA ARTIFICIAL:*
➤ !gpt <sua pergunta>

🔍 *PESQUISAS:*
➤ !google <assunto>
➤ !jw <assunto>
➤ !playstore <app>
➤ !play <música>

🎨 *OUTROS:*
➤ !s / !sticker
➤ !toimg
➤ !xp / !ranking
➤ !todos
➤ !infogrupo
➤ !id / !dono
`
                    reply(menu)
                    break

                case 'gpt':
                    if (!q) return reply("Diga o que deseja perguntar ao GPT.")
                    reply("🤖 *Processando resposta inteligente...*")
                    try {
                        // Usando API gratuita do Gemini via Proxy/API Pública
                        const aiRes = await axios.get(`https://api.paxsenix.biz.id/ai/gemini?text=${encodeURIComponent(q)}`)
                        reply(`✨ *RESPOSTA INTELIGENTE:*\n\n${aiRes.data.message}`)
                    } catch { reply("❌ Erro ao conectar com a IA.") }
                    break

                case 'ban':
                    if (!isAdmin) return reply("❌ Só admins.")
                    if (!isBotAdmin) return reply("❌ Preciso ser admin.")
                    let targetBan = getMention()
                    if (!targetBan) return reply("Marque quem deseja banir.")
                    await sock.groupParticipantsUpdate(from, [targetBan], "remove")
                    reply("🔨 Banido com sucesso.")
                    break

                case 'promover':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Erro de permissão.")
                    let targetPro = getMention()
                    await sock.groupParticipantsUpdate(from, [targetPro], "promote")
                    reply("✅ Promovido a Admin.")
                    break

                case 'rebaixar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Erro de permissão.")
                    let targetDem = getMention()
                    await sock.groupParticipantsUpdate(from, [targetDem], "demote")
                    reply("⬇️ Rebaixado para Membro.")
                    break

                case 'apagar':
                    if (!isAdmin) return reply("❌ Só admins.")
                    if (!m.message.extendedTextMessage?.contextInfo?.stanzaId) return reply("Responda à mensagem.")
                    await sock.sendMessage(from, { delete: m.message.extendedTextMessage.contextInfo })
                    break

                case 'liberarlk':
                    if (!isAdmin) return reply("❌ Só admins.")
                    let targetLib = getMention()
                    if (!targetLib) return reply("Marque o usuário.")
                    db.groups[from].liberadosLk.push(targetLib)
                    saveDB(); reply("✅ Usuário liberado para mandar links.")
                    break

                case 'google':
                    if (!q) return reply("Diga o assunto.")
                    reply(`🔎 *Google:* Pesquisando sobre ${q}...\n\n🔗 Link: https://www.google.com/search?q=${encodeURIComponent(q)}`)
                    break

                case 'jw':
                    if (!q) return reply("Diga o assunto.")
                    reply(`📖 *JW.ORG:* Buscando publicações sobre ${q}...\n\n🔗 Link: https://www.jw.org/pt/pesquisar/?q=${encodeURIComponent(q)}`)
                    break

                case 'playstore':
                    if (!q) return reply("Diga o app.")
                    reply(`🎮 *Play Store:* Localizando ${q}...\n\n🔗 Link: https://play.google.com/store/search?q=${encodeURIComponent(q)}&c=apps`)
                    break

                case 'play':
                    if (!q) return reply("Nome da música?")
                    reply("⏳ Buscando no YouTube...")
                    const search = await ytSearch(q)
                    const v = search.videos[0]
                    if (!v) return reply("Nada encontrado.")
                    const msgPlay = `🎵 *MÚSICA ENCONTRADA*\n\n` +
                                    `📌 *Título:* ${v.title}\n` +
                                    `⏱️ *Duração:* ${v.timestamp}\n` +
                                    `👤 *Canal:* ${v.author.name}\n` +
                                    `🔗 *Link:* ${v.url}`
                    await sock.sendMessage(from, { image: { url: v.thumbnail }, caption: msgPlay }, { quoted: m })
                    break

                case 's': case 'sticker':
                    if (type === 'imageMessage' || m.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                        const buffer = await downloadMediaMessage(m, 'buffer', {})
                        const st = new Sticker(buffer, { pack: "PRO BOT", author: pushname, type: StickerTypes.FULL })
                        await sock.sendMessage(from, { sticker: await st.toBuffer() }, { quoted: m })
                    } else reply("Mande uma imagem!")
                    break

                case 'toimg':
                    const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage
                    if (!quoted?.stickerMessage) return reply("Responda a um sticker.")
                    const strm = await downloadMediaMessage({ message: quoted }, 'buffer', {})
                    await sock.sendMessage(from, { image: strm, caption: "🖼️ Convertido!" }, { quoted: m })
                    break

                case 'xp':
                    reply(`✨ *SEU XP:* ${db.users[sender].xp}`)
                    break

                case 'infogrupo':
                    reply(`📋 *INFO GRUPO:*\n\n🏢 Nome: ${groupMetadata.subject}\n🆔 ID: ${from}\n👥 Membros: ${participants.length}\n👑 Admins: ${admins.length}`)
                    break

                case 'dono':
                    reply(`👑 *DONO DO BOT:* @${OWNER.split("@")[0]}`, [OWNER])
                    break

                case 'id':
                    reply(`🆔 *ID DO CHAT:* ${from}`)
                    break

                case 'todos':
                    if (!isAdmin) return reply("Só admins.")
                    let textT = `📢 *CHAMADA GERAL*\n\n` + participants.map(p => `@${p.id.split("@")[0]}`).join(" ")
                    sock.sendMessage(from, { text: textT, mentions: participants.map(p => p.id) })
                    break
            }
        } catch (err) { console.log(err) }
    })
}

startBot()
