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

// ================= CONFIGURAÇÕES INICIAIS =================
const PREFIX = "!"
const OWNER = "258864617807@s.whatsapp.net" 
const dbFile = path.join(__dirname, "database.json")

// Banco de Dados com persistência reforçada
let db = { groups: {}, users: {} }
function loadDB() {
    if (fs.existsSync(dbFile)) {
        try { db = fs.readJsonSync(dbFile) } catch { db = { groups: {}, users: {} } }
    }
}
const saveDB = () => fs.writeJsonSync(dbFile, db, { spaces: 2 })
loadDB()

// Filtros de Moderação
const BAD_WORDS = ["puta", "caralho", "fdp", "merda", "lixo", "verme", "corno", "idiota", "migo", "desgraça"]
const LINK_REGEX = /(https?:\/\/|www\.|\.(com|net|org|io|me|xyz|info|gov|online))/i

// ================= SERVIDOR WEB QR =================
let currentQR = null
let isConnected = false

http.createServer(async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    if (isConnected) return res.end("<body style='background:#000;color:#0f0;font-family:sans-serif;text-align:center'><h1>✅ BOT CONECTADO COM SUCESSO!</h1></body>")
    if (!currentQR) return res.end("<h1>Gerando QR... Aguarde 10 segundos e atualize a pagina.</h1>")
    const dataUrl = await QRCode.toDataURL(currentQR)
    res.end(`<body style='background:#111;color:#fff;text-align:center;font-family:sans-serif'>
        <h2 style='color:#25d366'>📱 ESCANEIE O WHATSAPP</h2>
        <img src="${dataUrl}" style='border:10px solid #fff;border-radius:10px;width:350px'>
        <p>A pagina atualiza sozinha a cada 15s.</p>
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
        printQRInTerminal: true,
        connectTimeoutMs: 60000
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
            if (code !== DisconnectReason.loggedOut) startBot()
        }
    })

    // --- Sistema de Boas-Vindas ---
    sock.ev.on("group-participants.update", async (anu) => {
        if (!db.groups[anu.id]?.boasVindas) return
        try {
            const meta = await sock.groupMetadata(anu.id)
            for (let x of anu.participants) {
                let txt = anu.action === "add" 
                    ? (db.groups[anu.id].bemVindoMsg || `🌟 *BEM-VINDO(A)* @user\n\nAo grupo: *${meta.subject}*\nLeia as regras para não ser banido! 👋`)
                    : `👋 *ADEUS* @user\nSaiu do grupo ou foi removido.`
                await sock.sendMessage(anu.id, { text: txt.replace("@user", `@${x.split("@")[0]}`), mentions: [x] })
            }
        } catch (e) { console.log("Erro boas-vindas:", e) }
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

            // Setup DB por Grupo e Usuário
            if (isGroup && !db.groups[from]) {
                db.groups[from] = { antiLink: false, antiPalavrao: false, boasVindas: false, avisos: {}, regras: "Use !setregras para definir.", bemVindoMsg: "" }
                saveDB()
            }
            if (!db.users[sender]) { db.users[sender] = { xp: 0, avisosGerais: 0 }; saveDB() }

            // LÓGICA DE ADMINS CORRIGIDA
            let groupMetadata, participants, admins, isAdmin, isBotAdmin
            if (isGroup) {
                groupMetadata = await sock.groupMetadata(from)
                participants = groupMetadata.participants
                admins = participants.filter(p => p.admin !== null).map(p => p.id)
                // Checagem robusta de admin
                isAdmin = admins.includes(sender) || sender === OWNER
                const botId = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id
                isBotAdmin = admins.includes(botId)
            }

            const reply = (txt) => sock.sendMessage(from, { text: txt }, { quoted: m })
            const getMention = () => m.message.extendedTextMessage?.contextInfo?.mentionedJid[0] || m.message.extendedTextMessage?.contextInfo?.participant || null

            // ================= MODERAÇÃO EM TEMPO REAL =================
            if (isGroup && !isAdmin && isBotAdmin) {
                // Anti-Link
                if (db.groups[from].antiLink && LINK_REGEX.test(body)) {
                    await sock.sendMessage(from, { delete: m.key })
                    return addAviso(from, sender, "Divulgação de Links")
                }
                // Anti-Palavrão
                if (db.groups[from].antiPalavrao && BAD_WORDS.some(w => body.toLowerCase().includes(w))) {
                    await sock.sendMessage(from, { delete: m.key })
                    return addAviso(from, sender, "Linguagem Imprópria")
                }
            }

            async function addAviso(jid, user, motivo) {
                if (!db.groups[jid].avisos[user]) db.groups[jid].avisos[user] = 0
                db.groups[jid].avisos[user]++
                saveDB()
                if (db.groups[jid].avisos[user] >= 3) {
                    await reply(`🚫 *EXPULSÃO:* @${user.split("@")[0]} atingiu o limite de 3 avisos.`)
                    await sock.groupParticipantsUpdate(jid, [user], "remove")
                    db.groups[jid].avisos[user] = 0; saveDB()
                } else {
                    await reply(`⚠️ *AVISO:* @${user.split("@")[0]}\nMotivo: ${motivo}\nAvisos: ${db.groups[jid].avisos[user]}/3`)
                }
            }

            // Ganho de XP por mensagem
            db.users[sender].xp += 5; saveDB()

            // ================= COMANDOS =================
            if (!isCmd) return

            switch (command) {
                case 'menu':
                    const menuText = `
╔════════════════════╗
      ✨ *ASSISTENTE PRO* ✨
╚════════════════════╝

👤 *USUÁRIO:* ${pushname}
⭐ *SEU XP:* ${db.users[sender].xp}
🛠️ *PREFIXO:* ${PREFIX}

🛡️ *MODERAÇÃO (ADMINS)*
➤ !ban @user - Remove do grupo
➤ !promover @user - Dá admin
➤ !rebaixar @user - Tira admin
➤ !apagar - Deleta mensagem
➤ !silenciar - Fecha o grupo
➤ !falar - Abre o grupo
➤ !antilink on/off
➤ !antipalavrao on/off
➤ !boasvindas on/off
➤ !setregras <texto>
➤ !limparavisos @user

🔍 *BUSCAS & WEB*
➤ !google <termo> - Pesquisa Chrome
➤ !playstore <app> - Busca apps
➤ !jw <termo> - Busca no JW.org
➤ !play <música> - Baixa YouTube

🎨 *MÍDIA & DIVERSÃO*
➤ !s ou !sticker - Foto para Figu
➤ !toimg - Figu para Foto
➤ !xp - Ver seu ranking
➤ !ranking - Top 10 ativos
➤ !sorteio - Escolhe um membro

📋 *GRUPO & INFO*
➤ !regras - Lista as regras
➤ !todos - Marca todos membros
➤ !infogrupo - Detalhes do chat
➤ !id - ID do chat atual
➤ !say <texto> - Bot repete

👑 *SUPORTE*
➤ !dono - Contato do Criador
`
                    reply(menuText)
                    break

                // --- COMANDOS DE ADMIN CORRIGIDOS ---
                case 'rebaixar':
                    if (!isAdmin) return reply("❌ Você não é admin.")
                    if (!isBotAdmin) return reply("❌ Preciso ser admin para rebaixar.")
                    let targetRe = getMention()
                    if (!targetRe) return reply("Marque quem deseja rebaixar.")
                    await sock.groupParticipantsUpdate(from, [targetRe], "demote")
                    reply("✅ Usuário rebaixado para Membro.")
                    break

                case 'antilink':
                    if (!isAdmin) return reply("❌ Apenas Admins.")
                    db.groups[from].antiLink = (q === 'on')
                    saveDB()
                    reply(`🔗 *ANTI-LINK:* ${db.groups[from].antiLink ? "✅ ATIVADO" : "❌ DESATIVADO"}`)
                    break

                case 'antipalavrao':
                    if (!isAdmin) return reply("❌ Apenas Admins.")
                    db.groups[from].antiPalavrao = (q === 'on')
                    saveDB()
                    reply(`🤬 *ANTI-PALAVRÃO:* ${db.groups[from].antiPalavrao ? "✅ ATIVADO" : "❌ DESATIVADO"}`)
                    break

                case 'boasvindas':
                    if (!isAdmin) return reply("❌ Apenas Admins.")
                    db.groups[from].boasVindas = (q === 'on')
                    saveDB()
                    reply(`👋 *BOAS-VINDAS:* ${db.groups[from].boasVindas ? "✅ ATIVADO" : "❌ DESATIVADO"}`)
                    break

                // --- COMANDOS DE BUSCA (CHROME / JW / PLAYSTORE) ---
                case 'google':
                    if (!q) return reply("O que deseja pesquisar?")
                    reply(`🔎 *PESQUISANDO NO GOOGLE:* ${q}...`)
                    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(q)}`
                    reply(`🌐 *RESULTADOS DO CHROME:* \n\nEncontrei informações sobre "${q}".\n\nClique para ver tudo:\n${searchUrl}`)
                    break

                case 'playstore':
                    if (!q) return reply("Qual app?")
                    const psUrl = `https://play.google.com/store/search?q=${encodeURIComponent(q)}&c=apps`
                    reply(`🎮 *PLAY STORE:* \n\nLink para baixar "${q}":\n${psUrl}`)
                    break

                case 'jw':
                    if (!q) return reply("O que deseja buscar no JW.org?")
                    const jwUrl = `https://www.jw.org/pt/pesquisar/?q=${encodeURIComponent(q)}`
                    reply(`📖 *JW.ORG SEARCH:* \n\nEncontrei publicações, vídeos e músicas sobre: "${q}"\n\nAcesse aqui:\n${jwUrl}`)
                    break

                // --- OUTROS COMANDOS ---
                case 'todos':
                    if (!isAdmin) return reply("Só Admins.")
                    const mems = participants.map(p => p.id)
                    let textTodos = `📢 *CHAMADA GERAL*\n\n`
                    textTodos += `🏢 *GRUPO:* ${groupMetadata.subject}\n`
                    textTodos += `👥 *MEMBROS:* ${participants.length}\n`
                    textTodos += `👑 *ADMINS:* ${admins.length}\n\n`
                    textTodos += mems.map(m => ` @${m.split("@")[0]}`).join("\n")
                    sock.sendMessage(from, { text: textTodos, mentions: mems })
                    break

                case 'play':
                    if (!q) return reply("Nome da música?")
                    reply("⏳ Buscando no YouTube...")
                    const search = await ytSearch(q)
                    const vid = search.videos[0]
                    if (!vid) return reply("❌ Não encontrei nada.")
                    const vidMsg = `🎵 *MÚSICA ENCONTRADA* 🎵\n\n` +
                                   `📝 *Título:* ${vid.title}\n` +
                                   `⏱️ *Duração:* ${vid.timestamp}\n` +
                                   `👁️ *Views:* ${vid.views.toLocaleString()}\n` +
                                   `👤 *Canal:* ${vid.author.name}\n` +
                                   `🔗 *Link:* ${vid.url}`
                    await sock.sendMessage(from, { image: { url: vid.thumbnail }, caption: vidMsg }, { quoted: m })
                    break

                case 'xp':
                    reply(`✨ *STATUS DE @${sender.split("@")[0]}*\n\n💠 XP Atual: ${db.users[sender].xp}\n🏆 Nível: ${Math.floor(db.users[sender].xp / 100)}`, [sender])
                    break

                case 'ranking':
                    const top = Object.entries(db.users).sort((a,b) => b[1].xp - a[1].xp).slice(0, 10)
                    let rankT = `🏆 *TOP 10 USUÁRIOS ATIVOS*\n\n`
                    top.forEach((v, i) => rankT += `${i+1}º - @${v[0].split("@")[0]} | ${v[1].xp} XP\n`)
                    reply(rankT, top.map(v => v[0]))
                    break

                case 's': case 'sticker':
                    if (type === 'imageMessage' || m.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                        const buffer = await downloadMediaMessage(m, 'buffer', {})
                        const st = new Sticker(buffer, { pack: "PRO BOT", author: pushname, type: StickerTypes.FULL })
                        await sock.sendMessage(from, { sticker: await st.toBuffer() }, { quoted: m })
                    } else reply("Mande uma imagem!")
                    break

                case 'id':
                    reply(`🆔 *ID DO CHAT:* \n${from}`)
                    break

                case 'say':
                    if (!q) return reply("O que devo dizer?")
                    reply(q)
                    break

                case 'silenciar':
                    if (!isAdmin || !isBotAdmin) return reply("Erro: Sem permissão.")
                    await sock.groupSettingUpdate(from, 'announcement')
                    reply("🔇 *GRUPO FECHADO:* Apenas administradores podem enviar mensagens agora.")
                    break

                case 'falar':
                    if (!isAdmin || !isBotAdmin) return reply("Erro: Sem permissão.")
                    await sock.groupSettingUpdate(from, 'not_announcement')
                    reply("🔊 *GRUPO ABERTO:* Todos os membros podem falar.")
                    break
            }
        } catch (e) { console.log("ERRO INTERNO:", e) }
    })
}

startBot()
