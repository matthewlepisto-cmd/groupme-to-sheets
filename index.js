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
 * Settings helpers (Sheets)
 * =========================
 * Requires a tab named "Settings" with:
 * Col A = key, Col B = value
 * Example:
 * LOCK_PICKS | TRUE
 * SCHEDULE_POLL_MS | 60000
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
  } catch (e) {
    // Most common cause: Settings sheet doesn't exist
    return null;
  }
}

async function setSetting(key, value) {
  const sheets = getSheetsClient();
  const k = (key ?? "").toString().trim().toUpperCase();
  const v = (value ?? "").toString().trim();

  // Read all to find existing row
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
    // append new setting
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SETTINGS_SHEET}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[k, v]] },
    });
  } else {
    // update existing setting row
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
  return ["TRUE", "YES", "1", "ON", "LOCKED"].includes(v.toString().trim().toUpperCase());
}

/**
 * =========================
 * Your existing functions
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

async function buildWinsMessage() {
  const sheets = getSheetsClient();
  const range = `WINS!A1:B27`;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const values = resp.data.values || [];
  if (values.length < 2) return "WINS tab is empty.";

  const rows = values.slice(1);

  const lines = rows
    .filter((r) => (r[0] ?? "").toString().trim() !== "")
    .map((r, i) => {
      const name = (r[0] ?? "").toString().trim();
      const wins = (r[1] ?? "").toString().trim();
      return `${String(i + 1).padStart(2, " ")}. ${name} — ${wins}`;
    });

  return "🏆 Wins\n" + lines.join("\n");
}

async function buildCrownJewelMessage() {
  const sheets = getSheetsClient();
  const range = `Crown Jewel!A12:B37`;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const values = resp.data.values || [];
  if (!values.length) return "Crown Jewel tab is empty.";

  const lines = values
    .filter((r) => (r[0] ?? "").toString().trim() !== "")
    .map((r, i) => {
      const name = (r[0] ?? "").toString().trim();
      const pts = (r[1] ?? "").toString().trim();
      return `${String(i + 1).padStart(2, " ")}. ${name} — ${pts}`;
    });

  return "👑 Crown Jewel Standings\n" + lines.join("\n");
}

async function buildLeaderboardMessage() {
  const sheets = getSheetsClient();
  const range = `Leaderboard!A1:B27`;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const values = resp.data.values || [];
  if (values.length < 2) return "Leaderboard is empty.";

  const rows = values.slice(1);

  const lines = rows
    .filter((r) => (r[0] ?? "").toString().trim() !== "")
    .map((r, i) => {
      const name = (r[0] ?? "").toString().trim();
      const pts = (r[1] ?? "").toString().trim();
      return `${String(i + 1).padStart(2, " ")}. ${name} — ${pts}`;
    });

  return "🏁 Leaderboard\n" + lines.join("\n");
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

async function postToGroupMe(text, botId = GROUPME_BOT_ID) {
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
const SCHEDULE_LOOKAHEAD_MS = Number(process.env.SCHEDULE_LOOKAHEAD_MS || 2 * 60_000);

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
      // scheduled messages go to MAIN bot
      await postToGroupMe(item.message, GROUPME_BOT_ID);
      await markScheduledMessageSent(item.rowIndex, new Date());
    }
  } catch (err) {
    console.error("Schedule tick error:", err);
  }
}

// interval control so admin can change poll ms
let scheduleIntervalId = null;
function startScheduleInterval() {
  if (scheduleIntervalId) clearInterval(scheduleIntervalId);
  scheduleIntervalId = setInterval(() => {
    runScheduleTick();
  }, SCHEDULE_POLL_MS);
}

/**
 * =========================
 * Admin actions (Sheets ops)
 * =========================
 */
async function clearImportSheet() {
  const sheets = getSheetsClient();
  // Clears everything below the header row (row 1)
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:Z`,
  });
}

async function resetCrownJewel() {
  const sheets = getSheetsClient();
  // Clears points column in the Crown Jewel range (keeps names)
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `Crown Jewel!B12:B37`,
  });
}

/**
 * =========================
 * Admin command handler
 * =========================
 */
async function handleAdminCommands(text, replyBotId) {
  const raw = (text || "").trim();
  const t = raw.toLowerCase();

  // admin status
  if (t === "admin status") {
    const locked = await getSetting("LOCK_PICKS");
    const lockedHuman =
      locked === null ? "unknown (create Settings tab)" : (await isPicksLocked()) ? "LOCKED" : "UNLOCKED";

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

  // lock picks
  if (t === "admin lock picks") {
    try {
      await setSetting("LOCK_PICKS", "TRUE");
      await postToGroupMe("🔒 Picks are now LOCKED.", replyBotId);
      // optional: announce to main group
      await postToGroupMe("🔒 Picks are now LOCKED.", GROUPME_BOT_ID);
    } catch {
      await postToGroupMe(
        "❌ Could not lock picks. Make sure you created a sheet tab named 'Settings' (A=key, B=value).",
        replyBotId
      );
    }
    return true;
  }

  // unlock picks
  if (t === "admin unlock picks") {
    try {
      await setSetting("LOCK_PICKS", "FALSE");
      await postToGroupMe("🔓 Picks are now UNLOCKED.", replyBotId);
      await postToGroupMe("🔓 Picks are now UNLOCKED.", GROUPME_BOT_ID);
    } catch {
      await postToGroupMe(
        "❌ Could not unlock picks. Make sure you created a sheet tab named 'Settings' (A=key, B=value).",
        replyBotId
      );
    }
    return true;
  }

  // rebuild leaderboard (posts current leaderboard to main group)
  if (t === "admin rebuild leaderboard") {
    const board = await buildLeaderboardMessage();
    await postToGroupMe(board, GROUPME_BOT_ID);
    await postToGroupMe("✅ Posted fresh leaderboard to main group.", replyBotId);
    return true;
  }

  // clear import
  if (t === "admin clear import") {
    await clearImportSheet();
    await postToGroupMe(`✅ Cleared ${SHEET_NAME} rows (kept headers).`, replyBotId);
    return true;
  }

  // reset crown jewel
  if (t === "admin reset crown jewel") {
    await resetCrownJewel();
    await postToGroupMe("✅ Reset Crown Jewel points (cleared B12:B37).", replyBotId);
    await postToGroupMe("✅ Crown Jewel points have been reset.", GROUPME_BOT_ID);
    return true;
  }

  // set poll (ms)
  // example: "admin set poll 30000"
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

    // persist in Settings sheet if present
    try {
      await setSetting("SCHEDULE_POLL_MS", String(ms));
    } catch {
      // ignore; still applied in memory
    }

    await postToGroupMe(`✅ Schedule poll set to ${ms} ms.`, replyBotId);
    return true;
  }

  /**
   * Updated announce:
   * - announce <msg> (defaults to main)
   * - announce main <msg>
   * - announce command <msg>
   * - announce both <msg>
   */
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
    const replyBotId = isCommandGroup ? COMMAND_BOT_ID : GROUPME_BOT_ID;

    // COMMAND GROUP: admin-only
    if (isCommandGroup) {
      const handled = await handleAdminCommands(text, replyBotId);
      if (!handled && text) {
        await postToGroupMe(
          "Unknown admin command.\nCommands:\n" +
            "admin lock picks\nadmin unlock picks\nadmin rebuild leaderboard\nadmin clear import\nadmin reset crown jewel\nadmin set poll 30000\nadmin status\n" +
            "announce <msg> | announce main <msg> | announce command <msg> | announce both <msg>",
          replyBotId
        );
      }
      return res.sendStatus(200);
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getDriverCountForPickWithRetry(senderName, pickToken, tries = 6, delayMs = 700) {
  for (let i = 0; i < tries; i++) {
    const count = await getDriverCountForPick(senderName, pickToken);
    if (count !== null && count !== undefined && String(count).trim() !== "") {
      return String(count).trim();
    }
    await sleep(delayMs);
  }
  return null;
}

    // MAIN GROUP: unchanged commands

    if (text && text.toLowerCase() === "board update") {
      const board = await buildLeaderboardMessage();
      await postToGroupMe(board, replyBotId);
      return res.sendStatus(200);
    }

    if (text && text.toLowerCase() === "crown jewel") {
      const crownMsg = await buildCrownJewelMessage();
      await postToGroupMe(crownMsg, replyBotId);
      return res.sendStatus(200);
    }

    if (text && text.toLowerCase() === "wins") {
      const winsMsg = await buildWinsMessage();
      await postToGroupMe(winsMsg, replyBotId);
      return res.sendStatus(200);
    }

    // only handle/import messages that contain #
    if (!text || !text.includes("#")) return res.sendStatus(200);

    // 🔒 Enforce pick locking (admin controls via Settings sheet)
    if (await isPicksLocked()) {
      await postToGroupMe("🔒 Picks are locked right now. No submissions accepted.", replyBotId);
      return res.sendStatus(200);
    }

// Only handle/import messages that contain #
if (!text || !text.includes("#")) return res.sendStatus(200);

// Safer: only capture "#<digits>"
const pickToken = (text.match(/#\d+/) || [null])[0];
if (!pickToken) return res.sendStatus(200);

// Append to Import tab FIRST (so formulas can update)
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

// Now wait/read Driver Count after formulas recalc
const senderName = msg.name || "";
const driverCount = await getDriverCountForPickWithRetry(senderName, pickToken, 6, 700);

// Respond back to GroupMe with count (or ? if still not ready)
if (driverCount) {
  await postToGroupMe(`Pick Submitted, ${pickToken} - ${driverCount}`);
} else {
  await postToGroupMe(`Pick Submitted, ${pickToken} - ?`);
}

return res.sendStatus(200);


// Kick off schedule polling (and allow admin set poll to update it)
startScheduleInterval();

// Optional: run once at startup
runScheduleTick().catch(() => {});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));

