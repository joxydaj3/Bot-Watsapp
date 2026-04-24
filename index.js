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

// ================= CONFIGURAÇÕES BÁSICAS =================
const PREFIX = "!"
const OWNER = "258864617807@s.whatsapp.net" // Verifique se seu número está correto aqui
const PORT = process.env.PORT || 3000

// ================= PROTEÇÃO CONTRA CRASHES =================
process.on("unhandledRejection", (reason) => console.error("⚠️ Erro Global Rejection:", reason))
process.on("uncaughtException", (err) => console.error("⚠️ Erro Global Exception:", err))

// ================= DATABASE LOCAL =================
const dbFile = path.join(__dirname, "database.json")
let db = {
    avisos: {}, xp: {}, flood: {}, modoSilencio: {},
    antiLink: {}, antiPalavrao: {}, boasVindas: {}, regras: {}, bemVindo: {}
}
if (fs.existsSync(dbFile)) {
    try { db = { ...db, ...fs.readJsonSync(dbFile) } } catch (e) { console.log("Erro ao ler DB")}
}
const saveDB = () => fs.writeJsonSync(dbFile, db, { spaces: 2 })

// ================= SERVIDOR WEB PARA QR CODE =================
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
}).listen(PORT, "0.0.0.0")

// ================= FUNÇÃO PRINCIPAL DO BOT =================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth"))
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: "silent" }),
        browser: Browsers.macOS("Safari"),
        printQRInTerminal: true // Também imprime no terminal do Railway
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
            console.log("❌ Conexão fechada. Tentando reconectar:", shouldReconnect)
            if (shouldReconnect) startBot()
        }
    })

    // ================= PROCESSAMENTO DE MENSAGENS =================
    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const msg = messages[0]
            if (!msg.message || msg.key.fromMe) return

            const from = msg.key.remoteJid
            const type = Object.keys(msg.message)[0]
            
            // Pega o texto de qualquer tipo de mensagem (conversa, legenda de imagem, etc)
            const body = (type === 'conversation') ? msg.message.conversation : 
                         (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text : 
                         (type === 'imageMessage') ? msg.message.imageMessage.caption : 
                         (type === 'videoMessage') ? msg.message.videoMessage.caption : ''

            if (!body) return
            
            console.log(`📩 Mensagem recebida de ${from}: ${body.slice(0, 30)}`)

            const isGroup = from.endsWith("@g.us")
            const sender = isGroup ? msg.key.participant : from
            const isCmd = body.startsWith(PREFIX)
            const command = isCmd ? body.slice(PREFIX.length).trim().split(/ +/).shift().toLowerCase() : null
            const args = body.trim().split(/ +/).slice(1)

            // Funções de resposta
            const reply = async (text) => {
                await sock.sendMessage(from, { text: text }, { quoted: msg })
            }

            // XP e Database simples
            db.xp[sender] = (db.xp[sender] || 0) + 1
            if (isGroup) saveDB()

            // Lógica de Admins
            let isAdmin = false
            let isBotAdmin = false
            if (isGroup) {
                const metadata = await sock.groupMetadata(from)
                const participants = metadata.participants
                isAdmin = participants.find(p => p.id === sender)?.admin !== null
                const botId = sock.user.id.split(":")[0] + "@s.whatsapp.net"
                isBotAdmin = participants.find(p => p.id === botId)?.admin !== null
            }

            // ================= COMANDOS =================
            if (!isCmd) return

            switch (command) {
                case 'ping':
                    await reply("🏓 Pong! O bot está funcionando.")
                    break

                case 'menu':
                case 'help':
                    await reply(`🤖 *BOT ATIVO*\n\nComandos disponíveis:\n!ping\n!sticker\n!menu\n!regras\n!total\n\n_Use ${PREFIX} antes de cada comando._`)
                    break

                case 'sticker':
                case 's':
                    await reply("⏳ Criando seu sticker...")
                    const buffer = await downloadMediaMessage(msg, "buffer", {})
                    const sticker = new Sticker(buffer, {
                        pack: "Meu Bot",
                        author: "Bot",
                        type: StickerTypes.FULL,
                        quality: 70
                    })
                    await sock.sendMessage(from, { sticker: await sticker.toBuffer() }, { quoted: msg })
                    break

                case 'regras':
                    const r = db.regras[from] || "Sem regras definidas."
                    await reply(`📜 *REGRAS DO GRUPO:*\n\n${r}`)
                    break

                case 'marcartodos':
                case 'todos':
                    if (!isGroup) return reply("Apenas em grupos.")
                    if (!isAdmin) return reply("Apenas admins.")
                    const metadata = await sock.groupMetadata(from)
                    const users = metadata.participants.map(u => u.id)
                    let texto = `📢 *AVISO GERAL*\n\n`
                    for (let u of users) texto += `@${u.split("@")[0]}\n`
                    await sock.sendMessage(from, { text: texto, mentions: users })
                    break

                default:
                    // Se quiser que o bot avise que o comando não existe, descomente a linha abaixo:
                    // await reply("❌ Comando não reconhecido. Digite !menu")
                    break
            }

        } catch (err) {
            console.log("❌ Erro ao processar mensagem:", err)
        }
    })
}

startBot()
