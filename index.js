const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys")

const P = require("pino")
const QRCode = require("qrcode")
const http = require("http")
const fs = require("fs-extra")
const path = require("path")
const axios = require("axios")
const { Sticker, StickerTypes } = require("wa-sticker-formatter")
const ytSearch = require("yt-search")

// ============================================================
// THE ONE MAN BOT — PROFESSIONAL ALL-IN-ONE VERSION
// ============================================================
// English = default language
// Portuguese = secondary language
//
// Change group language:
// !lang en
// !lang pt
//
// Main features:
// - Persistent WhatsApp session
// - QR Web page
// - Group management
// - Admin management
// - Anti-link
// - Anti-badword
// - Warnings
// - Welcome / Goodbye
// - Rules
// - Scheduling
// - Web dashboard
// - GPT
// - Google
// - JW
// - YouTube search
// - XP/user database
// - Persistent JSON database
// - Automatic reconnection
// ============================================================

const PREFIX = process.env.PREFIX || "!"
const OWNER = process.env.OWNER_JID || "258858285865@s.whatsapp.net"
const BOT_NAME = process.env.BOT_NAME || "The One Man Bot"
const PORT = Number(process.env.PORT || 3000)
const TZ = process.env.TZ_NAME || "Africa/Maputo")

const DATA_DIR = process.env.DATA_DIR || __dirname
const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, "auth")
const dbFile = process.env.DB_FILE || path.join(DATA_DIR, "database.json")
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""

fs.ensureDirSync(DATA_DIR)
fs.ensureDirSync(AUTH_DIR)

// ============================================================
// DATABASE
// ============================================================

const DEFAULT_GROUP = () => ({
  antiLink: true,
  antiPalavrao: true,
  boasVindas: true,
  avisos: {},
  regras: "Sem regras.",
  mute: false,
  welcomeText: "",
  goodbyeText: "",
  language: "en",
})

let db = {
  groups: {},
  users: {},
  schedules: [],
  meta: {},
}

if (fs.existsSync(dbFile)) {
  try {
    db = fs.readJsonSync(dbFile)
  } catch (e) {
    console.error("Database load error:", e.message)
    db = {
      groups: {},
      users: {},
      schedules: [],
      meta: {},
    }
  }
}

db.groups ||= {}
db.users ||= {}
db.schedules ||= []
db.meta ||= {}

let saveTimer = null

function saveDB() {
  clearTimeout(saveTimer)

  saveTimer = setTimeout(() => {
    try {
      fs.writeJsonSync(dbFile, db, {
        spaces: 2,
      })
    } catch (e) {
      console.error("Database save error:", e.message)
    }
  }, 100)
}

// ============================================================
// MODERATION
// ============================================================

const BAD_WORDS = [
  "puta",
  "caralho",
  "fdp",
  "merda",
  "lixo",
  "verme",
  "corno",
  "idiota",
  "desgraça",
]

const LINK_REGEX =
  /((https?:\/\/)|(www\.))[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi

// ============================================================
// RUNTIME STATE
// ============================================================

let sock = null
let currentQR = null
let isConnected = false
let reconnecting = false
let connectionState = "starting"
let lastError = ""
let connectedAt = null

let groupCache = new Map()
let groupCacheAt = 0

// ============================================================
// HTTP HELPERS
// ============================================================

function json(res, status, body) {
  const data = JSON.stringify(body)

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  })

  res.end(data)
}

function parseBody(req) {
  return new Promise(resolve => {
    let raw = ""

    req.on("data", chunk => {
      raw += chunk

      if (raw.length > 2_000_000) {
        try {
          req.destroy()
        } catch {}
      }
    })

    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve(null)
      }
    })

    req.on("error", () => resolve(null))
  })
}

function authorized(req) {
  if (!ADMIN_TOKEN) {
    return true
  }

  const header = req.headers.authorization || ""

  const token = header.replace(/^Bearer\s+/i, "")

  return (
    token === ADMIN_TOKEN ||
    req.headers["x-admin-token"] === ADMIN_TOKEN
  )
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  })

  res.end(html)
}

function esc(value) {
  return String(value ?? "").replace(
    /[&<>\"]/g,
    x =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
      }[x])
  )
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function jidDisplay(jid = "") {
  return String(jid)
    .split("@")[0]
    .split(":")[0]
}

function normalizeJid(value = "") {
  const raw = String(value || "").trim()

  if (!raw) {
    return ""
  }

  if (
    raw.endsWith("@g.us") ||
    raw.endsWith("@lid")
  ) {
    return raw
  }

  if (raw.endsWith("@s.whatsapp.net")) {
    return jidNormalizedUser(raw)
  }

  const number = raw.replace(/\D/g, "")

  return number
    ? `${number}@s.whatsapp.net`
    : ""
}

function participantJid(p) {
  return p?.id || p?.lid || ""
}

function isParticipantAdmin(p) {
  return (
    !!p &&
    (
      p.admin === "admin" ||
      p.admin === "superadmin" ||
      p.isAdmin === true ||
      p.isSuperAdmin === true
    )
  )
}

// ============================================================
// MESSAGE HELPERS
// ============================================================

function getText(m) {
  const msg = m?.message

  if (!msg) {
    return ""
  }

  if (msg.conversation) {
    return msg.conversation
  }

  if (msg.extendedTextMessage?.text) {
    return msg.extendedTextMessage.text
  }

  if (msg.imageMessage?.caption) {
    return msg.imageMessage.caption
  }

  if (msg.videoMessage?.caption) {
    return msg.videoMessage.caption
  }

  if (msg.documentMessage?.caption) {
    return msg.documentMessage.caption
  }

  return ""
}

function getQuoted(m) {
  return m?.message?.extendedTextMessage?.contextInfo || null
}

function getMention(m) {
  const context = getQuoted(m)

  if (!context) {
    return null
  }

  return (
    context?.mentionedJid?.[0] ||
    context?.participant ||
    null
  )
}

// ============================================================
// GROUP HELPERS
// ============================================================

async function getMetadata(jid, force = false) {
  if (
    !sock ||
    !jid ||
    !jid.endsWith("@g.us")
  ) {
    return null
  }

  const now = Date.now()

  const cached = groupCache.get(jid)

  if (
    !force &&
    cached &&
    now - cached.at < 60_000
  ) {
    return cached.data
  }

  const data = await sock.groupMetadata(jid)

  groupCache.set(jid, {
    at: now,
    data,
  })

  return data
}

function ensureGroup(jid) {
  if (!db.groups[jid]) {
    db.groups[jid] = DEFAULT_GROUP()
  }

  const g = db.groups[jid]

  g.avisos ||= {}

  if (typeof g.antiLink !== "boolean") {
    g.antiLink = true
  }

  if (typeof g.antiPalavrao !== "boolean") {
    g.antiPalavrao = true
  }

  if (typeof g.boasVindas !== "boolean") {
    g.boasVindas = true
  }

  if (typeof g.mute !== "boolean") {
    g.mute = false
  }

  if (!["en", "pt"].includes(g.language)) {
    g.language = "en"
  }

  return g
}

async function getBotJid() {
  return sock?.user?.id
    ? jidNormalizedUser(sock.user.id)
    : ""
}

async function isGroupAdmin(groupJid, userJid) {
  try {
    const meta = await getMetadata(groupJid)

    const p = meta?.participants?.find(x =>
      [x.id, x.lid]
        .filter(Boolean)
        .includes(userJid)
    )

    return isParticipantAdmin(p)
  } catch {
    return false
  }
}

async function botIsAdmin(groupJid) {
  try {
    const meta = await getMetadata(groupJid)

    const bot = await getBotJid()

    const p = meta?.participants?.find(x =>
      [x.id, x.lid]
        .filter(Boolean)
        .includes(bot)
    )

    return isParticipantAdmin(p)
  } catch {
    return false
  }
}

// ============================================================
// LANGUAGE SYSTEM
// ============================================================

const EN = {
  ping: "🏓 Pong! Bot is active and online.",

  status: (name, connected, timezone) =>
    `📡 *STATUS*\n\nBot: ${name}\nWhatsApp: ${
      connected
        ? "🟢 Connected"
        : "🔴 Disconnected"
    }\nSession: persistent\nTimezone: ${timezone}`,

  id: id => `🆔 *ID:* ${id}`,

  owner: owner =>
    `👑 *OWNER:* @${jidDisplay(owner)}`,

  ask: "Tell me what you want to ask.",

  thinking: "🤖 Thinking...",

  noAI: "❌ Could not connect to the AI service.",

  musicName: "What is the song name?",

  searching: "⏳ Searching YouTube...",

  nothing: "Nothing found.",

  searchError: "❌ Search error.",

  adminOnly: "❌ Admins only.",

  adminBot:
    "❌ You must be an Admin and the bot must also be an Admin.",

  noMention:
    "Mention or reply to the person.",

  promoted:
    "⭐ Promoted to Admin.",

  demoted:
    "⬇️ Demoted.",

  replyDelete:
    "Reply to the message you want to delete.",

  muted:
    "🔇 Group muted: only Admins can send messages.",

  opened:
    "🔊 Group opened: everyone can send messages.",

  rulesUpdated:
    "✅ Rules updated.",

  noRules:
    "No rules defined.",

  noWarnings:
    "✅ No warnings registered.",

  noSchedule:
    "📅 There are no scheduled messages.",

  invalidTime:
    "❌ Invalid time. Use HH:MM.",

  scheduleUse: prefix =>
    `📅 Use: ${prefix}agendar 20:30 message here`,

  scheduleOk: (id, time, timezone) =>
    `✅ Message scheduled.\n🆔 ${id}\n🕒 ${time}\n🌍 ${timezone}`,

  scheduleCancelled:
    "🗑️ Schedule cancelled.",

  scheduleNotFound:
    "❌ Schedule not found.",

  unknown: prefix =>
    `❓ Unknown command. Use ${prefix}menu.`,

  langUse: prefix =>
    `🌐 Current language: *English*\nUse ${prefix}lang pt to switch to Portuguese.`,

  langInvalid:
    "🌐 Invalid language. Use en or pt.",

  langSetEn:
    "🌐 Language changed to *English*.",

  langSetPt:
    "🌐 Idioma alterado para *Português*.",

  onlyGroup:
    "This command can only be used in a group.",

  removed: user =>
    `🔨 @${jidDisplay(user)} was removed successfully.`,

  warning: (number, user, reason) =>
    `⚠️ *WARNING ${number}/3*\n@${jidDisplay(user)}\nReason: ${reason}`,

  warningBan: user =>
    `🚫 *BAN:* @${jidDisplay(user)} was removed after reaching 3/3 warnings.`,

  antiLink: enabled =>
    `🔗 Anti-link: *${enabled ? "ON" : "OFF"}*`,

  antiBadword: enabled =>
    `🤬 Anti-badword: *${enabled ? "ON" : "OFF"}*`,

  welcome: enabled =>
    `👋 Welcome messages: *${enabled ? "ON" : "OFF"}*`,

  deleted:
    "🗑️ Message deleted.",

  goodbye:
    "👋 Goodbye message sent.",

  scheduleAdmin:
    "❌ Only Admins can schedule messages.",

  unauthorized:
    "Unauthorized",

  invalidGroup:
    "Invalid group",

  notConnected:
    "WhatsApp is not connected",

  noSession:
    "No active session",

  routeNotFound:
    "Route not found",

  groupOnlyDestination:
    "The destination must be a group.",
}

const PT = {
  ping:
    "🏓 Pong! Bot ativo e online.",

  status: (name, connected, timezone) =>
    `📡 *STATUS*\n\nBot: ${name}\nWhatsApp: ${
      connected
        ? "🟢 Conectado"
        : "🔴 Desconectado"
    }\nSessão: persistente\nFuso: ${timezone}`,

  id: id =>
    `🆔 *ID:* ${id}`,

  owner: owner =>
    `👑 *DONO:* @${jidDisplay(owner)}`,

  ask:
    "Diga o que deseja perguntar.",

  thinking:
    "🤖 Pensando...",

  noAI:
    "❌ Não foi possível conectar à IA.",

  musicName:
    "Nome da música?",

  searching:
    "⏳ Buscando no YouTube...",

  nothing:
    "Nada encontrado.",

  searchError:
    "❌ Erro na pesquisa.",

  adminOnly:
    "❌ Só Admins.",

  adminBot:
    "❌ Preciso que sejas Admin e o bot também seja Admin.",

  noMention:
    "Marque ou responda à pessoa.",

  promoted:
    "⭐ Promovido a Admin.",

  demoted:
    "⬇️ Rebaixado.",

  replyDelete:
    "Responda à mensagem que deseja apagar.",

  muted:
    "🔇 Grupo silenciado: apenas Admins podem falar.",

  opened:
    "🔊 Grupo aberto: todos podem falar.",

  rulesUpdated:
    "✅ Regras atualizadas.",

  noRules:
    "Não definidas.",

  noWarnings:
    "✅ Nenhum aviso registrado.",

  noSchedule:
    "📅 Não há mensagens agendadas.",

  invalidTime:
    "❌ Hora inválida. Use HH:MM.",

  scheduleUse: prefix =>
    `📅 Use: ${prefix}agendar 20:30 mensagem aqui`,

  scheduleOk: (id, time, timezone) =>
    `✅ Mensagem agendada.\n🆔 ${id}\n🕒 ${time}\n🌍 ${timezone}`,

  scheduleCancelled:
    "🗑️ Agendamento cancelado.",

  scheduleNotFound:
    "❌ Agendamento não encontrado.",

  unknown: prefix =>
    `❓ Comando desconhecido. Use ${prefix}menu.`,

  langUse: prefix =>
    `🌐 Idioma atual: *Português*\nUse ${prefix}lang en para mudar para Inglês.`,

  langInvalid:
    "🌐 Idioma inválido. Use en ou pt.",

  langSetEn:
    "🌐 Language changed to *English*.",

  langSetPt:
    "🌐 Idioma alterado para *Português*.",

  onlyGroup:
    "Este comando só pode ser usado em um grupo.",

  removed: user =>
    `🔨 @${jidDisplay(user)} removido com sucesso.`,

  warning: (number, user, reason) =>
    `⚠️ *AVISO ${number}/3*\n@${jidDisplay(user)}\nMotivo: ${reason}`,

  warningBan: user =>
    `🚫 *BAN:* @${jidDisplay(user)} foi removido por excesso de avisos (3/3).`,

  antiLink: enabled =>
    `🔗 Anti-link: *${enabled ? "ON" : "OFF"}*`,

  antiBadword: enabled =>
    `🤬 Anti-palavrão: *${enabled ? "ON" : "OFF"}*`,

  welcome: enabled =>
    `👋 Boas-vindas: *${enabled ? "ON" : "OFF"}*`,

  deleted:
    "🗑️ Mensagem apagada.",

  goodbye:
    "👋 Mensagem de saída enviada.",

  scheduleAdmin:
    "❌ Só Admins podem agendar mensagens.",

  unauthorized:
    "Não autorizado",

  invalidGroup:
    "Grupo inválido",

  notConnected:
    "WhatsApp não está conectado",

  noSession:
    "Sem sessão ativa",

  routeNotFound:
    "Rota não encontrada",

  groupOnlyDestination:
    "O destino deve ser um grupo.",
}

function groupLanguage(jid) {
  if (
    jid?.endsWith("@g.us") &&
    db.groups[jid]?.language === "pt"
  ) {
    return "pt"
  }

  return "en"
}

function T(jid, key, ...args) {
  const dictionary =
    groupLanguage(jid) === "pt"
      ? PT
      : EN

  const value =
    dictionary[key] ??
    EN[key] ??
    key

  return typeof value === "function"
    ? value(...args)
    : value
}

// ============================================================
// MENU
// ============================================================

function makeMenu(jid) {
  const lang = groupLanguage(jid)

  if (lang === "pt") {
    return `╔══════════════════════════╗
   🤖 *${BOT_NAME.toUpperCase()}*
╚══════════════════════════╝

🛡️ *MODERAÇÃO*

${PREFIX}ban
${PREFIX}promover
${PREFIX}rebaixar
${PREFIX}silenciar
${PREFIX}falar
${PREFIX}apagar

${PREFIX}antilink
${PREFIX}antipalavrao
${PREFIX}boasvindas

${PREFIX}setregras
${PREFIX}regras
${PREFIX}aviso
${PREFIX}avisos

📅 *AGENDAMENTO*

${PREFIX}agendar HH:MM mensagem
${PREFIX}agenda
${PREFIX}cancelar ID

🔍 *PESQUISA*

${PREFIX}gpt
${PREFIX}google
${PREFIX}jw
${PREFIX}play

⚙️ *SISTEMA*

${PREFIX}ping
${PREFIX}id
${PREFIX}say
${PREFIX}dono
${PREFIX}status

🌐 *IDIOMA*

${PREFIX}lang en
${PREFIX}lang pt`
  }

  return `╔══════════════════════════╗
   🤖 *${BOT_NAME.toUpperCase()}*
╚══════════════════════════╝

🛡️ *MODERATION*

${PREFIX}ban
${PREFIX}promover
${PREFIX}rebaixar
${PREFIX}silenciar
${PREFIX}falar
${PREFIX}apagar

${PREFIX}antilink
${PREFIX}antipalavrao
${PREFIX}boasvindas

${PREFIX}setregras
${PREFIX}regras
${PREFIX}aviso
${PREFIX}avisos

📅 *SCHEDULING*

${PREFIX}agendar HH:MM message
${PREFIX}agenda
${PREFIX}cancelar ID

🔍 *SEARCH*

${PREFIX}gpt
${PREFIX}google
${PREFIX}jw
${PREFIX}play

⚙️ *SYSTEM*

${PREFIX}ping
${PREFIX}id
${PREFIX}say
${PREFIX}dono
${PREFIX}status

🌐 *LANGUAGE*

${PREFIX}lang en
${PREFIX}lang pt`
}

// ============================================================
// SEND MESSAGE
// ============================================================

async function sendText(jid, text, quoted) {
  if (!sock || !isConnected) {
    throw new Error(
      "WhatsApp is not connected"
    )
  }

  return sock.sendMessage(
    jid,
    {
      text: String(text),
    },
    quoted
      ? {
          quoted,
        }
      : undefined
  )
}

// ============================================================
// WARNINGS
// ============================================================

async function addWarning(
  groupJid,
  user,
  reason,
  reply
) {
  const g = ensureGroup(groupJid)

  g.avisos[user] =
    Number(g.avisos[user] || 0) + 1

  const count = g.avisos[user]

  saveDB()

  if (
    count >= 3 &&
    await botIsAdmin(groupJid)
  ) {
    await reply(
      T(
        groupJid,
        "warningBan",
        user
      )
    )

    try {
      await sock.groupParticipantsUpdate(
        groupJid,
        [user],
        "remove"
      )
    } catch {}

    g.avisos[user] = 0

    saveDB()
  } else {
    await reply(
      T(
        groupJid,
        "warning",
        count,
        user,
        reason
      )
    )
  }
}

// ============================================================
// SCHEDULING
// ============================================================

function makeId() {
  return `${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

function nextOccurrence(timeText) {
  const match = String(timeText).match(
    /^(\d{1,2}):(\d{2})$/
  )

  if (!match) {
    return null
  }

  const hh = Number(match[1])
  const mm = Number(match[2])

  if (
    hh > 23 ||
    mm > 59
  ) {
    return null
  }

  const now = new Date()

  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }
    ).formatToParts(now)

  const get = type =>
    Number(
      parts.find(
        x => x.type === type
      )?.value || 0
    )

  const localNow = {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    h: get("hour"),
    mi: get("minute"),
    s: get("second"),
  }

  let candidate = new Date(
    Date.UTC(
      localNow.y,
      localNow.mo - 1,
      localNow.d,
      hh,
      mm,
      0
    )
  )

  const probe =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }
    )

  for (let i = 0; i < 3; i++) {
    const p =
      Object.fromEntries(
        probe
          .formatToParts(candidate)
          .map(x => [
            x.type,
            x.value,
          ])
      )

    const asLocal = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      0
    )

    const wanted = Date.UTC(
      localNow.y,
      localNow.mo - 1,
      localNow.d,
      hh,
      mm,
      0
    )

    candidate = new Date(
      candidate.getTime() +
        (wanted - asLocal)
    )
  }

  if (
    candidate.getTime() <=
    Date.now()
  ) {
    candidate = new Date(
      candidate.getTime() +
        24 * 60 * 60 * 1000
    )
  }

  return candidate.toISOString()
}

async function processSchedules() {
  if (!isConnected || !sock) {
    return
  }

  const now = Date.now()

  const due =
    db.schedules.filter(
      item =>
        item.status === "pending" &&
        new Date(
          item.sendAt
        ).getTime() <= now
    )

  for (const item of due) {
    item.status = "sending"

    saveDB()

    try {
      await sock.sendMessage(
        item.jid,
        {
          text: item.text,
        }
      )

      item.status = "sent"
      item.sentAt =
        new Date().toISOString()

      item.error = null
    } catch (e) {
      item.status = "failed"

      item.error = String(
        e?.message || e
      ).slice(0, 500)
    }

    saveDB()
  }
}

setInterval(
  processSchedules,
  5000
)

function scheduleMessage(
  jid,
  text,
  time
) {
  const sendAt =
    nextOccurrence(time)

  if (!sendAt) {
    throw new Error(
      "Invalid time. Use HH:MM."
    )
  }

  const item = {
    id: makeId(),
    jid,
    text,
    time,
    sendAt,
    status: "pending",
    createdAt:
      new Date().toISOString(),
  }

  db.schedules.push(item)

  saveDB()

  return item
}

// ============================================================
// SOCKET / WHATSAPP SESSION
// ============================================================

async function startBot() {
  if (reconnecting) {
    return
  }

  reconnecting = true

  try {
    const {
      state,
      saveCreds,
    } = await useMultiFileAuthState(
      AUTH_DIR
    )

    const {
      version,
    } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
      version,

      auth: state,

      logger: P({
        level: "silent",
      }),

      browser:
        Browsers.macOS("Safari"),

      printQRInTerminal: false,

      markOnlineOnConnect: true,

      syncFullHistory: false,

      generateHighQualityLinkPreview:
        false,
    })

    sock.ev.on(
      "creds.update",
      saveCreds
    )

    // ========================================================
    // CONNECTION UPDATE
    // ========================================================

    sock.ev.on(
      "connection.update",
      async update => {
        const {
          connection,
          lastDisconnect,
          qr,
        } = update

        if (qr) {
          currentQR = qr

          connectionState = "qr"

          isConnected = false

          console.log(
            "📱 New WhatsApp QR available."
          )
        }

        if (
          connection === "connecting"
        ) {
          connectionState =
            "connecting"

          isConnected = false
        }

        if (
          connection === "open"
        ) {
          isConnected = true

          connectionState = "open"

          currentQR = null

          lastError = ""

          connectedAt =
            new Date().toISOString()

          console.log(
            `🚀 ${BOT_NAME} ONLINE — ${
              sock.user?.id ||
              "WhatsApp"
            }`
          )

          groupCache.clear()
        }

        if (
          connection === "close"
        ) {
          isConnected = false

          connectionState =
            "closed"

          const code =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode

          const loggedOut =
            code ===
            DisconnectReason.loggedOut

          lastError = String(
            lastDisconnect
              ?.error
              ?.message ||
              `Code ${
                code ||
                "unknown"
              }`
          )

          console.log(
            `⚠️ WhatsApp disconnected: ${lastError}`
          )

          // IMPORTANT:
          // Never delete auth automatically.
          // Temporary errors must not destroy
          // the existing WhatsApp session.

          if (loggedOut) {
            console.log(
              "🔐 WhatsApp logged out. Existing auth data was NOT automatically deleted."
            )
          }

          if (!reconnecting) {
            setTimeout(
              startBot,
              loggedOut
                ? 15000
                : 5000
            )
          }
        }
      }
    )

    // ========================================================
    // GROUP PARTICIPANTS
    // ========================================================

    sock.ev.on(
      "group-participants.update",
      async anu => {
        try {
          const g =
            ensureGroup(anu.id)

          if (
            anu.action === "add" &&
            g.boasVindas
          ) {
            const meta =
              await getMetadata(
                anu.id,
                true
              )

            for (
              const p of
                anu.participants ||
                []
            ) {
              const user =
                p?.id || p

              const custom =
                g.welcomeText ||
                `👋 Hello @${jidDisplay(
                  user
                )}!\n\n🏢 *Group:* ${
                  meta?.subject ||
                  "Group"
                }\n👥 *Members:* ${
                  meta
                    ?.participants
                    ?.length ||
                  "-"
                }\n\n📜 *RULES:*\n${
                  g.regras ||
                  "No rules defined."
                }`

              await sock.sendMessage(
                anu.id,
                {
                  text: custom,
                  mentions: [user],
                }
              )
            }
          }

          if (
            anu.action ===
              "remove" &&
            g.goodbyeText
          ) {
            for (
              const p of
                anu.participants ||
                []
            ) {
              const user =
                p?.id || p

              await sock.sendMessage(
                anu.id,
                {
                  text:
                    g.goodbyeText.replace(
                      /@user/gi,
                      `@${jidDisplay(
                        user
                      )}`
                    ),

                  mentions: [user],
                }
              )
            }
          }
        } catch (e) {
          console.error(
            "participant update:",
            e.message
          )
        }
      }
    )

    // ========================================================
    // INCOMING MESSAGES
    // ========================================================

    sock.ev.on(
      "messages.upsert",
      async ({
        messages,
      }) => {
        const m =
          messages?.[0]

        if (!m?.message) {
          return
        }

        const from =
          m.key.remoteJid

        if (
          !from ||
          from ===
            "status@broadcast"
        ) {
          return
        }

        try {
          const body =
            getText(m)

          const isGroup =
            from.endsWith(
              "@g.us"
            )

          const sender =
            isGroup
              ? (
                  m.key
                    .participant ||
                  m.participant ||
                  ""
                )
              : from

          const pushname =
            m.pushName ||
            "User"

          if (!sender) {
            return
          }

          if (isGroup) {
            ensureGroup(from)
          }

          // ==================================================
          // USER XP / DATABASE
          // ==================================================

          if (!db.users[sender]) {
            db.users[sender] = {
              xp: 0,
              name: pushname,
              lastSeen: null,
            }
          }

          db.users[sender].xp += 1

          db.users[sender].name =
            pushname

          db.users[sender].lastSeen =
            new Date().toISOString()

          saveDB()

          const reply = text =>
            sendText(
              from,
              text,
              m
            )

          const mention =
            getMention(m)

          const isCmd =
            body.startsWith(
              PREFIX
            )

          const parts =
            body
              .trim()
              .split(/\s+/)

          const command = isCmd
            ? parts[0]
                .slice(
                  PREFIX.length
                )
                .toLowerCase()
            : ""

          const q = isCmd
            ? parts
                .slice(1)
                .join(" ")
            : ""

          // ==================================================
          // ADMIN STATUS
          // ==================================================

          let admin = false
          let botAdmin = false

          if (isGroup) {
            admin =
              await isGroupAdmin(
                from,
                sender
              )

            if (
              normalizeJid(
                sender
              ) ===
              normalizeJid(
                OWNER
              )
            ) {
              admin = true
            }

            botAdmin =
              await botIsAdmin(
                from
              )

            // ==============================================
            // AUTOMATIC MODERATION
            // ==============================================

            const g =
              ensureGroup(from)

            if (
              !admin &&
              botAdmin &&
              body
            ) {
              LINK_REGEX.lastIndex =
                0

              if (
                g.antiLink &&
                LINK_REGEX.test(
                  body
                )
              ) {
                try {
                  await sock.sendMessage(
                    from,
                    {
                      delete:
                        m.key,
                    }
                  )
                } catch {}

                await addWarning(
                  from,
                  sender,
                  "Prohibited link",
                  reply
                )

                return
              }

              if (
                g.antiPalavrao &&
                BAD_WORDS.some(
                  word =>
                    body
                      .toLowerCase()
                      .includes(
                        word
                      )
                )
              ) {
                try {
                  await sock.sendMessage(
                    from,
                    {
                      delete:
                        m.key,
                    }
                  )
                } catch {}

                await addWarning(
                  from,
                  sender,
                  "Offensive language",
                  reply
                )

                return
              }
            }
          }

          if (!isCmd) {
            return
          }

          // ==================================================
          // COMMANDS
          // ==================================================

          switch (command) {
            // =================================================
            // LANGUAGE
            // =================================================

            case "lang": {
              if (!isGroup) {
                const requested =
                  q.trim()
                    .toLowerCase()

                if (
                  requested ===
                  "pt"
                ) {
                  return reply(
                    "🌐 Language set to *Português* for this chat."
                  )
                }

                if (
                  requested ===
                  "en"
                ) {
                  return reply(
                    "🌐 Language set to *English* for this chat."
                  )
                }

                return reply(
                  EN.langUse(
                    PREFIX
                  )
                )
              }

              if (!admin) {
                return reply(
                  T(
                    from,
                    "adminOnly"
                  )
                )
              }

              const requested =
                q.trim()
                  .toLowerCase()

              if (!requested) {
                return reply(
                  T(
                    from,
                    "langUse",
                    PREFIX
                  )
                )
              }

              if (
                ![
                  "en",
                  "pt",
                ].includes(
                  requested
                )
              ) {
                return reply(
                  T(
                    from,
                    "langInvalid"
                  )
                )
              }

              ensureGroup(
                from
              ).language =
                requested

              saveDB()

              if (
                requested ===
                "pt"
              ) {
                return reply(
                  PT.langSetPt
                )
              }

              return reply(
                EN.langSetEn
              )
            }

            // =================================================
            // MENU
            // =================================================

            case "menu":
              return reply(
                makeMenu(from)
              )

            // =================================================
            // PING
            // =================================================

            case "ping":
              return reply(
                T(
                  from,
                  "ping"
                )
              )

            // =================================================
            // STATUS
            // =================================================

            case "status":
              return reply(
                T(
                  from,
                  "status",
                  BOT_NAME,
                  isConnected,
                  TZ
                )
              )

            // =================================================
            // ID
            // =================================================

            case "id":
              return reply(
                T(
                  from,
                  "id",
                  from
                )
              )

            // =================================================
            // SAY
            // =================================================

            case "say":
              return q
                ? reply(q)
                : reply(
                    groupLanguage(
                      from
                    ) === "pt"
                      ? "Escreva a mensagem."
                      : "Write the message."
                  )

            // =================================================
            // OWNER
            // =================================================

            case "dono":
              return sock.sendMessage(
                from,
                {
                  text:
                    T(
                      from,
                      "owner",
                      OWNER
                    ),
                  mentions: [
                    OWNER,
                  ],
                },
                {
                  quoted: m,
                }
              )

            // =================================================
            // GPT
            // =================================================

            case "gpt": {
              if (!q) {
                return reply(
                  T(
                    from,
                    "ask"
                  )
                )
              }

              await reply(
                T(
                  from,
                  "thinking"
                )
              )

              try {
                const r =
                  await axios.get(
                    `https://api.paxsenix.biz.id/ai/gpt4?text=${encodeURIComponent(
                      q
                    )}`,
                    {
                      timeout: 20000,
                    }
                  )

                return reply(
                  `✨ *AI:*\n${
                    r.data
                      ?.message ||
                    "No response."
                  }`
                )
              } catch {
                try {
                  const r2 =
                    await axios.get(
                      `https://aivybots.com/api/chat?prompt=${encodeURIComponent(
                        q
                      )}`,
                      {
                        timeout: 20000,
                      }
                    )

                  return reply(
                    `✨ *AI:*\n${
                      r2.data
                        ?.response ||
                      "No response."
                    }`
                  )
                } catch {
                  return reply(
                    T(
                      from,
                      "noAI"
                    )
                  )
                }
              }
            }

            // =================================================
            // GOOGLE
            // =================================================

            case "google":
              return reply(
                `🔎 *Google:*\nhttps://www.google.com/search?q=${encodeURIComponent(
                  q
                )}`
              )

            // =================================================
            // JW
            // =================================================

            case "jw":
              return reply(
                `📖 *JW:*\nhttps://www.jw.org/pt/pesquisar/?q=${encodeURIComponent(
                  q
                )}`
              )

            // =================================================
            // PLAY / YOUTUBE SEARCH
            // =================================================

            case "play": {
              if (!q) {
                return reply(
                  T(
                    from,
                    "musicName"
                  )
                )
              }

              await reply(
                T(
                  from,
                  "searching"
                )
              )

              try {
                const search =
                  await ytSearch(q)

                const v =
                  search
                    .videos?.[0]

                if (!v) {
                  return reply(
                    T(
                      from,
                      "nothing"
                    )
                  )
                }

                return sock.sendMessage(
                  from,
                  {
                    image: {
                      url:
                        v.thumbnail,
                    },

                    caption:
                      `🎵 *${v.title}*\n` +
                      `⏱️ ${v.timestamp}\n` +
                      `👀 ${v.views.toLocaleString()} views\n` +
                      `👤 ${v.author.name}\n` +
                      `🔗 ${v.url}`,
                  },
                  {
                    quoted: m,
                  }
                )
              } catch {
                return reply(
                  T(
                    from,
                    "searchError"
                  )
                )
              }
            }

            // =================================================
            // BAN
            // =================================================

            case "ban": {
              if (
                !isGroup ||
                !admin ||
                !botAdmin
              ) {
                return reply(
                  T(
                    from,
                    "adminBot"
                  )
                )
              }

              if (!mention) {
                return reply(
                  T(
                    from,
                    "noMention"
                  )
                )
              }

              try {
                await sock.groupParticipantsUpdate(
                  from,
                  [mention],
                  "remove"
                )
              } catch (e) {
                return reply(
                  `❌ ${
                    e.message ||
                    "Unable to remove user."
                  }`
                )
              }

              return reply(
                T(
                  from,
                  "removed",
                  mention
                )
              )
            }

            // =================================================
            // PROMOTE / DEMOTE
            // =================================================

            case "promover":
            case "rebaixar": {
              if (
                !isGroup ||
                !admin ||
                !botAdmin
              ) {
                return reply(
                  T(
                    from,
                    "adminBot"
                  )
                )
              }

              if (!mention) {
                return reply(
                  T(
                    from,
                    "noMention"
                  )
                )
              }

              const action =
                command ===
                "promover"
                  ? "promote"
                  : "demote"

              try {
                await sock.groupParticipantsUpdate(
                  from,
                  [mention],
                  action
                )
              } catch (e) {
                return reply(
                  `❌ ${
                    e.message ||
                    "Action failed."
                  }`
                )
              }

              return reply(
                command ===
                  "promover"
                  ? T(
                      from,
                      "promoted"
                    )
                  : T(
                      from,
                      "demoted"
                    )
              )
            }

            // =================================================
            // DELETE MESSAGE
            // =================================================

            case "apagar": {
              if (
                !isGroup ||
                !admin ||
                !botAdmin
              ) {
                return reply(
                  T(
                    from,
                    "adminBot"
                  )
                )
              }

              const quoted =
                getQuoted(m)

              if (
                !quoted?.stanzaId
              ) {
                return reply(
                  T(
                    from,
                    "replyDelete"
                  )
                )
              }

              try {
                await sock.sendMessage(
                  from,
                  {
                    delete: {
                      remoteJid:
                        from,
                      fromMe:
                        false,
                      id:
                        quoted.stanzaId,
                      participant:
                        quoted.participant,
                    },
                  }
                )
              } catch (e) {
                return reply(
                  `❌ ${
                    e.message ||
                    "Could not delete the message."
                  }`
                )
              }

              return
            }

            // =================================================
            // MUTE GROUP
            // =================================================

            case "silenciar": {
              if (
                !isGroup ||
                !admin ||
                !botAdmin
              ) {
                return reply(
                  T(
                    from,
                    "adminBot"
                  )
                )
              }

              try {
                await sock.groupSettingUpdate(
                  from,
                  "announcement"
                )
              } catch (e) {
                return reply(
                  `❌ ${
                    e.message ||
                    "Could not mute group."
                  }`
                )
              }

              ensureGroup(
                from
              ).mute = true

              saveDB()

              return reply(
                T(
                  from,
                  "muted"
                )
              )
            }

            // =================================================
            // OPEN GROUP
            // =================================================

            case "falar": {
              if (
                !isGroup ||
                !admin ||
                !botAdmin
              ) {
                return reply(
                  T(
                    from,
                    "adminBot"
                  )
                )
              }

              try {
                await sock.groupSettingUpdate(
                  from,
                  "not_announcement"
                )
              } catch (e) {
                return reply(
                  `❌ ${
                    e.message ||
                    "Could not open group."
                  }`
                )
              }

              ensureGroup(
                from
              ).mute = false

              saveDB()

              return reply(
                T(
                  from,
                  "opened"
                )
              )
            }

            // =================================================
            // SET RULES
            // =================================================

            case "setregras": {
              if (
                !isGroup ||
                !admin
              ) {
                return reply(
                  T(
                    from,
                    "adminOnly"
                  )
                )
              }

              ensureGroup(
                from
              ).regras =
                q ||
                (
                  groupLanguage(
                    from
                  ) === "pt"
                    ? "Sem regras."
                    : "No rules defined."
                )

              saveDB()

              return reply(
                T(
                  from,
                  "rulesUpdated"
                )
              )
            }

            // =================================================
            // RULES
            // =================================================

            case "regras": {
              const g =
                ensureGroup(from)

              const title =
                groupLanguage(
                  from
                ) === "pt"
                  ? "📜 *REGRAS DO GRUPO*"
                  : "📜 *GROUP RULES*"

              return reply(
                `${title}\n\n${
                  g.regras ||
                  T(
                    from,
                    "noRules"
                  )
                }`
              )
            }

            // =================================================
            // ANTI-LINK
            // =================================================

            case "antilink": {
              if (
                !isGroup ||
                !admin
              ) {
                return reply(
                  T(
                    from,
                    "adminOnly"
                  )
                )
              }

              const value =
                q
                  .toLowerCase()
                  .trim()

              if (
                ![
                  "on",
                  "1",
                  "sim",
                  "yes",
                  "true",
                ].includes(
                  value
                ) &&
                ![
                  "off",
                  "0",
                  "não",
                  "nao",
                  "no",
                  "false",
                ].includes(
                  value
                )
              ) {
                return reply(
                  groupLanguage(
                    from
                  ) === "pt"
                    ? `Use: ${PREFIX}antilink on ou ${PREFIX}antilink off`
                    : `Use: ${PREFIX}antilink on or ${PREFIX}antilink off`
                )
              }

              ensureGroup(
                from
              ).antiLink =
                [
                  "on",
                  "1",
                  "sim",
                  "yes",
                  "true",
                ].includes(
                  value
                )

              saveDB()

              return reply(
                T(
                  from,
                  "antiLink",
                  ensureGroup(
                    from
                  ).antiLink
                )
              )
            }

            // =================================================
            // ANTI-BADWORD
            // =================================================

            case "antipalavrao": {
              if (
                !isGroup ||
                !admin
              ) {
                return reply(
                  T(
                    from,
                    "adminOnly"
                  )
                )
              }

              const value =
                q
                  .toLowerCase()
                  .trim()

              if (
                ![
                  "on",
                  "1",
                  "sim",
                  "yes",
                  "true",
                  "off",
                  "0",
                  "não",
                  "nao",
                  "no",
                  "false",
                ].includes(
                  value
                )
              ) {
                return reply(
                  groupLanguage(
                    from
                  ) === "pt"
                    ? `Use: ${PREFIX}antipalavrao on ou ${PREFIX}antipalavrao off`
                    : `Use: ${PREFIX}antipalavrao on or ${PREFIX}antipalavrao off`
                )
              }

              ensureGroup(
                from
              ).antiPalavrao =
                [
                  "on",
                  "1",
                  "sim",
                  "yes",
                  "true",
                ].includes(
                  value
                )

              saveDB()

              return reply(
                T(
                  from,
                  "antiBadword",
                  ensureGroup(
                    from
                  ).antiPalavrao
                )
              )
            }

            // =================================================
            // WELCOME
            // =================================================

            case "boasvindas": {
              if (
                !isGroup ||
                !admin
              ) {
                return reply(
                  T(
                    from,
                    "adminOnly"
                  )
                )
              }

              const value =
                q
                  .toLowerCase()
                  .trim()

              if (
                ![
                  "on",
                  "1",
                  "sim",
                  "yes",
                  "true",
                  "off",
                  "0",
                  "não",
                  "nao",
                  "no",
                  "false",
                ].includes(
                  value
                )
              ) {
                return reply(
                  groupLanguage(
                    from
                  ) === "pt"
                    ? `Use: ${PREFIX}boasvindas on ou ${PREFIX}boasvindas off`
                    : `Use: ${PREFIX}boasvindas on or ${PREFIX}boasvindas off`
                )
              }

              ensureGroup(
                from
              ).boasVindas =
                [
                  "on",
                  "1",
                  "sim",
                  "yes",
                  "true",
                ].includes(
                  value
                )

              saveDB()

              return reply(
                T(
                  from,
                  "welcome",
                  ensureGroup(
                    from
                  ).boasVindas
                )
              )
            }

            // =================================================
            // WARNING
            // =================================================

            case "aviso": {
              if (
                !isGroup ||
                !admin
              ) {
                return reply(
                  T(
                    from,
                    "adminOnly"
                  )
                )
              }

              if (!mention) {
                return reply(
                  T(
                    from,
                    "noMention"
                  )
                )
              }

              const reason =
                q.replace(
                  /^\S+\s*/,
                  ""
                ) ||
                (
                  groupLanguage(
                    from
                  ) === "pt"
                    ? "Advertência do Admin"
                    : "Admin warning"
                )

              return addWarning(
                from,
                mention,
                reason,
                reply
              )
            }

            // =================================================
            // WARNINGS LIST
            // =================================================

            case "avisos": {
              if (!isGroup) {
                return reply(
                  T(
                    from,
                    "onlyGroup"
                  )
                )
              }

              const entries =
                Object.entries(
                  ensureGroup(
                    from
                  ).avisos
                )

              if (
                !entries.length
              ) {
                return reply(
                  T(
                    from,
                    "noWarnings"
                  )
                )
              }

              const title =
                groupLanguage(
                  from
                ) === "pt"
                  ? "⚠️ *AVISOS*"
                  : "⚠️ *WARNINGS*"

              return reply(
                title +
                  "\n\n" +
                  entries
                    .map(
                      ([
                        user,
                        number,
                      ]) =>
                        `@${jidDisplay(
                          user
                        )} — ${number}/3`
                    )
                    .join(
                      "\n"
                    )
              )
            }

            // =================================================
            // SCHEDULE MESSAGE
            // =================================================

            case "agendar": {
              if (
                !isGroup ||
                !admin
              ) {
                return reply(
                  T(
                    from,
                    "scheduleAdmin"
                  )
                )
              }

              const time =
                parts[1]

              const text =
                parts
                  .slice(2)
                  .join(" ")

              if (
                !/^\d{1,2}:\d{2}$/.test(
                  time
                ) ||
                !text
              ) {
                return reply(
                  T(
                    from,
                    "scheduleUse",
                    PREFIX
                  )
                )
              }

              try {
                const item =
                  scheduleMessage(
                    from,
                    text,
                    time
                  )

                return reply(
                  T(
                    from,
                    "scheduleOk",
                    item.id,
                    time,
                    TZ
                  )
                )
              } catch (e) {
                return reply(
                  `❌ ${
                    e.message ||
                    "Could not schedule message."
                  }`
                )
              }
            }

            // =================================================
            // SCHEDULE LIST
            // =================================================

            case "agenda": {
              const list =
                db.schedules.filter(
                  item =>
                    item.jid ===
                      from &&
                    [
                      "pending",
                      "sending",
                    ].includes(
                      item.status
                    )
                )

              if (!list.length) {
                return reply(
                  T(
                    from,
                    "noSchedule"
                  )
                )
              }

              const title =
                groupLanguage(
                  from
                ) === "pt"
                  ? "📅 *AGENDAMENTOS*"
                  : "📅 *SCHEDULES*"

              return reply(
                title +
                  "\n\n" +
                  list
                    .map(
                      item =>
                        `• ${item.id}\n  🕒 ${item.time}\n  📝 ${item.text.slice(
                          0,
                          120
                        )}`
                    )
                    .join(
                      "\n\n"
                    )
              )
            }

            // =================================================
            // CANCEL SCHEDULE
            // =================================================

            case "cancelar": {
              if (
                !isGroup ||
                !admin
              ) {
                return reply(
                  T(
                    from,
                    "adminOnly"
                  )
                )
              }

              const item =
                db.schedules.find(
                  x =>
                    x.id === q &&
                    x.jid === from &&
                    x.status ===
                      "pending"
                )

              if (!item) {
                return reply(
                  T(
                    from,
                    "scheduleNotFound"
                  )
                )
              }

              item.status =
                "cancelled"

              item.cancelledAt =
                new Date().toISOString()

              saveDB()

              return reply(
                T(
                  from,
                  "scheduleCancelled"
                )
              )
            }

            // =================================================
            // DEFAULT
            // =================================================

            default:
              return reply(
                T(
                  from,
                  "unknown",
                  PREFIX
                )
              )
          }
        } catch (e) {
          console.error(
            "message:",
            e
          )
        }
      }
    )
  } catch (e) {
    console.error(
      "startBot:",
      e
    )

    lastError =
      e.message

    // Retry without deleting
    // the authentication directory.

    setTimeout(
      startBot,
      5000
    )
  } finally {
    reconnecting = false
  }
}

// ============================================================
// WEB DASHBOARD
// ============================================================

function dashboard() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">

<title>${esc(BOT_NAME)} — Dashboard</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, Helvetica, sans-serif;
  background: #07110f;
  color: #eaf5f0;
}

header {
  padding: 22px;
  border-bottom: 1px solid #18332d;
  background: #0a1714;
}

header h1 {
  margin: 0 0 5px;
  font-size: 25px;
}

header p {
  margin: 0;
  opacity: .7;
}

.wrap {
  max-width: 1250px;
  margin: auto;
  padding: 20px;
}

.tabs {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

button {
  border: 0;
  padding: 11px 16px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 700;
}

button.secondary {
  background: #18332d;
  color: #fff;
}

button.danger {
  background: #631f28;
  color: #fff;
}

button.primary {
  background: #16734e;
  color: #fff;
}

.card {
  background: #0c1d18;
  border: 1px solid #18332d;
  border-radius: 13px;
  padding: 18px;
  margin-bottom: 18px;
}

.card h2 {
  margin-top: 0;
}

.grid {
  display: grid;
  grid-template-columns: repeat(
    auto-fit,
    minmax(280px, 1fr)
  );
  gap: 18px;
}

.hidden {
  display: none;
}

.ok {
  font-weight: 700;
}

.bad {
  font-weight: 700;
}

.muted {
  opacity: .65;
}

.qr {
  max-width: 360px;
  width: 100%;
  background: #fff;
  padding: 10px;
  border-radius: 10px;
}

.group {
  border: 1px solid #18332d;
  padding: 15px;
  border-radius: 10px;
  margin-bottom: 10px;
}

.group .top,
.sched .top {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.pill {
  padding: 4px 8px;
  border-radius: 20px;
  background: #18332d;
  font-size: 12px;
}

label {
  display: block;
  margin-bottom: 12px;
}

input,
textarea,
select {
  width: 100%;
  padding: 11px;
  margin-top: 6px;
  border-radius: 7px;
  border: 1px solid #29483f;
  background: #07110f;
  color: #fff;
}

.sched {
  border: 1px solid #18332d;
  padding: 13px;
  border-radius: 10px;
  margin-bottom: 10px;
}

.hint {
  opacity: .65;
  font-size: 13px;
}

</style>
</head>

<body>

<header>
  <h1>🤖 ${esc(BOT_NAME)}</h1>
  <p>Professional WhatsApp Management Dashboard</p>
</header>

<div class="wrap">

<div class="tabs">
  <button class="primary"
    onclick="show('connection')">
    Connection
  </button>

  <button class="secondary"
    onclick="show('groups')">
    Groups
  </button>

  <button class="secondary"
    onclick="show('schedule')">
    Scheduling
  </button>

  <button class="secondary"
    onclick="load()">
    Refresh
  </button>
</div>

<section id="connection">

<div class="grid">

<div class="card">
<h2>WhatsApp</h2>

<div id="conn">
Loading...
</div>

<br>

<div id="connectionText">
Loading...
</div>

<br>

<img
  id="qr"
  class="qr"
  style="display:none"
  alt="WhatsApp QR"
/>

</div>

<div class="card">
<h2>System</h2>

<p>
Bot:
<strong>
${esc(BOT_NAME)}
</strong>
</p>

<p>
Timezone:
<strong>
${esc(TZ)}
</strong>
</p>

<p>
Session:
<strong>
Persistent
</strong>
</p>

<p>
Language:
<strong>
English / Portuguese
</strong>
</p>

</div>

</div>

</section>

<section
  id="groups"
  class="hidden">

<div class="card">

<h2>Groups</h2>

<div id="groupsList">
Loading...
</div>

</div>

</section>

<section
  id="schedule"
  class="hidden">

<div class="grid">

<div class="card">

<h2>New Scheduled Message</h2>

<form
  onsubmit="schedule(event)">

<label>
Group

<select
  id="scheduleGroup"
  required>
</select>

</label>

<label>
Time

<input
  id="time"
  type="time"
  required>

</label>

<label>
Message

<textarea
  id="message"
  rows="7"
  required></textarea>

</label>

<div class="hint">
Timezone:
${esc(TZ)}
</div>

<br>

<button class="primary">
Schedule Message
</button>

</form>

</div>

<div class="card">

<h2>Message Queue</h2>

<div id="schedules">
Loading...
</div>

</div>

</div>

</section>

</div>

<script>

let groups = [];

function $(id) {
  return document.getElementById(id);
}

async function api(
  url,
  options = {}
) {
  const response =
    await fetch(
      url,
      options
    );

  if (!response.ok) {
    throw new Error(
      await response.text()
    );
  }

  return response.json();
}

function show(id) {

  [
    "connection",
    "groups",
    "schedule"
  ].forEach(x => {

    $(x).classList.toggle(
      "hidden",
      x !== id
    );

  });

  load();
}

async function load() {

  try {

    const status =
      await api(
        "/api/status"
      );

    $("conn").innerHTML =
      status.connected
        ? '<span class="ok">● CONNECTED</span>'
        : '<span class="bad">● ' +
          status.state.toUpperCase() +
          '</span>';

    $("connectionText")
      .innerHTML =
      "<b>" +
      (
        status.connected
          ? "🟢 WhatsApp connected"
          : "🟡 Waiting for connection"
      ) +
      "</b><br>" +
      "<span class='muted'>" +
      (
        status.user ||
        "No active session"
      ) +
      "</span>";

    $("qr").style.display =
      status.qr
        ? "block"
        : "none";

    if (status.qr) {
      $("qr").src =
        "/qr.png?t=" +
        Date.now();
    }

    groups =
      await api(
        "/api/groups"
      );

    renderGroups();

    renderSelects();

    const schedules =
      await api(
        "/api/schedules"
      );

    renderSchedules(
      schedules
    );

  } catch (e) {

    console.error(e);

  }
}

function renderSelects() {

  const options =
    groups
      .map(
        g =>
          '<option value="' +
          g.jid +
          '">' +
          esc(g.subject) +
          "</option>"
      )
      .join("");

  $("scheduleGroup")
    .innerHTML =
    options;
}

function renderGroups() {

  if (!groups.length) {

    $("groupsList")
      .innerHTML =
      "No groups available.";

    return;

  }

  $("groupsList")
    .innerHTML =
    groups
      .map(
        g => `
<div class="group">

<div class="top">

<strong>
${esc(g.subject)}
</strong>

<span class="pill">
${g.participants} members
</span>

</div>

<p>
ID:
${esc(g.jid)}
</p>

<p>
Anti-link:
<strong>
${g.antiLink ? "ON" : "OFF"}
</strong>
</p>

<p>
Anti-badword:
<strong>
${g.antiPalavrao ? "ON" : "OFF"}
</strong>
</p>

<p>
Welcome:
<strong>
${g.boasVindas ? "ON" : "OFF"}
</strong>
</p>

<button
class="primary"
onclick="toggleGroup(
'${encodeURIComponent(g.jid)}'
)">
Manage
</button>

</div>
`
      )
      .join("");
}

async function toggleGroup(
  encoded
) {

  const jid =
    decodeURIComponent(
      encoded
    );

  const current =
    await api(
      "/api/groups/" +
      encodeURIComponent(
        jid
      )
    );

  const antiLink =
    !current.antiLink;

  await api(
    "/api/groups/" +
    encodeURIComponent(
      jid
    ),
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        antiLink
      })
    }
  );

  load();
}

async function schedule(
  event
) {

  event.preventDefault();

  await api(
    "/api/schedules",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        jid:
          $("scheduleGroup")
            .value,

        time:
          $("time").value,

        text:
          $("message").value
      })
    }
  );

  $("message").value = "";

  alert(
    "Message scheduled."
  );

  load();
}

function renderSchedules(
  list
) {

  if (!list.length) {

    $("schedules")
      .innerHTML =
      "No scheduled messages.";

    return;

  }

  $("schedules")
    .innerHTML =
    list
      .map(
        x => `
<div class="sched">

<div class="top">

<b>
${esc(x.time)}
</b>

<span class="pill">
${esc(x.status)}
</span>

</div>

<p>
${esc(x.text)}
</p>

<small>
${esc(x.jid)}
<br>
ID:
${esc(x.id)}
</small>

${
  x.status === "pending"
    ? `
<br><br>
<button
class="danger"
onclick="cancelSchedule(
'${encodeURIComponent(x.id)}'
)">
Cancel
</button>
`
    : ""
}

</div>
`
      )
      .join("");
}

async function cancelSchedule(
  encoded
) {

  const id =
    decodeURIComponent(
      encoded
    );

  await api(
    "/api/schedules/" +
    encodeURIComponent(id),
    {
      method: "DELETE"
    }
  );

  load();
}

function esc(value) {

  return String(
    value ?? ""
  ).replace(
    /[&<>\"]/g,
    x =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;"
      }[x])
  );

}

load();

setInterval(
  load,
  10000
);

</script>

</body>
</html>`
}

// ============================================================
// HTTP SERVER
// ============================================================

const server =
  http.createServer(
    async (req, res) => {

      const url =
        new URL(
          req.url,
          `http://${
            req.headers.host ||
            "localhost"
          }`
        )

      // ======================================================
      // QR
      // ======================================================

      if (
        url.pathname ===
        "/qr.png"
      ) {

        if (!currentQR) {

          res.writeHead(
            404,
            {
              "Content-Type":
                "text/plain; charset=utf-8",
            }
          )

          return res.end(
            "QR unavailable"
          )
        }

        try {

          const buffer =
            await QRCode.toBuffer(
              currentQR,
              {
                type: "png",
                width: 360,
                margin: 2,
              }
            )

          res.writeHead(
            200,
            {
              "Content-Type":
                "image/png",

              "Cache-Control":
                "no-store",
            }
          )

          return res.end(
            buffer
          )

        } catch {

          res.writeHead(
            500
          )

          return res.end(
            "QR error"
          )
        }
      }

      // ======================================================
      // HEALTH
      // ======================================================

      if (
        url.pathname ===
        "/health"
      ) {

        return json(
          res,
          200,
          {
            ok: true,
            connected:
              isConnected,
            state:
              connectionState,
          }
        )
      }

      // ======================================================
      // DASHBOARD
      // ======================================================

      if (
        url.pathname === "/" ||
        url.pathname ===
          "/panel"
      ) {

        if (
          !authorized(req)
        ) {

          return json(
            res,
            401,
            {
              error:
                EN.unauthorized,
            }
          )
        }

        return sendHtml(
          res,
          dashboard()
        )
      }

      // ======================================================
      // API AUTH
      // ======================================================

      if (
        !authorized(req)
      ) {

        return json(
          res,
          401,
          {
            error:
              EN.unauthorized,
          }
        )
      }

      // ======================================================
      // STATUS
      // ======================================================

      if (
        url.pathname ===
          "/api/status" &&
        req.method === "GET"
      ) {

        return json(
          res,
          200,
          {
            connected:
              isConnected,

            state:
              connectionState,

            qr:
              !!currentQR,

            user:
              sock?.user?.id ||
              null,

            bot:
              BOT_NAME,

            timezone:
              TZ,

            connectedAt,

            lastError,
          }
        )
      }

      // ======================================================
      // GROUP LIST
      // ======================================================

      if (
        url.pathname ===
          "/api/groups" &&
        req.method === "GET"
      ) {

        try {

          if (
            !sock ||
            !isConnected
          ) {
            return json(
              res,
              200,
              []
            )
          }

          const groups =
            await sock.groupFetchAllParticipating()

          const output =
            Object.values(
              groups
            ).map(g => {

              const settings =
                ensureGroup(
                  g.id
                )

              return {
                jid:
                  g.id,

                subject:
                  g.subject ||
                  g.id,

                participants:
                  g.participants
                    ?.length ||
                  0,

                antiLink:
                  settings.antiLink,

                antiPalavrao:
                  settings.antiPalavrao,

                boasVindas:
                  settings.boasVindas,

                language:
                  settings.language,
              }

            })

          output.sort(
            (a, b) =>
              a.subject.localeCompare(
                b.subject
              )
          )

          return json(
            res,
            200,
            output
          )

        } catch (e) {

          return json(
            res,
            500,
            {
              error:
                e.message,
            }
          )
        }
      }

      // ======================================================
      // SINGLE GROUP
      // ======================================================

      if (
        url.pathname.startsWith(
          "/api/groups/"
        ) &&
        req.method === "GET"
      ) {

        const gid =
          decodeURIComponent(
            url.pathname.slice(
              "/api/groups/"
                .length
            )
          )

        if (
          !gid.endsWith(
            "@g.us"
          )
        ) {

          return json(
            res,
            400,
            {
              error:
                EN.invalidGroup,
            }
          )
        }

        return json(
          res,
          200,
          ensureGroup(gid)
        )
      }

      // ======================================================
      // UPDATE GROUP
      // ======================================================

      if (
        url.pathname.startsWith(
          "/api/groups/"
        ) &&
        req.method === "POST"
      ) {

        const gid =
          decodeURIComponent(
            url.pathname.slice(
              "/api/groups/"
                .length
            )
          )

        if (
          !gid.endsWith(
            "@g.us"
          )
        ) {

          return json(
            res,
            400,
            {
              error:
                EN.invalidGroup,
            }
          )
        }

        const body =
          await parseBody(req)

        if (!body) {

          return json(
            res,
            400,
            {
              error:
                "Invalid JSON",
            }
          )
        }

        const g =
          ensureGroup(
            gid
          )

        if (
          typeof body.antiLink ===
          "boolean"
        ) {
          g.antiLink =
            body.antiLink
        }

        if (
          typeof body.antiPalavrao ===
          "boolean"
        ) {
          g.antiPalavrao =
            body.antiPalavrao
        }

        if (
          typeof body.boasVindas ===
          "boolean"
        ) {
          g.boasVindas =
            body.boasVindas
        }

        if (
          typeof body.regras ===
          "string"
        ) {
          g.regras =
            body.regras.slice(
              0,
              5000
            )
        }

        if (
          body.language ===
            "en" ||
          body.language ===
            "pt"
        ) {
          g.language =
            body.language
        }

        if (
          typeof body.welcomeText ===
          "string"
        ) {
          g.welcomeText =
            body.welcomeText.slice(
              0,
              5000
            )
        }

        if (
          typeof body.goodbyeText ===
          "string"
        ) {
          g.goodbyeText =
            body.goodbyeText.slice(
              0,
              5000
            )
        }

        saveDB()

        return json(
          res,
          200,
          {
            ok: true,
            group: g,
          }
        )
      }

      // ======================================================
      // SCHEDULE LIST
      // ======================================================

      if (
        url.pathname ===
          "/api/schedules" &&
        req.method === "GET"
      ) {

        return json(
          res,
          200,
          db.schedules
            .slice()
            .sort(
              (a, b) =>
                new Date(
                  a.sendAt
                ) -
                new Date(
                  b.sendAt
                )
            )
        )
      }

      // ======================================================
      // CREATE SCHEDULE
      // ======================================================

      if (
        url.pathname ===
          "/api/schedules" &&
        req.method === "POST"
      ) {

        const body =
          await parseBody(req)

        if (
          !body?.jid ||
          !body?.text ||
          !body?.time
        ) {

          return json(
            res,
            400,
            {
              error:
                "jid, text and time are required",
            }
          )
        }

        if (
          !String(
            body.jid
          ).endsWith(
            "@g.us"
          )
        ) {

          return json(
            res,
            400,
            {
              error:
                EN.groupOnlyDestination,
            }
          )
        }

        try {

          const item =
            scheduleMessage(
              body.jid,
              String(
                body.text
              ).slice(
                0,
                10000
              ),
              body.time
            )

          return json(
            res,
            201,
            item
          )

        } catch (e) {

          return json(
            res,
            400,
            {
              error:
                e.message,
            }
          )
        }
      }

      // ======================================================
      // DELETE SCHEDULE
      // ======================================================

      if (
        url.pathname.startsWith(
          "/api/schedules/"
        ) &&
        req.method === "DELETE"
      ) {

        const id =
          decodeURIComponent(
            url.pathname.slice(
              "/api/schedules/"
                .length
            )
          )

        const item =
          db.schedules.find(
            x =>
              x.id === id
          )

        if (!item) {

          return json(
            res,
            404,
            {
              error:
                "Schedule not found",
            }
          )
        }

        if (
          item.status !==
          "pending"
        ) {

          return json(
            res,
            409,
            {
              error:
                "Schedule already processed",
            }
          )
        }

        item.status =
          "cancelled"

        item.cancelledAt =
          new Date().toISOString()

        saveDB()

        return json(
          res,
          200,
          {
            ok: true,
          }
        )
      }

      // ======================================================
      // 404
      // ======================================================

      return json(
        res,
        404,
        {
          error:
            EN.routeNotFound,
        }
      )
    }
  )

// ============================================================
// SERVER START
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `🌐 Dashboard: http://0.0.0.0:${PORT}/`
    )

    console.log(
      `🕒 Scheduling timezone: ${TZ}`
    )

    if (ADMIN_TOKEN) {
      console.log(
        "🔐 Dashboard protected by ADMIN_TOKEN"
      )
    } else {
      console.log(
        "⚠️ ADMIN_TOKEN is not defined. Dashboard has no authentication."
      )
    }
  }
)

// ============================================================
// START BOT
// ============================================================

startBot()

// ============================================================
// SAFE PROCESS SHUTDOWN
// ============================================================

process.on(
  "SIGTERM",
  () => {

    try {
      server.close()
    } finally {
      process.exit(0)
    }
  }
)

process.on(
  "SIGINT",
  () => {

    try {
      server.close()
    } finally {
      process.exit(0)
    }
  }
)
