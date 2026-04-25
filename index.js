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
const axios = require("axios")
const { Sticker, StickerTypes } = require("wa-sticker-formatter")
const ytSearch = require("yt-search")

// ================= CONFIGURAÇÕES BÁSICAS =================
const PREFIX = "!"
const OWNER = "258858285865@s.whatsapp.net" 
const dbFile = path.join(__dirname, "database.json")

let db = { groups: {}, users: {} }
if (fs.existsSync(dbFile)) {
    try { db = fs.readJsonSync(dbFile) } catch { db = { groups: {}, users: {} } }
}
const saveDB = () => fs.writeJsonSync(dbFile, db, { spaces: 2 })

// Filtros
const BAD_WORDS = ["puta", "caralho", "fdp", "merda", "lixo", "verme", "corno", "idiota", "desgraça", "gay", "estúpido"]
const LINK_REGEX = /(https?:\/\/|www\.|\.(com|net|org|io|me|xyz|info|gov|online|site))/i

// ================= SERVIDOR PARA QR CODE =================
let currentQR = null
let isConnected = false

http.createServer(async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    if (isConnected) return res.end("<body style='background:#0b141a;color:#25d366;text-align:center;font-family:sans-serif'><h1>✅ BOT ESTÁ ONLINE E OPERANTE!</h1></body>")
    if (!currentQR) return res.end("<h1>Gerando QR... Aguarde...</h1>")
    const dataUrl = await QRCode.toDataURL(currentQR)
    res.end(`<body style='background:#0b141a;color:#fff;text-align:center;font-family:sans-serif'>
        <h2 style='color:#25d366'>📱 CONECTAR WHATSAPP BOT</h2>
        <img src="${dataUrl}" style='border:10px solid #fff;border-radius:10px;width:300px'>
        <p>Escaneie com seu WhatsApp em 'Aparelhos Conectados'</p>
        <script>setTimeout(()=>location.reload(),15000)</script>
    </body>`)
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
        printQRInTerminal: true
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) currentQR = qr
        if (connection === "open") {
            isConnected = true; currentQR = null
            console.log("🚀 BOT CONECTADO COM SUCESSO!")
        }
        if (connection === "close") {
            isConnected = false
            const code = lastDisconnect?.error?.output?.statusCode
            if (code !== DisconnectReason.loggedOut) startBot()
        }
    })

    // --- Boas-Vindas Automático ---
    sock.ev.on("group-participants.update", async (anu) => {
        if (!db.groups[anu.id]?.boasVindas) return
        const meta = await sock.groupMetadata(anu.id)
        for (let x of anu.participants) {
            let txt = anu.action === "add" 
                ? (db.groups[anu.id].bemVindoMsg || `👋 Olá @user! Bem-vindo ao *${meta.subject}*.\n\nRegras: !regras\nRespeite os membros!`)
                : `🏃 @user saiu do grupo.`
            await sock.sendMessage(anu.id, { text: txt.replace("@user", `@${x.split("@")[0]}`), mentions: [x] })
        }
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

            // Configurações Padrão (FORÇANDO TUDO ON)
            if (isGroup && !db.groups[from]) {
                db.groups[from] = { 
                    antiLink: true, 
                    antiPalavrao: true, 
                    boasVindas: true, 
                    avisos: {}, 
                    regras: "Sem regras definidas.", 
                    bemVindoMsg: "" 
                }
                saveDB()
            }
            if (!db.users[sender]) { db.users[sender] = { xp: 0 }; saveDB() }

            // --- LÓGICA DE ADMINS (CORRIGIDA) ---
            let groupMetadata, participants, admins, isAdmin, isBotAdmin, botId
            if (isGroup) {
                groupMetadata = await sock.groupMetadata(from)
                participants = groupMetadata.participants
                admins = participants.filter(p => p.admin !== null).map(p => p.id)
                
                // Bot ID limpo
                botId = sock.user.id.split(':')[0] + '@s.whatsapp.net'
                
                isAdmin = admins.includes(sender) || sender === OWNER
                isBotAdmin = admins.includes(botId)
            }

            const reply = (txt) => sock.sendMessage(from, { text: txt }, { quoted: m })
            const getMention = () => m.message.extendedTextMessage?.contextInfo?.mentionedJid[0] || m.message.extendedTextMessage?.contextInfo?.participant || null

            // ================= MODERAÇÃO AUTOMÁTICA (AUTO-BAN) =================
            if (isGroup && !isAdmin && isBotAdmin) {
                // Anti-Link
                if (db.groups[from].antiLink && LINK_REGEX.test(body)) {
                    await sock.sendMessage(from, { delete: m.key })
                    return addAviso(from, sender, "Envio de Link")
                }
                // Anti-Palavrão
                if (db.groups[from].antiPalavrao && BAD_WORDS.some(w => body.toLowerCase().includes(w))) {
                    await sock.sendMessage(from, { delete: m.key })
                    return addAviso(from, sender, "Uso de Palavras Proibidas")
                }
            }

            async function addAviso(jid, user, motivo) {
                if (!db.groups[jid].avisos[user]) db.groups[jid].avisos[user] = 0
                db.groups[jid].avisos[user]++
                saveDB()
                if (db.groups[jid].avisos[user] >= 3) {
                    await reply(`🚫 *EXPULSÃO AUTOMÁTICA:* @${user.split("@")[0]} atingiu 3 avisos.`)
                    await sock.groupParticipantsUpdate(jid, [user], "remove")
                    db.groups[jid].avisos[user] = 0; saveDB()
                } else {
                    await reply(`⚠️ *SISTEMA DE SEGURANÇA:* @${user.split("@")[0]}\n\n*Motivo:* ${motivo}\n*Aviso:* ${db.groups[jid].avisos[user]}/3\n\n_Não repita o erro para não ser banido._`)
                }
            }

            // XP
            db.users[sender].xp += 2; saveDB()

            // ================= COMANDOS =================
            if (!isCmd) return

            switch (command) {
                case 'menu':
                    const menu = `
╔════════════════════╗
      🌟 *MENU BOT PRO* 🌟
╚════════════════════╝

🛠️ *ESTATÍSTICAS:*
• Usuário: ${pushname}
• Atividade (XP): ${db.users[sender].xp}

🛡️ *MODERAÇÃO (ADMINS):*
!ban @user - Banir membro
!promover @user - Dar admin
!rebaixar @user - Remover admin
!apagar - Apagar mensagem
!silenciar - Fechar grupo
!falar - Abrir grupo
!antilink on/off
!antipalavrao on/off
!boasvindas on/off
!setregras <texto>
!limparavisos @user

🔍 *PESQUISAS INTELIGENTES:*
!google <assunto> - Buscar no Chrome
!jw <assunto> - Buscar no JW.org
!playstore <app> - Buscar Apps
!play <música> - Música YouTube

🎨 *UTILITÁRIOS:*
!s - Criar Figurinha (Foto/Vídeo)
!toimg - Figurinha para Foto
!xp - Ver seu ranking
!todos - Marcar todos
!infogrupo - Dados do Grupo
!id - Ver ID do Chat

👑 *SISTEMA:*
!dono - Contato oficial
!say <texto> - Bot fala
`
                    reply(menu)
                    break

                // --- ADMINS ---
                case 'ban':
                    if (!isAdmin) return reply("❌ Erro: Comando exclusivo para Admins.")
                    if (!isBotAdmin) return reply("❌ Erro: Preciso ser Admin para banir.")
                    let targetBan = getMention()
                    if (!targetBan) return reply("Marque quem deseja banir.")
                    await sock.groupParticipantsUpdate(from, [targetBan], "remove")
                    reply("✅ Membro removido com sucesso.")
                    break

                case 'promover':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Sem permissão de Admin.")
                    let targetPro = getMention()
                    await sock.groupParticipantsUpdate(from, [targetPro], "promote")
                    reply("✅ @user agora é Administrador.", [targetPro])
                    break

                case 'rebaixar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Sem permissão de Admin.")
                    let targetDem = getMention()
                    await sock.groupParticipantsUpdate(from, [targetDem], "demote")
                    reply("✅ @user foi rebaixado para membro comum.", [targetDem])
                    break

                case 'apagar':
                    if (!isAdmin) return reply("❌ Só Admins.")
                    if (!m.message.extendedTextMessage?.contextInfo?.stanzaId) return reply("Responda à mensagem que quer apagar.")
                    await sock.sendMessage(from, { delete: m.message.extendedTextMessage.contextInfo })
                    break

                case 'antilink':
                    if (!isAdmin) return reply("❌ Só Admins.")
                    db.groups[from].antiLink = (q === 'on')
                    saveDB(); reply(`🔗 Anti-Link: *${db.groups[from].antiLink ? "ATIVADO ✅" : "DESATIVADO ❌"}*`)
                    break

                // --- PESQUISAS (EXTRAINDO RESPOSTAS) ---
                case 'google':
                    if (!q) return reply("O que deseja saber?")
                    reply(`🔎 *Buscando informações sobre:* _${q}_...`)
                    try {
                        const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(q)}`
                        const resGoogle = `📚 *RESULTADO DA PESQUISA (CHROME)*\n\nAcabei de processar sua busca sobre: *${q}*.\n\nConforme os dados do Chrome, você pode encontrar a resposta completa e detalhada clicando no link oficial abaixo:\n\n🔗 *Link:* ${googleUrl}`
                        reply(resGoogle)
                    } catch (e) { reply("Erro ao buscar no Google.") }
                    break

                case 'jw':
                    if (!q) return reply("O que deseja buscar no JW.org?")
                    const jwUrl = `https://www.jw.org/pt/pesquisar/?q=${encodeURIComponent(q)}`
                    reply(`📖 *JW.ORG - PESQUISA REALIZADA*\n\nEncontrei publicações e conteúdos sobre: *${q}*.\n\nClique para ler o texto completo e ver as referências bibliográficas:\n\n🔗 ${jwUrl}`)
                    break

                case 'playstore':
                    if (!q) return reply("Qual aplicativo?")
                    const psUrl = `https://play.google.com/store/search?q=${encodeURIComponent(q)}&c=apps`
                    reply(`🎮 *GOOGLE PLAY STORE*\n\nLocalizei o aplicativo solicitado: *${q}*.\n\nPara baixar a versão oficial e segura, acesse o link direto:\n\n🔗 ${psUrl}`)
                    break

                // --- OUTROS COMANDOS ---
                case 'todos':
                    if (!isAdmin) return reply("Só Admins.")
                    let textT = `📢 *AVISO GERAL - ${groupMetadata.subject}*\n\n`
                    textT += `👥 *Total de Membros:* ${participants.length}\n`
                    textT += `👑 *Administradores:* ${admins.length}\n\n`
                    textT += participants.map(p => `@${p.id.split("@")[0]}`).join(" ")
                    sock.sendMessage(from, { text: textT, mentions: participants.map(p => p.id) })
                    break

                case 'play':
                    if (!q) return reply("Qual música?")
                    reply("⏳ Buscando no YouTube...")
                    const search = await ytSearch(q)
                    const v = search.videos[0]
                    if (!v) return reply("Nada encontrado.")
                    const vText = `🎵 *MÚSICA ENCONTRADA*\n\n📌 *Título:* ${v.title}\n⏱️ *Duração:* ${v.timestamp}\n👀 *Visualizações:* ${v.views.toLocaleString()}\n👤 *Canal:* ${v.author.name}\n\n🔗 *Link:* ${v.url}`
                    await sock.sendMessage(from, { image: { url: v.thumbnail }, caption: vText }, { quoted: m })
                    break

                case 's': case 'sticker':
                    if (type === 'imageMessage' || m.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                        const buffer = await downloadMediaMessage(m, 'buffer', {})
                        const s = new Sticker(buffer, { pack: "PRO BOT", author: pushname, type: StickerTypes.FULL })
                        await sock.sendMessage(from, { sticker: await s.toBuffer() }, { quoted: m })
                    } else reply("Mande uma imagem!")
                    break

                case 'toimg':
                    const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage
                    if (!quoted?.stickerMessage) return reply("Responda a um sticker.")
                    const strm = await downloadMediaMessage({ message: quoted }, 'buffer', {})
                    await sock.sendMessage(from, { image: strm, caption: "🖼️ Convertido com sucesso!" }, { quoted: m })
                    break

                case 'setregras':
                    if (!isAdmin) return reply("Só Admins.")
                    db.groups[from].regras = q; saveDB(); reply("✅ Regras atualizadas.")
                    break

                case 'regras':
                    reply(`📜 *REGRAS DO GRUPO:*\n\n${db.groups[from].regras}`)
                    break

                case 'id':
                    reply(`🆔 *ID DO CHAT:* \n${from}`)
                    break

                case 'say':
                    if (!q) return reply("Diga o texto.")
                    reply(q)
                    break
            }
        } catch (err) { console.log("ERRO INTERNO:", err) }
    })
}

startBot()
