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

// ================= CONFIGURAÇÕES E BANCO DE DADOS =================
const PREFIX = "!"
const OWNER = "258864617807@s.whatsapp.net" // SEU NÚMERO
const dbFile = path.join(__dirname, "database.json")

let db = {
    groups: {}, // antiLink, antiPalavrao, boasVindas, regras, avisos, silenciar
    users: {}   // xp, avisos_pessoais
}

// Carregar Banco de Dados
if (fs.existsSync(dbFile)) {
    try { db = fs.readJsonSync(dbFile) } catch { console.log("Erro ao carregar DB, iniciando nova.") }
}

const saveDB = () => fs.writeJsonSync(dbFile, db, { spaces: 2 })

// Filtros
const BAD_WORDS = ["puta", "caralho", "fdp", "merda", "lixo", "verme"]
const LINK_REGEX = /(https?:\/\/|www\.|\.(com|net|org|io|me|xyz))/i

// ================= SERVIDOR WEB (RAILWAY) =================
let currentQR = null
let isConnected = false

http.createServer(async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    if (isConnected) return res.end("<h1>✅ Bot Conectado e Ativo!</h1>")
    if (!currentQR) return res.end("<h1>⏳ Gerando QR Code... Aguarde e atualize.</h1>")
    const dataUrl = await QRCode.toDataURL(currentQR)
    res.end(`<h2>Escaneie para conectar:</h2><img src="${dataUrl}" width="300"><script>setTimeout(()=>location.reload(),15000)</script>`)
}).listen(process.env.PORT || 3000)

// ================= LÓGICA PRINCIPAL =================

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
            console.log("🚀 BOT ONLINE!")
        }
        if (connection === "close") {
            isConnected = false
            const code = lastDisconnect?.error?.output?.statusCode
            if (code !== DisconnectReason.loggedOut) startBot()
        }
    })

    // --- Boas-Vindas ---
    sock.ev.on("group-participants.update", async (anu) => {
        const meta = await sock.groupMetadata(anu.id)
        if (!db.groups[anu.id]?.boasVindas) return
        
        for (let x of anu.participants) {
            let txt = ""
            if (anu.action === "add") {
                txt = db.groups[anu.id].bemVindoMsg || `Seja bem-vindo(a) @user ao grupo ${meta.subject}! 👋`
            } else if (anu.action === "remove") {
                txt = `Adeus @user, sentiremos sua falta (ou não). 🏃💨`
            }
            if (txt) {
                await sock.sendMessage(anu.id, { text: txt.replace("@user", `@${x.split("@")[0]}`), mentions: [x] })
            }
        }
    })

    // --- Mensagens ---
    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const m = messages[0]
            if (!m.message) return
            
            // Lógica para permitir que o dono teste, mas ignore outras mensagens próprias (evita loops)
            const fromMe = m.key.fromMe
            const from = m.key.remoteJid
            const type = Object.keys(m.message)[0]
            
            const body = (type === 'conversation') ? m.message.conversation : 
                         (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text : 
                         (type === 'imageMessage') ? m.message.imageMessage.caption : 
                         (type === 'videoMessage') ? m.message.videoMessage.caption : ''

            // Se for do bot e não for comando, ignora (evita loops)
            if (fromMe && !body.startsWith(PREFIX)) return

            const isGroup = from.endsWith("@g.us")
            const sender = isGroup ? m.key.participant : from
            const pushname = m.pushName || "Usuário"
            const isCmd = body.startsWith(PREFIX)
            const command = isCmd ? body.slice(PREFIX.length).trim().split(/ +/).shift().toLowerCase() : null
            const args = body.trim().split(/ +/).slice(1)
            const q = args.join(" ")

            // Setup DB para grupos novos
            if (isGroup && !db.groups[from]) {
                db.groups[from] = { antiLink: false, antiPalavrao: false, boasVindas: false, avisos: {} }
                saveDB()
            }

            // Metadados do Grupo
            let groupMetadata, participants, admins, isAdmin, isBotAdmin
            if (isGroup) {
                groupMetadata = await sock.groupMetadata(from)
                participants = groupMetadata.participants
                admins = participants.filter(p => p.admin !== null).map(p => p.id)
                isAdmin = admins.includes(sender) || sender === OWNER
                isBotAdmin = admins.includes(sock.user.id.split(":")[0] + "@s.whatsapp.net")
            }

            const reply = (txt) => sock.sendMessage(from, { text: txt }, { quoted: m })

            // ================= MODERAÇÃO AUTOMÁTICA =================

            if (isGroup && !isAdmin && isBotAdmin) {
                // Anti-Link
                if (db.groups[from].antiLink && LINK_REGEX.test(body)) {
                    await sock.sendMessage(from, { delete: m.key })
                    return addAviso(from, sender, "Envio de Link")
                }
                // Anti-Palavrão
                if (db.groups[from].antiPalavrao && BAD_WORDS.some(w => body.toLowerCase().includes(w))) {
                    await sock.sendMessage(from, { delete: m.key })
                    return addAviso(from, sender, "Linguagem Ofensiva")
                }
                // Modo Silêncio
                if (db.groups[from].silenciar) {
                    await sock.sendMessage(from, { delete: m.key })
                    return
                }
            }

            async function addAviso(jid, user, motivo) {
                if (!db.groups[jid].avisos[user]) db.groups[jid].avisos[user] = 0
                db.groups[jid].avisos[user]++
                saveDB()

                const count = db.groups[jid].avisos[user]
                if (count >= 3) {
                    await reply(`🚫 @${user.split("@")[0]} atingiu 3 avisos e será removido!`)
                    await sock.groupParticipantsUpdate(jid, [user], "remove")
                    db.groups[jid].avisos[user] = 0
                    saveDB()
                } else {
                    await reply(`⚠️ [@${user.split("@")[0]}] Você recebeu um aviso (${count}/3).\nMotivo: ${motivo}`)
                }
            }

            // XP System
            if (!db.users[sender]) db.users[sender] = { xp: 0 }
            db.users[sender].xp += Math.floor(Math.random() * 10) + 1
            if (isCmd) saveDB()

            // ================= COMANDOS =================
            if (!isCmd) return

            switch (command) {
                case 'ping':
                    reply(`🏓 *Pong!*\nLatência: ${Date.now() - m.messageTimestamp * 1000}ms`)
                    break

                case 'menu':
                case 'help':
                    const menu = `
✨ *HOLA, ${pushname.toUpperCase()}!* ✨

📝 *INFORMAÇÕES:*
• Prefixo: [ ${PREFIX} ]
• Seu XP: ${db.users[sender].xp}

🌟 *GERAIS:*
• !ping - Status do bot
• !xp - Seu nível atual
• !ranking - Top 10 ativos
• !meusavisos - Ver suas infrações

🛡️ *ADMIN:*
• !ban @user - Kickar
• !promover @user - Dar Admin
• !rebaixar @user - Tirar Admin
• !todos - Marcar membros
• !apagar - Deletar mensagem
• !setregras <texto>
• !regras - Ver regras
• !antilink on/off
• !antipalavrao on/off
• !boasvindas on/off
• !silenciar / !falar

🎨 *MÍDIA:*
• !s ou !sticker - Criar figurinha
• !toimg - Sticker para imagem
• !play <nome> - Buscar música
`
                    reply(menu)
                    break

                case 'xp':
                    reply(`✨ *Status de Atividade*\n\nUsuário: @${sender.split("@")[0]}\nPontos XP: ${db.users[sender].xp}`, [sender])
                    break

                case 'ranking':
                    let sort = Object.entries(db.users).sort((a,b) => b[1].xp - a[1].xp).slice(0, 10)
                    let txtRank = "🏆 *TOP 10 ATIVOS*\n\n"
                    sort.forEach((v, i) => {
                        txtRank += `${i+1}º - @${v[0].split("@")[0]} (${v[1].xp} XP)\n`
                    })
                    reply(txtRank, sort.map(v => v[0]))
                    break

                // --- COMANDOS ADMIN ---
                case 'ban':
                    if (!isAdmin) return reply("❌ Só admins.")
                    if (!isBotAdmin) return reply("❌ Preciso ser admin.")
                    let victim = m.message.extendedTextMessage?.contextInfo?.mentionedJid[0] || m.message.extendedTextMessage?.contextInfo?.participant
                    if (!victim) return reply("Marque alguém.")
                    await sock.groupParticipantsUpdate(from, [victim], "remove")
                    reply("🔨 Justificado e banido.")
                    break

                case 'antilink':
                    if (!isAdmin) return reply("❌ Erro: Só admins.")
                    db.groups[from].antiLink = q === "on"
                    saveDB()
                    reply(`🔗 Anti-Link: *${q === "on" ? "ATIVADO" : "DESATIVADO"}*`)
                    break

                case 'todos':
                    if (!isAdmin) return reply("❌ Só admins.")
                    let mems = participants.map(p => p.id)
                    let msgT = `📢 *CHAMADA GERAL*\n\n` + mems.map(m => `• @${m.split("@")[0]}`).join("\n")
                    sock.sendMessage(from, { text: msgT, mentions: mems })
                    break

                case 'sticker':
                case 's':
                    if (type === 'imageMessage' || type === 'videoMessage' || m.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                        reply("⏳ Processando figurinha...")
                        const media = await downloadMediaMessage(m, "buffer", {})
                        const sticker = new Sticker(media, {
                            pack: "Pack do Bot",
                            author: pushname,
                            type: StickerTypes.FULL,
                            quality: 70
                        })
                        await sock.sendMessage(from, { sticker: await sticker.toBuffer() }, { quoted: m })
                    } else {
                        reply("❌ Responda a uma imagem ou vídeo.")
                    }
                    break

                case 'play':
                    if (!q) return reply("Digite o nome da música.")
                    reply("🔎 Buscando no YouTube...")
                    const search = await ytSearch(q)
                    const vid = search.videos[0]
                    if (!vid) return reply("Nada encontrado.")
                    
                    const infoMsg = `
🎵 *RESULTADO ENCONTRADO* 🎵

📝 *Título:* ${vid.title}
👤 *Canal:* ${vid.author.name}
⏱️ *Duração:* ${vid.timestamp}
👀 *Views:* ${vid.views}

🔗 *Link:* ${vid.url}
`
                    await sock.sendMessage(from, { 
                        image: { url: vid.thumbnail }, 
                        caption: infoMsg 
                    }, { quoted: m })
                    break
                
                // Adicione outros comandos conforme necessário seguindo este padrão...
            }

        } catch (e) {
            console.log("ERRO:", e)
        }
    })
}

startBot()
