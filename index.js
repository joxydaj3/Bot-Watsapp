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
const OWNER = "858285865@s.whatsapp.net" 
const PORT = process.env.PORT || 3000
const dbFile = path.join(__dirname, "database.json")

// ================= DATABASE COM AUTO-ON =================
let db = { groups: {}, users: {} }
if (fs.existsSync(dbFile)) {
    try { db = fs.readJsonSync(dbFile) } catch (e) { db = { groups: {}, users: {} } }
}
const saveDB = () => fs.writeJsonSync(dbFile, db, { spaces: 2 })

const BAD_WORDS = ["puta", "caralho", "fdp", "merda", "lixo", "verme", "corno", "idiota", "desgraça", "vagabundo"]
const LINK_REGEX = /((https?:\/\/)|(www\.))[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi

// ================= SERVIDOR QR CODE (LÓGICA FUNCIONAL) =================
let currentQR = null
let isConnected = false

const server = http.createServer(async (req, res) => {
    if (req.url === "/qr.png") {
        if (!currentQR) return res.end("Gerando... Atualize")
        const buf = await QRCode.toBuffer(currentQR)
        res.writeHead(200, { "Content-Type": "image/png" })
        return res.end(buf)
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    if (isConnected) return res.end("<body style='background:#0b141a;color:#25d366;text-align:center;padding-top:100px;font-family:sans-serif'><h1>✅ BOT CONECTADO E OPERANDO!</h1><p style='color:#fff'>Pode fechar esta aba.</p></body>")
    if (!currentQR) return res.end("<h1>Gerando QR... Aguarde 5s</h1><script>setTimeout(()=>location.reload(),5000)</script>")
    
    const dataUrl = await QRCode.toDataURL(currentQR)
    res.end(`
        <body style='background:#0b141a;color:#fff;text-align:center;padding-top:20px;font-family:sans-serif'>
            <h2 style='color:#25d366'>📱 CONEXÃO WHATSAPP BOT</h2>
            <img src="${dataUrl}" style='border:10px solid #fff;border-radius:12px;width:300px;box-shadow: 0 4px 15px rgba(0,0,0,0.5)'>
            <p>Escaneie para ativar o bot profissional.</p>
            <script>setTimeout(()=>location.reload(),20000)</script>
        </body>`)
})

server.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 Servidor Web Ativo na Porta ${PORT}`)
})

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
            console.log("🚀 BOT ONLINE!")
        }
        if (connection === "close") {
            isConnected = false
            const code = lastDisconnect?.error?.output?.statusCode
            if (code !== DisconnectReason.loggedOut) startBot()
        }
    })

    // --- Boas-Vindas Profissional ---
    sock.ev.on("group-participants.update", async (anu) => {
        if (!db.groups[anu.id]?.boasVindas) return
        try {
            const meta = await sock.groupMetadata(anu.id)
            for (let x of anu.participants) {
                if (anu.action === "add") {
                    let welcomeTxt = `┏━━━ ✨ *BEM-VINDO(A)* ✨ ━━━┓\n\n` +
                                   `👋 Olá @${x.split("@")[0]}!\n` +
                                   `🏢 *Grupo:* ${meta.subject}\n` +
                                   `👥 *Membros:* ${meta.participants.length}\n\n` +
                                   `📜 *REGRAS DO GRUPO:* \n${db.groups[anu.id].regras || "Seja educado e divirta-se!"}\n\n` +
                                   `┗━━━━━━━━━━━━━━━━━━━━┛`
                    await sock.sendMessage(anu.id, { text: welcomeTxt, mentions: [x] })
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

            // Configuração Automática do Grupo (Sempre Inicia Ativado)
            if (isGroup && !db.groups[from]) {
                db.groups[from] = { antiLink: true, antiPalavrao: true, boasVindas: true, avisos: {}, regras: "" }
                saveDB()
            }
            if (!db.users[sender]) { db.users[sender] = { xp: 0 }; saveDB() }

            // Lógica de Reconhecimento de Admin (Melhorada)
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
                    return addAviso(from, sender, "Divulgação de Link")
                }
                if (db.groups[from].antiPalavrao && BAD_WORDS.some(w => body.toLowerCase().includes(w))) {
                    await sock.sendMessage(from, { delete: m.key })
                    return addAviso(from, sender, "Linguagem Imprópria")
                }
            }

            async function addAviso(jid, user, motivo) {
                if (!db.groups[jid].avisos[user]) db.groups[jid].avisos[user] = 0
                db.groups[jid].avisos[user]++
                saveDB()
                let count = db.groups[jid].avisos[user]
                if (count >= 3) {
                    await reply(`🚫 *EXPULSÃO:* @${user.split("@")[0]} foi removido por atingir 3 avisos.`)
                    await sock.groupParticipantsUpdate(jid, [user], "remove")
                    db.groups[jid].avisos[user] = 0; saveDB()
                } else {
                    await reply(`⚠️ *AVISO:* @${user.split("@")[0]} [${count}/3]\n*Motivo:* ${motivo}`)
                }
            }

            // XP System
            db.users[sender].xp += 5; saveDB()

            if (!isCmd) return

            switch (command) {
                case 'menu':
                    const menu = `
╔══════════════════════╗
      🤖 *ASSISTENTE PRO* 🤖
╚══════════════════════╝

🛡️ *MODERAÇÃO (ADMINS)*
➤ !ban @user - Remover
➤ !promover @user - Dar Admin
➤ !rebaixar @user - Tirar Admin
➤ !apagar - Deletar (responder)
➤ !silenciar / !falar
➤ !antilink on/off
➤ !antipalavrao on/off
➤ !boasvindas on/off
➤ !setregras <texto>
➤ !limparavisos @user

🔍 *BUSCAS & INTELIGÊNCIA*
➤ !gpt <pergunta> - Chat IA
➤ !google <assunto> - Pesquisa
➤ !jw <assunto> - Busca JW
➤ !play <música> - YouTube

🎨 *MÍDIA & ÚTEIS*
➤ !s - Criar figurinha
➤ !perfil - Seus dados
➤ !sorteio - Aleatório
➤ !infogrupo - Detalhes
➤ !todos - Marcar todos
➤ !clima <cidade> - Tempo

⚙️ *SISTEMA*
➤ !ping / !id / !dono / !say
`
                    reply(menu)
                    break

                case 'gpt':
                    if (!q) return reply("Diga o que deseja perguntar.")
                    reply("🤖 *Processando resposta inteligente...*")
                    try {
                        const ai = await axios.get(`https://api.paxsenix.biz.id/ai/gpt4?text=${encodeURIComponent(q)}`)
                        reply(`✨ *RESPOSTA IA:*\n\n${ai.data.message}`)
                    } catch { reply("❌ Erro de conexão com a IA. Tente novamente.") }
                    break

                // --- ADMIN COMMANDS ---
                case 'ban':
                    if (!isAdmin) return reply("❌ Só administradores.")
                    if (!isBotAdmin) return reply("❌ Preciso ser administrador para banir.")
                    let targetBan = getMention()
                    if (!targetBan) return reply("Marque alguém.")
                    await sock.groupParticipantsUpdate(from, [targetBan], "remove")
                    reply("🔨 Banimento executado.")
                    break

                case 'promover':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Falha de permissão.")
                    let targetPro = getMention()
                    await sock.groupParticipantsUpdate(from, [targetPro], "promote")
                    reply("✅ Promovido com sucesso.")
                    break

                case 'rebaixar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Falha de permissão.")
                    let targetDem = getMention()
                    await sock.groupParticipantsUpdate(from, [targetDem], "demote")
                    reply("⬇️ Rebaixado para membro.")
                    break

                case 'silenciar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Falha de permissão.")
                    await sock.groupSettingUpdate(from, 'announcement')
                    reply("🔇 Grupo silenciado (apenas admins falam).")
                    break

                case 'falar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Falha de permissão.")
                    await sock.groupSettingUpdate(from, 'not_announcement')
                    reply("🔊 Grupo aberto para todos.")
                    break

                case 'apagar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Falha de permissão.")
                    const citada = m.message.extendedTextMessage?.contextInfo
                    if (!citada?.stanzaId) return reply("Responda à mensagem que deseja apagar.")
                    await sock.sendMessage(from, { delete: citada })
                    break

                case 'setregras':
                    if (!isAdmin) return reply("Só admins.")
                    db.groups[from].regras = q; saveDB()
                    reply("✅ Regras do grupo atualizadas.")
                    break

                case 'limparavisos':
                    if (!isAdmin) return reply("Só admins.")
                    let userL = getMention()
                    db.groups[from].avisos[userL] = 0; saveDB()
                    reply("✅ Avisos zerados.")
                    break

                // --- BUSCAS ---
                case 'google':
                    if (!q) return reply("O que deseja pesquisar?")
                    reply(`🔎 *Pesquisando no Google:* ${q}...`)
                    const googleRes = `📚 *RESULTADOS GOOGLE*\n\nEncontrei informações relevantes sobre "${q}".\n\nClique no link para ler o assunto completo:\n🔗 https://www.google.com/search?q=${encodeURIComponent(q)}`
                    reply(googleRes)
                    break

                case 'jw':
                    if (!q) return reply("O que quer buscar no JW?")
                    const jwUrl = `https://www.jw.org/pt/pesquisar/?q=${encodeURIComponent(q)}`
                    reply(`📖 *JW SEARCH:*\n\nResultados para: "${q}"\n\n🔗 Acesse aqui: ${jwUrl}`)
                    break

                case 'play':
                    if (!q) return reply("Qual música/vídeo?")
                    reply("⏳ Buscando no YouTube...")
                    const search = await ytSearch(q)
                    const v = search.videos[0]
                    if (!v) return reply("Nada encontrado.")
                    const vDesc = `🎵 *TÍTULO:* ${v.title}\n⏱️ *DURAÇÃO:* ${v.timestamp}\n👀 *VIEWS:* ${v.views.toLocaleString()}\n👤 *CANAL:* ${v.author.name}\n🔗 *LINK:* ${v.url}`
                    await sock.sendMessage(from, { image: { url: v.thumbnail }, caption: vDesc }, { quoted: m })
                    break

                // --- NOVOS COMANDOS ---
                case 'perfil':
                    reply(`👤 *SEU PERFIL*\n\n💠 *Nome:* ${pushname}\n💠 *XP Atividade:* ${db.users[sender].xp}\n💠 *Avisos:* ${db.groups[from]?.avisos[sender] || 0}/3`)
                    break

                case 'sorteio':
                    if (!isGroup) return
                    let sortudo = participants[Math.floor(Math.random() * participants.length)].id
                    reply(`🎉 O membro sorteado foi: @${sortudo.split("@")[0]}!`, [sortudo])
                    break

                case 'clima':
                    if (!q) return reply("Diga o nome da cidade.")
                    reply(`🌤️ *CLIMA PARA:* ${q}\nEnsolarado, 28°C (Exemplo). _Para dados reais conecte uma API de clima._`)
                    break

                case 'infogrupo':
                    reply(`🏢 *DADOS DO GRUPO*\n\n📌 *Nome:* ${groupMetadata.subject}\n👥 *Membros:* ${participants.length}\n👑 *Admins:* ${admins.length}\n🆔 *ID:* ${from}`)
                    break

                case 'todos':
                    if (!isAdmin) return reply("Só admins.")
                    let textT = `📢 *ATENÇÃO MEMBROS!* 📢\n\n` + participants.map(p => `• @${p.id.split("@")[0]}`).join("\n")
                    sock.sendMessage(from, { text: textT, mentions: participants.map(p => p.id) })
                    break

                case 's': case 'sticker':
                    if (type === 'imageMessage' || m.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                        const buffer = await downloadMediaMessage(m, 'buffer', {})
                        const st = new Sticker(buffer, { pack: "Bot Pack", author: pushname, type: StickerTypes.FULL })
                        await sock.sendMessage(from, { sticker: await st.toBuffer() }, { quoted: m })
                    }
                    break

                case 'id': reply(`🆔 *ID:* ${from}`); break
                case 'ping': reply("🏓 Pong! Bot ativo."); break
                case 'say': if (!q) return; reply(q); break
                case 'dono': reply(`👑 *DONO:* @${OWNER.split("@")[0]}`, [OWNER]); break
            }
        } catch (e) { console.log(e) }
    })
}

startBot()
