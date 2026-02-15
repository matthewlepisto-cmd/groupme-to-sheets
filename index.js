import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json({ limit: "1mb" }));

const SPREADSHEET_ID =
  process.env.SPREADSHEET_ID || "1xT7jHcFOVIkkcljwtyDj9NlNIP8S7pn9qVNDna7wuEw";
const SHEET_NAME = process.env.SHEET_NAME || "Import";
const GOOGLE_CREDS_JSON = process.env.GOOGLE_CREDS_JSON;

// MAIN bot (posts to main group)
const GROUPME_BOT_ID =
  process.env.GROUPME_BOT_ID || "08d51442da9b9a749a7e6bd04d";

// COMMAND bot (admin group only)
const COMMAND_GROUP_ID = "110916855";
const COMMAND_BOT_ID = "0cb4eb2388c240e337b026610a";

// Unified 2026 tab source + ranges
const LEADERBOARD_2026_TAB = "2026 LeaderBoard";
const RANGE_LEADERBOARD = `${LEADERBOARD_2026_TAB}!I1:J27`;
const RANGE_WINS = `${LEADERBOARD_2026_TAB}!K1:L27`;
const RANGE_CROWN_JEWEL = `${LEADERBOARD_2026_TAB}!M1:N27`;
const RANGE_TOP10S = `${LEADERBOARD_2026_TAB}!O1:P27`;
const RANGE_TOP5S = `${LEADERBOARD_2026_TAB}!Q1:R27`;
const RANGE_AVG_FINISH = `${LEADERBOARD_2026_TAB}!S1:T27`;

if (!SPREADSHEET_ID || !GOOGLE_CREDS_JSON) {
  console.error("Missing env vars: SPREADSHEET_ID and/or GOOGLE_CREDS_JSON");
  process.exit(1);
}

const startedAt = Date.now();

function getSheetsClient() {
  const creds = JSON.parse(GOOGLE_CREDS_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function appendRow(row) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

app.get("/", (req, res) => res.status(200).send("OK"));

/**
 * =========================
 * Help text
 * =========================
 */
function getHelpText(isCommandGroup) {
  const common =
    "Commands:\n" +
    "• help\n" +
    "• board update\n" +
    "• wins\n" +
    "• crown jewel\n" +
    "• top 10s\n" +
    "• top 5s\n" +
    "• avg finish\n" +
    "• #<number> (example: #2)\n";

  if (isCommandGroup) {
    return (
      "🤖 Command Bot Help\n\n" +
      "• run_results\n" +
      "Admin commands:\n" +
      "• admin help\n" +
      "• admin status\n" +
      "• admin lock picks\n" +
      "• admin unlock picks\n" +
      "• admin rebuild leaderboard\n" +
      "• admin clear import\n" +
      "• admin reset crown jewel\n" +
      "• admin set poll 30000\n\n" +
      "Announce:\n" +
      "• announce <msg>\n" +
      "• announce main <msg>\n" +
      "• announce command <msg>\n" +
      "• announce both <msg>\n\n" +
      "Main commands (also work here):\n" +
      common
    );
  }

  return (
    "🏁 Bot Help\n\n" +
    common +
    "\nNote: Admin commands are only available in the command group."
  );
}

/**
 * =========================
 * Settings helpers (Sheets)
 * =========================
 */
const SETTINGS_SHEET = process.env.SETTINGS_SHEET || "Settings";

async function getSetting(key) {
  const sheets = getSheetsClient();
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SETTINGS_SHEET}!A:B`,
    });

    const rows = resp.data.values || [];
    const k = (key ?? "").toString().trim().toUpperCase();

    for (const r of rows) {
      const kk = (r?.[0] ?? "").toString().trim().toUpperCase();
      if (kk === k) return (r?.[1] ?? "").toString().trim();
    }
    return null;
  } catch {
    return null;
  }
}

async function setSetting(key, value) {
  const sheets = getSheetsClient();
  const k = (key ?? "").toString().trim().toUpperCase();
  const v = (value ?? "").toString().trim();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SETTINGS_SHEET}!A:B`,
  });
  const rows = resp.data.values || [];

  let rowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const kk = (rows[i]?.[0] ?? "").toString().trim().toUpperCase();
    if (kk === k) {
      rowIndex = i + 1; // 1-based
      break;
    }
  }

  if (rowIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SETTINGS_SHEET}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[k, v]] },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SETTINGS_SHEET}!A${rowIndex}:B${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[k, v]] },
    });
  }
}

async function isPicksLocked() {
  const v = await getSetting("LOCK_PICKS");
  if (!v) return false;
  return ["TRUE", "YES", "1", "ON", "LOCKED"].includes(
    v.toString().trim().toUpperCase()
  );
}

/**
 * =========================
 * Driver Count lookup
 * =========================
 */
async function getDriverCountForPick(senderName, pickToken) {
  const sheets = getSheetsClient();
  const range = `Driver Count!A1:ZZ2000`;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const values = resp.data.values || [];
  if (values.length < 4) return null;

  const row1 = values[0] || [];
  const row3 = values[2] || [];

  const norm = (v) => (v ?? "").toString().trim();
  const normLower = (v) => norm(v).toLowerCase();

  const sender = norm(senderName);
  if (!sender) return null;

  let driverCol = -1;
  let countCol = -1;

  for (let c = 0; c < Math.max(row1.length, row3.length); c++) {
    const nameAtC = norm(row1[c]);
    if (nameAtC !== sender) continue;

    const label = normLower(row3[c]);
    if (label === "driver") driverCol = c;
    if (label === "count") countCol = c;
  }

  if (driverCol === -1 || countCol === -1) return null;

  const pick = norm(pickToken);

  for (let r = 3; r < values.length; r++) {
    const row = values[r] || [];
    const driverVal = norm(row[driverCol]);
    if (driverVal === pick) {
      const countVal = norm(row[countCol]);
      return countVal || null;
    }
  }

  return null;
}

// Retry helper for formula recalculation
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getDriverCountForPickWithRetry(
  senderName,
  pickToken,
  tries = 6,
  delayMs = 700
) {
  for (let i = 0; i < tries; i++) {
    const count = await getDriverCountForPick(senderName, pickToken);
    if (count !== null && count !== undefined && String(count).trim() !== "") {
      return String(count).trim();
    }
    await sleep(delayMs);
  }
  return null;
}

/**
 * =========================
 * Leaderboard block reader
 * =========================
 */
async function buildTwoColMessage({ title, rangeA1 }) {
  const sheets = getSheetsClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: rangeA1,
  });

  const values = resp.data.values || [];
  if (values.length < 2) return `${title}\n(no data)`;

  const rows = values.slice(1); // skip header row

  const lines = rows
    .filter((r) => (r?.[0] ?? "").toString().trim() !== "")
    .map((r, i) => {
      const name = (r?.[0] ?? "").toString().trim();
      const val = (r?.[1] ?? "").toString().trim();
      return `${String(i + 1).padStart(2, " ")}. ${name} — ${val}`;
    });

  return `${title}\n` + lines.join("\n");
}

async function buildLeaderboardMessage() {
  return buildTwoColMessage({ title: "🏁 Leaderboard", rangeA1: RANGE_LEADERBOARD });
}

async function buildWinsMessage() {
  return buildTwoColMessage({ title: "🏆 Wins", rangeA1: RANGE_WINS });
}

async function buildCrownJewelMessage() {
  return buildTwoColMessage({
    title: "👑 Crown Jewel Standings",
    rangeA1: RANGE_CROWN_JEWEL,
  });
}

async function buildTop10sMessage() {
  return buildTwoColMessage({ title: "🔟 Top 10s", rangeA1: RANGE_TOP10S });
}

async function buildTop5sMessage() {
  return buildTwoColMessage({ title: "🖐️ Top 5s", rangeA1: RANGE_TOP5S });
}

async function buildAvgFinishMessage() {
  return buildTwoColMessage({ title: "📊 Avg Finish", rangeA1: RANGE_AVG_FINISH });
}

/**
 * =========================
 * GroupMe posting
 * =========================
 */
function chunkText(text, maxLen) {
  if (!text || text.length <= maxLen) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    const lastNl = text.lastIndexOf("\n", end);
    if (lastNl > start + 50) end = lastNl;

    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

async function postToGroupMe(text, botId) {
  const url = "https://api.groupme.com/v3/bots/post";
  const chunks = chunkText(text, 900);

  for (const chunk of chunks) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_id: botId, text: chunk }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("GroupMe post failed:", res.status, body);
    }
  }
}

/**
 * =========================
 * Schedule polling
 * =========================
 */
const SCHEDULE_SHEET = process.env.SCHEDULE_SHEET || "Schedule";
let SCHEDULE_POLL_MS = Number(process.env.SCHEDULE_POLL_MS || 60_000);
const SCHEDULE_LOOKAHEAD_MS = Number(
  process.env.SCHEDULE_LOOKAHEAD_MS || 2 * 60_000
);

function toIso(dt) {
  return dt ? new Date(dt).toISOString() : new Date().toISOString();
}

async function getDueScheduledMessages(now = new Date()) {
  const sheets = getSheetsClient();
  const range = `${SCHEDULE_SHEET}!A2:D`;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const values = resp.data.values || [];
  const due = [];

  const nowMs = now.getTime();
  const windowStart = nowMs - SCHEDULE_LOOKAHEAD_MS;

  for (let i = 0; i < values.length; i++) {
    const row = values[i] || [];
    const sendAtRaw = row[0];
    const message = (row[1] ?? "").toString();
    const sent = (row[2] ?? "").toString().trim().toUpperCase();

    if (!sendAtRaw || !message) continue;
    if (sent === "YES") continue;

    const sendAt = new Date(sendAtRaw);
    if (isNaN(sendAt.getTime())) continue;

    const sendAtMs = sendAt.getTime();

    if (sendAtMs <= nowMs && sendAtMs >= windowStart) {
      due.push({ rowIndex: i + 2, message, sendAt });
    }
  }

  return due;
}

async function markScheduledMessageSent(rowIndex, sentAt = new Date()) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SCHEDULE_SHEET}!C${rowIndex}:D${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [["YES", toIso(sentAt)]] },
  });
}

async function runScheduleTick() {
  try {
    const due = await getDueScheduledMessages(new Date());
    if (!due.length) return;

    for (const item of due) {
      // Scheduled messages always go to MAIN group (main bot)
      await postToGroupMe(item.message, GROUPME_BOT_ID);
      await markScheduledMessageSent(item.rowIndex, new Date());
    }
  } catch (err) {
    console.error("Schedule tick error:", err);
  }
}

let scheduleIntervalId = null;
function startScheduleInterval() {
  if (scheduleIntervalId) clearInterval(scheduleIntervalId);
  scheduleIntervalId = setInterval(() => {
    runScheduleTick();
  }, SCHEDULE_POLL_MS);
}

/**
 * =========================
 * Admin actions
 * =========================
 */
async function clearImportSheet() {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:Z`,
  });
}

async function resetCrownJewel() {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `Crown Jewel!B12:B37`,
  });
}

async function handleAdminCommands(text, replyBotId) {
  const raw = (text || "").trim();
  const t = raw.toLowerCase();

  if (t === "admin help") {
    await postToGroupMe(getHelpText(true), replyBotId);
    return true;
  }

  if (t === "admin status") {
    const locked = await getSetting("LOCK_PICKS");
    const lockedHuman =
      locked === null
        ? "unknown (create Settings tab)"
        : (await isPicksLocked())
          ? "LOCKED"
          : "UNLOCKED";

    const persistedPoll = await getSetting("SCHEDULE_POLL_MS");
    const upSec = Math.floor((Date.now() - startedAt) / 1000);

    const msg =
      "🛠️ Admin Status\n" +
      `Picks: ${lockedHuman}\n` +
      `Schedule poll: ${SCHEDULE_POLL_MS} ms` +
      (persistedPoll ? ` (Settings: ${persistedPoll})` : "") +
      `\nLookahead: ${SCHEDULE_LOOKAHEAD_MS} ms\n` +
      `Uptime: ${upSec}s\n` +
      `Now: ${new Date().toISOString()}`;

    await postToGroupMe(msg, replyBotId);
    return true;
  }

  if (t === "admin lock picks") {
    await setSetting("LOCK_PICKS", "TRUE");
    await postToGroupMe("🔒 Picks are now LOCKED.", replyBotId);
    await postToGroupMe("🔒 Picks are now LOCKED.", GROUPME_BOT_ID);
    return true;
  }

  if (t === "admin unlock picks") {
    await setSetting("LOCK_PICKS", "FALSE");
    await postToGroupMe("🔓 Picks are now UNLOCKED.", replyBotId);
    await postToGroupMe("🔓 Picks are now UNLOCKED.", GROUPME_BOT_ID);
    return true;
  }

  if (t === "admin rebuild leaderboard") {
    const board = await buildLeaderboardMessage();
    await postToGroupMe(board, GROUPME_BOT_ID);
    await postToGroupMe("✅ Posted fresh leaderboard to main group.", replyBotId);
    return true;
  }

  if (t === "admin clear import") {
    await clearImportSheet();
    await postToGroupMe(`✅ Cleared ${SHEET_NAME} rows (kept headers).`, replyBotId);
    return true;
  }

  if (t === "admin reset crown jewel") {
    await resetCrownJewel();
    await postToGroupMe("✅ Reset Crown Jewel points (cleared B12:B37).", replyBotId);
    await postToGroupMe("✅ Crown Jewel points have been reset.", GROUPME_BOT_ID);
    return true;
  }

  if (t.startsWith("admin set poll")) {
    const parts = raw.split(/\s+/);
    const msStr = parts[parts.length - 1];
    const ms = Number(msStr);

    if (!Number.isFinite(ms) || ms < 5_000) {
      await postToGroupMe("Usage: admin set poll <milliseconds> (min 5000)", replyBotId);
      return true;
    }

    SCHEDULE_POLL_MS = ms;
    startScheduleInterval();

    try {
      await setSetting("SCHEDULE_POLL_MS", String(ms));
    } catch {
      // ignore
    }

    await postToGroupMe(`✅ Schedule poll set to ${ms} ms.`, replyBotId);
    return true;
  }

  // announce / announce main / announce command / announce both
  if (t.startsWith("announce ")) {
    const rest = raw.slice("announce ".length).trim();
    if (!rest) {
      await postToGroupMe(
        "Usage:\nannounce <msg>\nannounce main <msg>\nannounce command <msg>\nannounce both <msg>",
        replyBotId
      );
      return true;
    }

    const lowerRest = rest.toLowerCase();
    const targets = ["main", "command", "both"];
    const firstWord = lowerRest.split(/\s+/)[0];

    let mode = "main";
    let msg = rest;

    if (targets.includes(firstWord)) {
      mode = firstWord;
      msg = rest.slice(firstWord.length).trim();
    }

    if (!msg) {
      await postToGroupMe("Usage: announce (main|command|both) <message>", replyBotId);
      return true;
    }

    const final = `📣 ${msg}`;

    if (mode === "main") {
      await postToGroupMe(final, GROUPME_BOT_ID);
      await postToGroupMe("✅ Announced to main group.", replyBotId);
      return true;
    }
    if (mode === "command") {
      await postToGroupMe(final, COMMAND_BOT_ID);
      return true;
    }
    if (mode === "both") {
      await postToGroupMe(final, GROUPME_BOT_ID);
      await postToGroupMe(final, COMMAND_BOT_ID);
      await postToGroupMe("✅ Announced to BOTH groups.", replyBotId);
      return true;
    }
  }

  return false;
}

/**
 * =========================
 * Shared handler for main commands (works in both groups)
 * =========================
 */
async function handleMainCommands({ msg, text, replyBotId }) {
  const lower = (text || "").toLowerCase().trim();

  if (lower === "help") {
    const isCommandGroup = replyBotId === COMMAND_BOT_ID;
    await postToGroupMe(getHelpText(isCommandGroup), replyBotId);
    return true;
  }

  if (lower === "board update") {
    const board = await buildLeaderboardMessage();
    await postToGroupMe(board, replyBotId);
    return true;
  }

  if (lower === "wins") {
    const winsMsg = await buildWinsMessage();
    await postToGroupMe(winsMsg, replyBotId);
    return true;
  }

  if (lower === "crown jewel") {
    const crownMsg = await buildCrownJewelMessage();
    await postToGroupMe(crownMsg, replyBotId);
    return true;
  }

  if (lower === "top 10s" || lower === "top10s" || lower === "top 10") {
    const msgTxt = await buildTop10sMessage();
    await postToGroupMe(msgTxt, replyBotId);
    return true;
  }

  if (lower === "top 5s" || lower === "top5s" || lower === "top 5") {
    const msgTxt = await buildTop5sMessage();
    await postToGroupMe(msgTxt, replyBotId);
    return true;
  }

  if (lower === "avg finish" || lower === "avgfinish" || lower === "average finish") {
    const msgTxt = await buildAvgFinishMessage();
    await postToGroupMe(msgTxt, replyBotId);
    return true;
  }

  // Picks
  if (!text || !text.includes("#")) return false;

  if (await isPicksLocked()) {
    await postToGroupMe("🔒 Picks are locked right now. No submissions accepted.", replyBotId);
    return true;
  }

  const pickToken = (text.match(/#\d+/) || [null])[0];
  if (!pickToken) return false;

  const hasAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0;
  const timestampIso = msg.created_at
    ? new Date(msg.created_at * 1000).toISOString()
    : new Date().toISOString();
  const attachmentsJson = hasAttachments ? JSON.stringify(msg.attachments) : "";

  const row = [
    timestampIso,
    msg.group_id || "",
    msg.sender_id || "",
    msg.name || "",
    text || "",
    attachmentsJson,
    msg.id || "",
  ];

  await appendRow(row);

  const senderName = msg.name || "";
  const driverCount = await getDriverCountForPickWithRetry(senderName, pickToken, 6, 700);

  if (driverCount) {
    await postToGroupMe(`Pick Submitted, ${pickToken} - ${driverCount}`, replyBotId);
  } else {
    await postToGroupMe(`Pick Submitted, ${pickToken} - ?`, replyBotId);
  }

  return true;
}

/**
 * =========================
 * Webhook
 * =========================
 */
app.post("/groupme", async (req, res) => {
  const msg = req.body;

  try {
    if (!msg) return res.sendStatus(200);
    if (msg.sender_type === "bot") return res.sendStatus(200);

    const text = msg.text?.trim() || "";
    const groupId = (msg.group_id ?? "").toString();
    const isCommandGroup = groupId === COMMAND_GROUP_ID;

    // Replies in each group must come from the bot that belongs to that group
    const replyBotId = isCommandGroup ? COMMAND_BOT_ID : GROUPME_BOT_ID;

    // Universal help
    if (text && text.toLowerCase() === "help") {
      await postToGroupMe(getHelpText(isCommandGroup), replyBotId);
      return res.sendStatus(200);
    }

    // Command group: admin commands first, then allow main commands too
    if (isCommandGroup) {
      const adminHandled = await handleAdminCommands(text, replyBotId);
      if (adminHandled) return res.sendStatus(200);

      const mainHandled = await handleMainCommands({ msg, text, replyBotId });
      if (!mainHandled && text) {
        await postToGroupMe("Unknown command.\n\nType 'help' to see commands.", replyBotId);
      }
      return res.sendStatus(200);
    }

    // Main group: main commands only
    await handleMainCommands({ msg, text, replyBotId });
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(200);
  }
});

// Kick off schedule polling (always posts to MAIN bot)
startScheduleInterval();
runScheduleTick().catch(() => {});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
