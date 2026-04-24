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

// ================= CONFIGURAÇÕES =================
const PREFIX = "!"
const OWNER = "258864617807@s.whatsapp.net" 
const dbFile = path.join(__dirname, "database.json")

let db = { groups: {}, users: {} }
if (fs.existsSync(dbFile)) {
    try { db = fs.readJsonSync(dbFile) } catch { db = { groups: {}, users: {} } }
}
const saveDB = () => fs.writeJsonSync(dbFile, db, { spaces: 2 })

// Filtros
const BAD_WORDS = ["puta", "caralho", "fdp", "merda", "lixo", "verme", "corno"]
const LINK_REGEX = /(https?:\/\/|www\.|\.(com|net|org|io|me|xyz|info))/i

// ================= SERVIDOR WEB =================
let currentQR = null
let isConnected = false

http.createServer(async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    if (isConnected) return res.end("<h1>✅ Bot Online!</h1>")
    if (!currentQR) return res.end("<h1>⏳ Gerando QR... Aguarde.</h1>")
    const dataUrl = await QRCode.toDataURL(currentQR)
    res.end(`<h2>Escaneie o QR Code:</h2><img src="${dataUrl}" width="350"><script>setTimeout(()=>location.reload(),15000)</script>`)
}).listen(process.env.PORT || 3000)

// ================= BOT CORE =================

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
            console.log("🚀 BOT CONECTADO!")
        }
        if (connection === "close") {
            isConnected = false
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) startBot()
        }
    })

    // --- Boas-Vindas ---
    sock.ev.on("group-participants.update", async (anu) => {
        if (!db.groups[anu.id]?.boasVindas) return
        const meta = await sock.groupMetadata(anu.id)
        for (let x of anu.participants) {
            let txt = anu.action === "add" 
                ? (db.groups[anu.id].bemVindoMsg || `Bem-vindo(a) @user ao grupo ${meta.subject}! 👋`)
                : `Adeus @user, saiu do grupo. 🏃💨`
            await sock.sendMessage(anu.id, { text: txt.replace("@user", `@${x.split("@")[0]}`), mentions: [x] })
        }
    })

    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const m = messages[0]
            if (!m.message) return
            const fromMe = m.key.fromMe
            const from = m.key.remoteJid
            const type = Object.keys(m.message)[0]
            const body = (type === 'conversation') ? m.message.conversation : (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text : (type === 'imageMessage') ? m.message.imageMessage.caption : (type === 'videoMessage') ? m.message.videoMessage.caption : ''

            if (fromMe && !body.startsWith(PREFIX)) return

            const isGroup = from.endsWith("@g.us")
            const sender = isGroup ? m.key.participant : from
            const pushname = m.pushName || "Usuário"
            const isCmd = body.startsWith(PREFIX)
            const command = isCmd ? body.slice(PREFIX.length).trim().split(/ +/).shift().toLowerCase() : null
            const args = body.trim().split(/ +/).slice(1)
            const q = args.join(" ")

            // DB Setup
            if (isGroup && !db.groups[from]) {
                db.groups[from] = { antiLink: false, antiPalavrao: false, boasVindas: false, avisos: {}, regras: "Sem regras.", bemVindoMsg: "" }
                saveDB()
            }
            if (!db.users[sender]) { db.users[sender] = { xp: 0, avisosGerais: 0 }; saveDB() }

            // Metadados
            let groupMetadata, participants, admins, isAdmin, isBotAdmin
            if (isGroup) {
                groupMetadata = await sock.groupMetadata(from)
                participants = groupMetadata.participants
                admins = participants.filter(p => p.admin !== null).map(p => p.id)
                isAdmin = admins.includes(sender) || sender === OWNER
                isBotAdmin = admins.includes(sock.user.id.split(":")[0] + "@s.whatsapp.net")
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
                if (db.groups[jid].avisos[user] >= 3) {
                    await reply(`🚫 @${user.split("@")[0]} foi banido por atingir 3 avisos.`)
                    await sock.groupParticipantsUpdate(jid, [user], "remove")
                    db.groups[jid].avisos[user] = 0; saveDB()
                } else {
                    await reply(`⚠️ @${user.split("@")[0]} recebeu um aviso (${db.groups[jid].avisos[user]}/3).\nMotivo: ${motivo}`)
                }
            }

            // XP
            db.users[sender].xp += 2; saveDB()

            // ================= COMANDOS =================
            if (!isCmd) return

            switch (command) {
                case 'ping': reply(`🏓 *Pong!* Bot ativo.`); break
                
                case 'menu': case 'help':
                    reply(`
╔══════════════════╗
║  ✨ *MENU DO BOT* ✨
╚══════════════════╝

🛡️ *ADMINISTRAÇÃO*
!ban @user (Remover)
!promover @user (Dar Admin)
!rebaixar @user (Tirar Admin)
!apagar (Responder msg)
!silenciar (Fechar grupo)
!falar (Abrir grupo)
!antilink on/off
!antipalavrao on/off
!boasvindas on/off
!setregras <texto>
!regras (Ver regras)
!todos (Marcar todos)

🎨 *MÍDIA / ÚTEIS*
!s (Criar figurinha)
!toimg (Sticker para imagem)
!play <música> (YouTube)
!xp (Ver seus pontos)
!ranking (Top usuários)
!meusavisos (Ver infrações)
!infogrupo (Dados do grupo)
!perfil (Seus dados)

🎁 *NOVOS / EXTRAS*
!sorteio (Escolhe um membro)
!dono (Contato do criador)
!linkgrupo (Link do convite)
!nomegrupo <nome> (Mudar nome)
!desc <texto> (Mudar descrição)
!limparavisos @user (Zerar)
!id (Ver ID do chat)
!marcar (Diferente do todos)
!say <texto> (Bot fala)
`)
                break

                // --- COMANDOS CORRIGIDOS ---
                case 'meusavisos':
                    let av = db.groups[from]?.avisos[sender] || 0
                    reply(`⚠️ Você tem *${av}/3* avisos neste grupo.`)
                    break

                case 'ban':
                    if (!isAdmin) return reply("❌ Só admins.")
                    if (!isBotAdmin) return reply("❌ Preciso ser admin.")
                    let targetBan = getMention()
                    if (!targetBan) return reply("Marque alguém ou responda a mensagem.")
                    await sock.groupParticipantsUpdate(from, [targetBan], "remove")
                    reply("🔨 Removido com sucesso.")
                    break

                case 'promover':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Sem permissão.")
                    let targetPro = getMention()
                    await sock.groupParticipantsUpdate(from, [targetPro], "promote")
                    reply("⭐ Agora é administrador.")
                    break

                case 'rebaixar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Sem permissão.")
                    let targetDem = getMention()
                    await sock.groupParticipantsUpdate(from, [targetDem], "demote")
                    reply("⬇️ Rebaixado para membro comum.")
                    break

                case 'apagar':
                    if (!isAdmin) return reply("❌ Só admins.")
                    if (!m.message.extendedTextMessage?.contextInfo?.stanzaId) return reply("Responda à mensagem que quer apagar.")
                    await sock.sendMessage(from, { delete: m.message.extendedTextMessage.contextInfo })
                    break

                case 'setregras':
                    if (!isAdmin) return reply("❌ Só admins.")
                    db.groups[from].regras = q; saveDB(); reply("✅ Regras atualizadas.")
                    break

                case 'regras':
                    reply(`📜 *REGRAS:* \n\n${db.groups[from].regras}`)
                    break

                case 'antilink':
                    if (!isAdmin) return reply("❌ Só admins.")
                    db.groups[from].antiLink = (q === 'on'); saveDB()
                    reply(`🔗 Anti-link: *${db.groups[from].antiLink ? "ON" : "OFF"}*`)
                    break

                case 'antipalavrao':
                    if (!isAdmin) return reply("❌ Só admins.")
                    db.groups[from].antiPalavrao = (q === 'on'); saveDB()
                    reply(`🤬 Anti-palavrão: *${db.groups[from].antiPalavrao ? "ON" : "OFF"}*`)
                    break

                case 'boasvindas':
                    if (!isAdmin) return reply("❌ Só admins.")
                    db.groups[from].boasVindas = (q === 'on'); saveDB()
                    reply(`👋 Boas-vindas: *${db.groups[from].boasVindas ? "ON" : "OFF"}*`)
                    break

                case 'silenciar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Erro de permissão.")
                    await sock.groupSettingUpdate(from, 'announcement')
                    db.groups[from].silenciar = true; saveDB()
                    reply("🔇 Grupo Fechado! Apenas admins falam.")
                    break

                case 'falar':
                    if (!isAdmin || !isBotAdmin) return reply("❌ Erro de permissão.")
                    await sock.groupSettingUpdate(from, 'not_announcement')
                    db.groups[from].silenciar = false; saveDB()
                    reply("🔊 Grupo Aberto! Todos podem falar.")
                    break

                case 'toimg':
                    const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage
                    if (!quoted?.stickerMessage) return reply("Responda a um sticker estático.")
                    const stream = await downloadMediaMessage({ message: quoted }, 'buffer', {})
                    await sock.sendMessage(from, { image: stream, caption: "🖼️ Convertido por Bot" }, { quoted: m })
                    break

                // --- NOVOS COMANDOS PROFISSIONAIS ---
                case 'infogrupo':
                    reply(`📋 *INFO GRUPO*\n\nNome: ${groupMetadata.subject}\nID: ${from}\nMembros: ${participants.length}\nAdmins: ${admins.length}`)
                    break

                case 'perfil':
                    reply(`👤 *SEU PERFIL*\n\nNome: ${pushname}\nXP: ${db.users[sender].xp}\nAvisos: ${db.groups[from]?.avisos[sender] || 0}/3`)
                    break

                case 'sorteio':
                    if (!isGroup) return;
                    let sortudo = participants[Math.floor(Math.random() * participants.length)].id
                    reply(`🎉 O grande sorteado foi: @${sortudo.split("@")[0]}!`, [sortudo])
                    break

                case 'linkgrupo':
                    if (!isBotAdmin) return reply("Não sou admin.")
                    const code = await sock.groupInviteCode(from)
                    reply(`https://chat.whatsapp.com/${code}`)
                    break

                case 'nomegrupo':
                    if (!isAdmin || !isBotAdmin) return reply("Sem permissão.")
                    await sock.groupUpdateSubject(from, q)
                    reply("✅ Nome alterado.")
                    break

                case 'desc':
                    if (!isAdmin || !isBotAdmin) return reply("Sem permissão.")
                    await sock.groupUpdateDescription(from, q)
                    reply("✅ Descrição alterada.")
                    break

                case 'dono':
                    reply(`👑 *DONO DO BOT:* @${OWNER.split("@")[0]}`, [OWNER])
                    break

                case 'limparavisos':
                    if (!isAdmin) return reply("Só admins.")
                    let userL = getMention()
                    if (db.groups[from].avisos[userL]) { db.groups[from].avisos[userL] = 0; saveDB() }
                    reply("✅ Avisos zerados.")
                    break

                case 'play':
                    if (!q) return reply("Qual música?")
                    reply("🔎 Buscando...")
                    const res = await ytSearch(q)
                    const v = res.videos[0]
                    if (!v) return reply("Nada encontrado.")
                    await sock.sendMessage(from, { image: { url: v.thumbnail }, caption: `🎵 *${v.title}*\n⏱️ ${v.timestamp}\n🔗 ${v.url}` }, { quoted: m })
                    break

                case 's': case 'sticker':
                    if (type === 'imageMessage' || type === 'videoMessage' || m.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                        const buffer = await downloadMediaMessage(m, 'buffer', {})
                        const s = new Sticker(buffer, { pack: "Bot Pack", author: pushname, type: StickerTypes.FULL })
                        await sock.sendMessage(from, { sticker: await s.toBuffer() }, { quoted: m })
                    }
                    break
            }
        } catch (err) { console.log(err) }
    })
}

startBot()
