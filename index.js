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
const OWNER = "258864617807@s.whatsapp.net"
const PORT = process.env.PORT || 3000

// ================= DATABASE =================
const dbFile = path.join(__dirname, "database.json")
let db = {
    avisos: {}, xp: {}, flood: {}, modoSilencio: {},
    antiLink: {}, antiPalavrao: {}, boasVindas: {},
    regras: {}, bemVindo: {}
}

if (fs.existsSync(dbFile)) {
    try {
        db = { ...db, ...fs.readJsonSync(dbFile) }
    } catch (e) { console.log("Erro ao ler DB, iniciando nova.") }
}

const saveDB = () => fs.writeJsonSync(dbFile, db, { spaces: 2 })

// ================= SERVIDOR WEB PARA QR CODE =================
let currentQR = null
let isConnected = false

const server = http.createServer(async (req, res) => {
    if (req.url === "/qr.png") {
        if (!currentQR) return res.end("QR nao gerado ou ja conectado")
        const buf = await QRCode.toBuffer(currentQR)
        res.writeHead(200, { "Content-Type": "image/png" })
        return res.end(buf)
    }
    
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    if (isConnected) {
        return res.end("<h1>✅ Bot Conectado!</h1>")
    }
    if (!currentQR) {
        return res.end("<h1>⏳ Carregando QR... Recarregue a pagina em 5s</h1><script>setTimeout(()=>location.reload(), 5000)</script>")
    }
    const dataUrl = await QRCode.toDataURL(currentQR)
    return res.end(`<h1>Escaneie o QR Code:</h1><img src="${dataUrl}"><script>setTimeout(()=>location.reload(), 20000)</script>`)
})

server.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 Servidor rodando na porta ${PORT}`)
})

// ================= FUNÇÃO PRINCIPAL DO BOT =================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth"))
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: "silent" }),
        printQRInTerminal: true, // Também mostra no log do Railway
        browser: Browsers.ubuntu("Chrome"),
        markOnlineOnConnect: true
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) currentQR = qr
        
        if (connection === "open") {
            console.log("✅ Conexão estabelecida com sucesso!")
            isConnected = true
            currentQR = null
        }

        if (connection === "close") {
            isConnected = false
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log("❌ Conexão fechada. Motivo:", lastDisconnect?.error, "Tentando reconectar:", shouldReconnect)
            if (shouldReconnect) startBot()
        }
    })

    // Mensagens
    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const msg = messages[0]
            if (!msg.message || msg.key.fromMe) return

            const from = msg.key.remoteJid
            const type = Object.keys(msg.message)[0]
            
            // Extrair texto de várias formas
            let text = ""
            if (type === "conversation") text = msg.message.conversation
            else if (type === "extendedTextMessage") text = msg.message.extendedTextMessage.text
            else if (type === "imageMessage") text = msg.message.imageMessage.caption
            else if (type === "videoMessage") text = msg.message.videoMessage.caption
            
            if (!text) return
            const body = text.toLowerCase().trim()
            const isCmd = body.startsWith(PREFIX)
            const command = isCmd ? body.slice(PREFIX.length).split(" ")[0] : null
            const args = text.trim().split(/\s+/).slice(1)

            // Info do Remetente
            const sender = msg.key.participant || from
            const isGroup = from.endsWith("@g.us")
            const isOwner = sender.includes(OWNER.split("@")[0])

            // Info do Grupo
            let groupMetadata = isGroup ? await sock.groupMetadata(from) : null
            let participants = isGroup ? groupMetadata.participants : []
            let isAdmin = isGroup ? participants.find(p => p.id === sender)?.admin : false
            let botId = sock.user.id.split(":")[0] + "@s.whatsapp.net"
            let isBotAdmin = isGroup ? participants.find(p => p.id === botId)?.admin : false

            // Lógica de Silêncio
            if (isGroup && db.modoSilencio[from] && !isAdmin && !isOwner) return

            // COMANDOS
            if (isCmd) {
                console.log(`[CMD] ${command} enviado por ${sender}`)
                
                const reply = (txt) => sock.sendMessage(from, { text: txt }, { quoted: msg })

                switch (command) {
                    case "ping":
                        await reply("🏓 Pong! O bot está ativo.")
                        break

                    case "menu":
                    case "help":
                        let menu = `🤖 *BOT WHATSAPP*\n\n`
                        menu += `*!ping* - Testar bot\n`
                        menu += `*!sticker* - Criar figurinha (marque imagem)\n`
                        menu += `*!ban* - Banir (Admins)\n`
                        menu += `*!todos* - Marcar todos\n`
                        menu += `*!play* - Buscar música\n`
                        await reply(menu)
                        break

                    case "sticker":
                    case "s":
                        const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage
                        const media = quoted ? quoted : msg.message
                        if (media?.imageMessage || media?.videoMessage) {
                            await reply("⏳ Criando figurinha...")
                            const buffer = await downloadMediaMessage(
                                { key: msg.key, message: media },
                                "buffer",
                                {}
                            )
                            const sticker = new Sticker(buffer, {
                                pack: "Meu Bot",
                                author: "WhatsApp",
                                type: StickerTypes.FULL,
                                quality: 50
                            })
                            await sock.sendMessage(from, { sticker: await sticker.toBuffer() }, { quoted: msg })
                        } else {
                            await reply("❌ Responda a uma imagem ou vídeo com !sticker")
                        }
                        break

                    case "todos":
                        if (!isGroup) return reply("Apenas em grupos")
                        if (!isAdmin) return reply("Apenas admins")
                        const mems = participants.map(p => p.id)
                        let texto = "📢 *CHAMADA GERAL*\n\n"
                        for (let m of mems) { texto += `@${m.split("@")[0]}\n` }
                        await sock.sendMessage(from, { text: texto, mentions: mems })
                        break

                    case "ban":
                        if (!isGroup || !isAdmin || !isBotAdmin) return reply("Erro: Verifique se eu e você somos admins.")
                        const citou = msg.message.extendedTextMessage?.contextInfo?.mentionedJid[0] || 
                                      msg.message.extendedTextMessage?.contextInfo?.participant
                        if (!citou) return reply("Marque quem deseja banir.")
                        await sock.groupParticipantsUpdate(from, [citou], "remove")
                        await reply("🔨 Removido com sucesso.")
                        break

                    case "play":
                        if (!args.length) return reply("Diga o nome da música.")
                        const res = await ytSearch(args.join(" "))
                        const vid = res.videos[0]
                        if (vid) {
                            await reply(`🎵 *${vid.title}*\n🔗 ${vid.url}`)
                        }
                        break
                }
            }

        } catch (err) {
            console.error("ERRO NO UPSERT:", err)
        }
    })
}

// Proteção básica
process.on("unhandledRejection", (err) => console.log("Erro Rejeitado:", err))
process.on("uncaughtException", (err) => console.log("Erro Capturado:", err))

startBot()
