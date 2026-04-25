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
const OWNER = "258864617807@s.whatsapp.net" // Seu número
const dbFile = path.join(__dirname, "database.json")

// Banco de Dados Local
let db = { groups: {}, users: {} }
if (fs.existsSync(dbFile)) {
    try { db = fs.readJsonSync(dbFile) } catch { db = { groups: {}, users: {} } }
}
const saveDB = () => fs.writeJsonSync(dbFile, db, { spaces: 2 })

// Filtros de Moderação
const BAD_WORDS = ["puta", "caralho", "fdp", "merda", "lixo", "verme", "corno", "idiota", "desgraça", "estupido", "vaca"]
const LINK_REGEX = /((https?:\/\/)|(www\.))[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi

// ================= SERVIDOR WEB (RAILWAY) =================
let currentQR = null
let isConnected = false

const server = http.createServer(async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    if (isConnected) return res.end("<body style='background:#0b141a;color:#25d366;text-align:center;font-family:sans-serif;padding-top:50px'><h1>✅ BOT ONLINE!</h1><p style='color:#fff'>O bot já está conectado ao WhatsApp.</p></body>")
    if (!currentQR) return res.end("<h1>⏳ Gerando QR... Aguarde 10s e atualize.</h1>")
    const dataUrl = await QRCode.toDataURL(currentQR)
    res.end(`
        <body style='background:#0b141a;color:#fff;text-align:center;font-family:sans-serif;padding-top:30px'>
            <h1 style='color:#25d366'>📱 CONECTAR BOT</h1>
            <p>Escaneie o QR Code abaixo com seu WhatsApp:</p>
            <img src="${dataUrl}" style='border:10px solid #fff;border-radius:15px;width:300px;box-shadow:0 0 20px rgba(0,0,0,0.5)'>
            <p style='color:#888'>A página atualiza sozinha a cada 20s.</p>
            <script>setTimeout(()=>location.reload(),20000)</script>
        </body>
    `)
}).listen(process.env.PORT || 3000)

// ================= NÚCLEO DO BOT =================

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth"))
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: "silent" }),
        browser: Browsers.macOS("Safari"),
        printQRInTerminal: false,
        markOnlineOnConnect: true
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) currentQR = qr
        if (connection === "open") {
            isConnected = true; currentQR = null
            console.log("🚀 [SISTEMA] Bot conectado e pronto para uso!")
        }
        if (connection === "close") {
            isConnected = false
            const code = lastDisconnect?.error?.output?.statusCode
            if (code !== DisconnectReason.loggedOut) {
                console.log("🔄 Tentando reconectar...")
                startBot()
            }
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
                              `👥 *Membros:* ${meta.participants.length}\n` +
                              `🔗 *Link:* chat.whatsapp.com/${await sock.groupInviteCode(anu.id)}\n\n` +
                              `📜 *REGRAS:* ${db.groups[anu.id].regras || "Consulte os admins."}\n\n` +
                              `Divirta-se e respeite os demais!`
                    await sock.sendMessage(anu.id, { text: txt, mentions: [x] })
                }
            }
        } catch (e) { console.log("Erro no Welcome:", e) }
    })

    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const m = messages[0]
            if (!m.message) return
            const from = m.key.remoteJid
            const type = Object.keys(m.message)[0]
            
            // Extração de Texto Inteligente
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

            // Setup de Database (Forçar ON)
            if (isGroup && !db.groups[from]) {
                db.groups[from] = { antiLink: true, antiPalavrao: true, boasVindas: true, avisos: {}, regras: "Sem regras definidas." }
                saveDB()
            }
            if (!db.users[sender]) { db.users[sender] = { xp: 0 }; saveDB() }

            // --- LÓGICA DE ADMINS CORRIGIDA ---
            let groupMetadata, participants, admins, isAdmin, isBotAdmin, botId
            if (isGroup) {
                groupMetadata = await sock.groupMetadata(from)
                participants = groupMetadata.participants
                admins = participants.filter(p => p.admin !== null).map(p => p.id)
                botId = jidNormalizedUser(sock.user.id) // Normaliza para comparar sem erro
                isAdmin = admins.includes(sender) || sender === OWNER
                isBotAdmin = admins.includes(botId)
            }

            const reply = (txt) => sock.sendMessage(from, { text: txt }, { quoted: m })
            const getMention = () => m.message.extendedTextMessage?.contextInfo?.mentionedJid[0] || m.message.extendedTextMessage?.contextInfo?.participant || null

            // ================= MODERAÇÃO AUTOMÁTICA =================
            if (isGroup && !isAdmin && isBotAdmin) {
                // Anti-Link
                if (db.groups[from].antiLink && LINK_REGEX.test(body)) {
                    await sock.sendMessage(from, { delete: m.key })
                    return addAviso(from, sender, "Envio de link proibido")
                }
                // Anti-Palavrão
                if (db.groups[from].antiPalavrao && BAD_WORDS.some(w => body.toLowerCase().includes(w))) {
                    await sock.sendMessage(from, { delete: m.key })
                    return addAviso(from, sender, "Uso de linguagem imprópria")
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
                    await reply(`⚠️ *MODERAÇÃO:* @${user.split("@")[0]}\n\n*Aviso:* ${count}/3\n*Motivo:* ${motivo}\n\nNão repita ou será banido.`)
                }
            }

            // Sistema de XP
            db.users[sender].xp += 5; saveDB()

            // ================= COMANDOS =================
            if (!isCmd) return

            switch (command) {
                case 'menu': case 'help':
                    const menu = `
╔════════════════════╗
      🛡️ *BOT WHATSAPP PRO* 🛡️
╚════════════════════╝

✨ *Estatísticas:*
• Usuário: ${pushname}
• Atividade (XP): ${db.users[sender].xp}

🛡️ *Administração:*
➤ !ban @user
➤ !promover @user
➤ !rebaixar @user
➤ !apagar (Responda msg)
➤ !silenciar / !falar
➤ !antilink on/off
➤ !antipalavrao on/off
➤ !setregras <texto>

🤖 *Inteligência Artificial:*
➤ !gpt <sua pergunta>

🔎 *Pesquisa & Música:*
➤ !play <nome da música>
➤ !google <assunto>
➤ !jw <assunto>
➤ !playstore <app>

🎨 *Utilidades:*
➤ !s ou !sticker (mídia)
➤ !toimg (sticker)
➤ !xp / !ranking
➤ !todos (marcar membros)
➤ !infogrupo / !id

⚙️ *Sistema:*
➤ !ping / !dono / !say
`
                    reply(menu)
                    break

                // --- COMANDO IA GPT ---
                case 'gpt':
                    if (!q) return reply("Diga o que deseja perguntar ao GPT.")
                    reply("🤖 *PENSANDO...*")
                    try {
                        // Usando API Gemini/GPT estável
                        const res = await axios.get(`https://api.paxsenix.biz.id/ai/gpt4?text=${encodeURIComponent(q)}`)
                        reply(`✨ *RESPOSTA GPT:*\n\n${res.data.message}`)
                    } catch (e) {
                        reply("❌ Ocorreu um erro ao conectar com o servidor de IA. Tente novamente mais tarde.")
                    }
                    break

                // --- MODERAÇÃO ---
                case 'ban':
                    if (!isAdmin) return reply("❌ Você não é administrador.")
                    if (!isBotAdmin) return reply("❌ Eu não sou administrador neste grupo.")
                    let userBan = getMention()
                    if (!userBan) return reply("Marque quem deseja banir.")
                    await sock.groupParticipantsUpdate(from, [userBan], "remove")
                    reply("🔨 Banido com sucesso.")
                    break

                case 'promover':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Erro de permissão.")
                    let userPro = getMention()
                    await sock.groupParticipantsUpdate(from, [userPro], "promote")
                    reply("⭐ @user agora é administrador.", [userPro])
                    break

                case 'rebaixar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Erro de permissão.")
                    let userDem = getMention()
                    await sock.groupParticipantsUpdate(from, [userDem], "demote")
                    reply("⬇️ @user foi rebaixado.", [userDem])
                    break

                case 'apagar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Erro de permissão.")
                    if (!m.message.extendedTextMessage?.contextInfo?.stanzaId) return reply("Responda à mensagem.")
                    await sock.sendMessage(from, { delete: m.message.extendedTextMessage.contextInfo })
                    break

                // --- PESQUISAS ---
                case 'google':
                    if (!q) return reply("Qual sua dúvida?")
                    reply(`🔎 *Google:* Pesquisando sobre ${q}...\n\n🔗 Link oficial: https://www.google.com/search?q=${encodeURIComponent(q)}`)
                    break

                case 'jw':
                    if (!q) return reply("Qual o assunto?")
                    reply(`📖 *JW.ORG:* Buscando publicações sobre ${q}...\n\n🔗 Pesquisa: https://www.jw.org/pt/pesquisar/?q=${encodeURIComponent(q)}`)
                    break

                case 'play':
                    if (!q) return reply("Qual música deseja buscar?")
                    reply("⏳ Buscando no YouTube...")
                    const results = await ytSearch(q)
                    const v = results.videos[0]
                    if (!v) return reply("Nada encontrado.")
                    const vTxt = `🎵 *MÚSICA ENCONTRADA*\n\n📌 *Título:* ${v.title}\n⏱️ *Duração:* ${v.timestamp}\n👀 *Views:* ${v.views}\n👤 *Canal:* ${v.author.name}\n\n🔗 *Link:* ${v.url}`
                    await sock.sendMessage(from, { image: { url: v.thumbnail }, caption: vTxt }, { quoted: m })
                    break

                // --- UTILITÁRIOS ---
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
                    if (!isAdmin) return reply("Apenas Admins.")
                    const mems = participants.map(p => p.id)
                    let text = `📢 *MARCANDO TODOS:*\n\n` + mems.map(m => `@${m.split("@")[0]}`).join(" ")
                    sock.sendMessage(from, { text, mentions: mems })
                    break

                case 'id': reply(`🆔 *ID DO CHAT:* ${from}`); break
                case 'ping': reply("🏓 *Pong!* Estou ativo e rápido."); break
                case 'dono': reply(`👑 *DONO:* @${OWNER.split("@")[0]}`, [OWNER]); break
                case 'say': if (!q) return; reply(q); break
            }
        } catch (e) { console.log("ERRO INTERNO:", e) }
    })
}

startBot()
