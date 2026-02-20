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

// Apps Script trigger (Render env vars)
const APPS_SCRIPT_WEBAPP_URL = process.env.APPS_SCRIPT_WEBAPP_URL; // https://script.google.com/macros/s/.../exec
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET; // "run results 2026 - Dale"

// 2026 Schedule tab (for race index lookups)
// Expected layout: B = Index, C = Race Date
const SCHEDULE_2026_TAB = "2026 Schedule";
const RANGE_SCHEDULE_2026 = `${SCHEDULE_2026_TAB}!B2:C`;

// 2026 LeaderBoard tab ranges
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

/**
 * =========================
 * Time helpers (America/Chicago)
 * =========================
 */

// Returns: "YYYY-MM-DDTHH:mm:ss" in America/Chicago (Sheets-friendly)
function toChicagoLocal(dateObj = new Date()) {
  const s = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(dateObj);

  return s.replace(" ", "T");
}

function nowChicago() {
  return toChicagoLocal(new Date());
}

// Date-only (00:00:00) in Chicago for correct “today” comparisons
function chicagoTodayDateOnly() {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // "YYYY-MM-DD"
  return new Date(`${s}T00:00:00`);
}

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
 * Apps Script trigger
 * =========================
 */
async function triggerRaces2026Import() {
  if (!APPS_SCRIPT_WEBAPP_URL || !APPS_SCRIPT_SECRET) {
    throw new Error(
      "Missing APPS_SCRIPT_WEBAPP_URL or APPS_SCRIPT_SECRET in Render env vars"
    );
  }

  const res = await fetch(APPS_SCRIPT_WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      secret: APPS_SCRIPT_SECRET,
      action: "races2026",
    }),
  });

  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Apps Script HTTP ${res.status}: ${txt}`);
  }
  if ((txt || "").toLowerCase().includes("unauthorized")) {
    throw new Error("Apps Script unauthorized (check APPS_SCRIPT_SECRET)");
  }
  return txt;
}

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
    "• picks, <index>   (example: picks, 1)\n" +
    "• #<number> (example: #2)\n";

  if (isCommandGroup) {
    return (
      "🤖 Command Bot Help\n\n" +
      "Admin commands:\n" +
      "• admin help\n" +
      "• admin status\n" +
      "• admin results   (triggers Apps Script import to Races 2026)\n" +
      "• admin lock picks   (also auto-fills No Pick for missing picks)\n" +
      "• admin unlock picks\n" +
      '• admin setpick <name|sender_name> <#number|No Pick>, <raceIndex>\n' +
      '    examples: admin setpick Tyler #4, 1 | admin setpick Tyler No Pick, 1\n' +
      '• admin setpick <name|sender_name> clear, <raceIndex>\n' +
      '    example: admin setpick Tyler clear, 1\n\n' +
      "Announce (generic):\n" +
      "• announce <msg>\n" +
      "• announce main <msg>\n" +
      "• announce command <msg>\n" +
      "• announce both <msg>\n\n" +
      "Announce-to-main (run here, posts OUTPUT in MAIN group):\n" +
      "• announce wins\n" +
      "• announce board update\n" +
      "• announce crown jewel\n" +
      "• announce top 10s\n" +
      "• announce top 5s\n" +
      "• announce avg finish\n" +
      "• announce picks, <index>\n\n" +
      "Main commands (also work here):\n" +
      common
    );
  }

  return (
    "🏁 Bot Help\n\n" +
    common +
    "\nNote: Admin/announce commands are only available in the command group."
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
 * BOT Picks resolver
 * BOT Picks columns:
 * A = sender_id
 * B = name
 * C = sender_name
 *
 * Admin setpick uses either name OR sender_name (NOT sender_id)
 * =========================
 */
async function resolveUserFromBotPicksByNameOrSenderName(identifier) {
  const idRaw = (identifier ?? "").toString().trim();
  if (!idRaw) return null;

  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `BOT Picks!A2:C`,
  });

  const rows = resp.data.values || [];
  const norm = (v) => (v ?? "").toString().trim();
  const normLower = (v) => norm(v).toLowerCase();

  const needle = normLower(idRaw);

  for (const r of rows) {
    const senderId = norm(r?.[0]);
    const name = norm(r?.[1]);
    const senderName = norm(r?.[2]);

    if (!senderId && !name && !senderName) continue;

    if (normLower(name) === needle || normLower(senderName) === needle) {
      return {
        sender_id: senderId,
        name,
        sender_name: senderName,
      };
    }
  }

  return null;
}

/**
 * =========================
 * Schedule helpers
 * =========================
 */

// Build sorted schedule list: [{idx, date}]
async function getScheduleIndexToDateMap2026() {
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: RANGE_SCHEDULE_2026,
  });

  const rows = resp.data.values || [];
  const out = [];

  for (const r of rows) {
    const idx = (r?.[0] ?? "").toString().trim();
    const dateRaw = r?.[1];
    if (!idx || !dateRaw) continue;

    const d = new Date(dateRaw);
    if (isNaN(d.getTime())) continue;

    d.setHours(0, 0, 0, 0);
    out.push({ idx: String(idx), date: d });
  }

  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

// Current race index = first race date >= today (Chicago)
async function getCurrentRaceIndex2026() {
  const schedule = await getScheduleIndexToDateMap2026();
  if (!schedule.length) return null;

  const today = chicagoTodayDateOnly();
  for (const item of schedule) {
    if (item.date.getTime() >= today.getTime()) return item.idx;
  }
  return schedule[schedule.length - 1].idx;
}

/**
 * Spoof a Chicago-local timestamp that will map to the given race index under
 * "next race date >= pick date" logic.
 *
 * For index 1: pickDate <= raceDate(1)
 * For index n>1: (raceDate(n-1), raceDate(n)] maps to n
 */
async function spoofTimestampForRaceIndex2026(targetIndex) {
  const target = String(targetIndex ?? "").trim();
  if (!target) return null;

  const schedule = await getScheduleIndexToDateMap2026();
  if (!schedule.length) return null;

  const pos = schedule.findIndex((x) => x.idx === target);
  if (pos === -1) return null;

  const targetDate = new Date(schedule[pos].date); // date-only
  let spoof;

  if (pos === 0) {
    // For race 1, choose noon on race date (safe)
    spoof = new Date(targetDate);
    spoof.setHours(12, 0, 0, 0);
  } else {
    const prevDate = new Date(schedule[pos - 1].date);
    // Choose a time strictly after prevDate but still <= targetDate
    spoof = new Date(prevDate);
    spoof.setHours(12, 0, 0, 0);
    spoof = new Date(spoof.getTime() + 24 * 60 * 60 * 1000); // next day noon

    // If that pushes past target date (rare edge case), clamp to target date noon
    if (spoof.getTime() > targetDate.getTime()) {
      spoof = new Date(targetDate);
      spoof.setHours(12, 0, 0, 0);
    }
  }

  return toChicagoLocal(spoof);
}

/**
 * =========================
 * Auto-fill No Pick on lock
 * - Looks at BOT Picks row 2 to find the column for the current race index
 * - For any player with blank in that column, append "No Pick" to Import
 * =========================
 */
async function autoFillNoPicksForCurrentRace(replyBotId) {
  const raceIdx = await getCurrentRaceIndex2026();
  if (!raceIdx) {
    await postToGroupMe(
      "⚠️ Could not determine current race index (check 2026 Schedule B:C).",
      replyBotId
    );
    return;
  }

  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `BOT Picks!A1:ZZ200`,
  });

  const values = resp.data.values || [];
  if (values.length < 3) {
    await postToGroupMe(
      "⚠️ BOT Picks tab does not have enough rows (need row2 with index numbers).",
      replyBotId
    );
    return;
  }

  const row2 = values[1] || []; // index row
  const norm = (v) => (v ?? "").toString().trim();

  let targetCol = -1;
  for (let c = 0; c < row2.length; c++) {
    if (norm(row2[c]) === String(raceIdx)) {
      targetCol = c;
      break;
    }
  }

  if (targetCol === -1) {
    await postToGroupMe(
      `⚠️ Couldn't find a BOT Picks column where row 2 equals "${raceIdx}".`,
      replyBotId
    );
    return;
  }

  let appended = 0;

  // Start at row index 2 (sheet row 3) where user list typically begins
  for (let r = 2; r < values.length; r++) {
    const row = values[r] || [];
    const senderId = norm(row[0]); // A
    const name = norm(row[1]); // B
    const senderName = norm(row[2]); // C

    if (!senderId && !name && !senderName) continue;

    const existingPick = norm(row[targetCol]);
    if (existingPick) continue; // already has something (skip)

    const timestampIso = nowChicago();
    const spoofSenderName = senderName || name || "Unknown";

    await appendRow([
      timestampIso,
      COMMAND_GROUP_ID,
      senderId || "",
      spoofSenderName,
      "No Pick",
      "",
      `auto-nopick-${raceIdx}-${senderId || spoofSenderName}-${Date.now()}`,
    ]);

    appended++;
  }

  await postToGroupMe(
    `✅ Auto-filled "No Pick" for Race Index ${raceIdx}: ${appended} missing picks.`,
    replyBotId
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
  return buildTwoColMessage({
    title: "🏁 Leaderboard",
    rangeA1: RANGE_LEADERBOARD,
  });
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
  return buildTwoColMessage({
    title: "📊 Avg Finish",
    rangeA1: RANGE_AVG_FINISH,
  });
}

/**
 * =========================
 * Picks, Index (BOT Picks)
 * =========================
 */
async function buildPicksIndexMessage(indexRaw) {
  const idx = (indexRaw ?? "").toString().trim();
  if (!idx) return "Usage: picks, <index>   (example: picks, 1)";

  const sheets = getSheetsClient();

  const range = `BOT Picks!A1:ZZ30`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const values = resp.data.values || [];
  if (values.length < 3) return "BOT Picks tab does not have enough rows.";

  const row1 = values[0] || []; // label row
  const row2 = values[1] || []; // index row

  let targetCol = -1;
  for (let c = 0; c < row2.length; c++) {
    const v = (row2[c] ?? "").toString().trim();
    if (v === idx) {
      targetCol = c;
      break;
    }
  }

  if (targetCol === -1) {
    return `No column found in BOT Picks where row 2 equals "${idx}".`;
  }

  const colLabel = (row1[targetCol] ?? "").toString().trim() || idx;

  const lines = [];
  for (let r = 2; r <= 29 && r < values.length; r++) {
    const row = values[r] || [];
    const name = (row[1] ?? "").toString().trim(); // col B
    if (!name || name.toLowerCase() === "name") continue;

    const val = (row[targetCol] ?? "").toString().trim();
    lines.push(`${String(lines.length + 1).padStart(2, " ")}. ${name} — ${val}`);
  }

  if (!lines.length) return `🧾 Picks, ${colLabel}\n(no rows found in BOT Picks)`;
  return `🧾 Picks, ${colLabel}\n` + lines.join("\n");
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
  return toChicagoLocal(dt ? new Date(dt) : new Date());
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

/**
 * =========================
 * Admin command handler
 * =========================
 */
async function handleAdminCommands({ msg, text, replyBotId }) {
  const raw = (text || "").trim();
  const t = raw.toLowerCase().trim();

  if (t === "admin help") {
    await postToGroupMe(getHelpText(true), replyBotId);
    return true;
  }

  /**
   * ✅ NEW:
   * admin setpick <name|sender_name> <#number|No Pick>, <raceIndex>
   * admin setpick <name|sender_name> clear, <raceIndex>
   *
   * Examples:
   * admin setpick Tyler No Pick, 1
   * admin setpick Tyler #4, 1
   * admin setpick Tyler clear, 1
   */
  const mSetPick = raw.match(
    /^admin\s+setpick\s+(".*?"|.+?)\s+(.+?)\s*,\s*(\d+)\s*$/i
  );
  if (mSetPick) {
    const whoRaw = (mSetPick[1] ?? "").toString().trim();
    const who = whoRaw.replace(/^"(.*)"$/, "$1").trim();

    let pickRaw = (mSetPick[2] ?? "").toString().trim();
    pickRaw = pickRaw.replace(/^"(.*)"$/, "$1").trim();

    const raceIndex = (mSetPick[3] ?? "").toString().trim();

    const isClear = /^clear$/i.test(pickRaw);
    const isNoPick = /^no\s*pick$/i.test(pickRaw);

    const pickToken = isClear
      ? "clear"
      : isNoPick
      ? "No Pick"
      : (pickRaw.match(/#\d+/) || [null])[0];

    if (!raceIndex || (!pickToken && !isClear)) {
      await postToGroupMe(
        `Usage:\n` +
          `admin setpick <name|sender_name> <#number|No Pick>, <raceIndex>\n` +
          `admin setpick <name|sender_name> clear, <raceIndex>\n\n` +
          `Examples:\n` +
          `• admin setpick Tyler #4, 1\n` +
          `• admin setpick Tyler No Pick, 1\n` +
          `• admin setpick Tyler clear, 1`,
        replyBotId
      );
      return true;
    }

    const resolved = await resolveUserFromBotPicksByNameOrSenderName(who);
    if (!resolved) {
      await postToGroupMe(
        `❌ Can't find "${who}" in BOT Picks columns B (name) or C (sender_name).\n` +
          `Usage: admin setpick <name|sender_name> <#number|No Pick|clear>, <raceIndex>`,
        replyBotId
      );
      return true;
    }

    const spoofSenderId = resolved.sender_id || "";
    const spoofSenderName = resolved.sender_name || resolved.name || who;

    // Spoof timestamp that maps to the requested race index
    const timestampIso = await spoofTimestampForRaceIndex2026(raceIndex);
    if (!timestampIso) {
      await postToGroupMe(
        `❌ Could not spoof timestamp for race index ${raceIndex}. Check ${SCHEDULE_2026_TAB} columns B (Index) and C (Race Date).`,
        replyBotId
      );
      return true;
    }

    // For "clear", write something that your regex formulas won't treat as a pick
    const rawTextForImport = isClear ? "clear" : pickToken;

    await appendRow([
      timestampIso,
      msg.group_id || "",
      spoofSenderId,
      spoofSenderName,
      rawTextForImport,
      "",
      `admin-setpick-${raceIndex}-${Date.now()}`,
    ]);

    // Only run driver-count announcements for real # picks
    if (!isNoPick && !isClear) {
      const driverCount = await getDriverCountForPickWithRetry(
        spoofSenderName,
        pickToken,
        6,
        700
      );

      if (driverCount === "3") {
        await postToGroupMe(
          `Final ${pickToken} pick for ${spoofSenderName}`,
          GROUPME_BOT_ID
        );
      } else if (driverCount === "4") {
        await postToGroupMe(
          `Exceeded 3 driver pick limit, ${spoofSenderName} please submit new pick`,
          replyBotId
        );
      }

      await postToGroupMe(
        `✅ Admin set ${spoofSenderName} to ${pickToken} for Race Index ${raceIndex}. (count: ${driverCount ?? "?"})`,
        replyBotId
      );
      return true;
    }

    if (isClear) {
      await postToGroupMe(
        `✅ Cleared ${spoofSenderName}'s pick for Race Index ${raceIndex}.`,
        replyBotId
      );
      return true;
    }

    await postToGroupMe(
      `✅ Admin set ${spoofSenderName} to No Pick for Race Index ${raceIndex}.`,
      replyBotId
    );
    return true;
  }

  // ✅ NEW: lock picks triggers No Pick autofill
  if (t === "admin lock picks") {
    await setSetting("LOCK_PICKS", "TRUE");
    await postToGroupMe("🔒 Picks are now LOCKED.", replyBotId);
    await postToGroupMe("🔒 Picks are now LOCKED.", GROUPME_BOT_ID);

    await postToGroupMe("🧾 Checking for missing picks…", replyBotId);
    await autoFillNoPicksForCurrentRace(replyBotId);

    return true;
  }

  if (t === "admin unlock picks") {
    await setSetting("LOCK_PICKS", "FALSE");
    await postToGroupMe("🔓 Picks are now UNLOCKED.", replyBotId);
    await postToGroupMe("🔓 Picks are now UNLOCKED.", GROUPME_BOT_ID);
    return true;
  }

  if (t === "admin results") {
    try {
      await postToGroupMe("⏳ Triggering Races 2026 import…", replyBotId);
      const respTxt = await triggerRaces2026Import();
      await postToGroupMe(
        `✅ Import triggered. (Apps Script: ${String(respTxt).trim() || "ok"})`,
        replyBotId
      );
    } catch (e) {
      await postToGroupMe(`❌ Failed to trigger import: ${e?.message || e}`, replyBotId);
    }
    return true;
  }

  if (t.startsWith("announce")) {
    const rest = raw.slice("announce".length).trim();
    const restLower = rest.toLowerCase().trim();

    if (!rest) {
      await postToGroupMe(
        "Usage:\n" +
          "announce <msg>\nannounce main <msg>\nannounce command <msg>\nannounce both <msg>\n\n" +
          "Or announce-to-main outputs:\n" +
          "announce wins\nannounce board update\nannounce crown jewel\nannounce top 10s\nannounce top 5s\nannounce avg finish\nannounce picks, <index>",
        replyBotId
      );
      return true;
    }

    const mPicks = restLower.match(/^picks\s*,\s*(.+)$/i);
    if (mPicks) {
      const idx = (mPicks[1] ?? "").toString().trim();
      const msgTxt = await buildPicksIndexMessage(idx);
      await postToGroupMe(msgTxt, GROUPME_BOT_ID);
      await postToGroupMe(`✅ Announced Picks (${idx}) to the MAIN group.`, replyBotId);
      return true;
    }

    let statMsg = null;
    if (restLower === "wins") statMsg = await buildWinsMessage();
    else if (restLower === "board update" || restLower === "leaderboard")
      statMsg = await buildLeaderboardMessage();
    else if (restLower === "crown jewel") statMsg = await buildCrownJewelMessage();
    else if (restLower === "top 10s" || restLower === "top10s" || restLower === "top 10")
      statMsg = await buildTop10sMessage();
    else if (restLower === "top 5s" || restLower === "top5s" || restLower === "top 5")
      statMsg = await buildTop5sMessage();
    else if (
      restLower === "avg finish" ||
      restLower === "avgfinish" ||
      restLower === "average finish"
    )
      statMsg = await buildAvgFinishMessage();

    if (statMsg) {
      await postToGroupMe(statMsg, GROUPME_BOT_ID);
      await postToGroupMe("✅ Announced to the MAIN group.", replyBotId);
      return true;
    }

    const firstWord = restLower.split(/\s+/)[0];
    const targets = ["main", "command", "both"];

    let mode = "main";
    let msgText = rest;

    if (targets.includes(firstWord)) {
      mode = firstWord;
      msgText = rest.slice(firstWord.length).trim();
    }

    if (!msgText) {
      await postToGroupMe("Usage: announce (main|command|both) <message>", replyBotId);
      return true;
    }

    const final = `📣 ${msgText}`;

    if (mode === "main") {
      await postToGroupMe(final, GROUPME_BOT_ID);
      await postToGroupMe("✅ Announced to MAIN.", replyBotId);
      return true;
    }
    if (mode === "command") {
      await postToGroupMe(final, COMMAND_BOT_ID);
      return true;
    }
    if (mode === "both") {
      await postToGroupMe(final, GROUPME_BOT_ID);
      await postToGroupMe(final, COMMAND_BOT_ID);
      await postToGroupMe("✅ Announced to BOTH.", replyBotId);
      return true;
    }
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

    const msgTxt =
      "🛠️ Admin Status\n" +
      `Picks: ${lockedHuman}\n` +
      `Schedule poll: ${SCHEDULE_POLL_MS} ms` +
      (persistedPoll ? ` (Settings: ${persistedPoll})` : "") +
      `\nLookahead: ${SCHEDULE_LOOKAHEAD_MS} ms\n` +
      `Uptime: ${upSec}s\n` +
      `Now: ${nowChicago()}`;

    await postToGroupMe(msgTxt, replyBotId);
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

  return false;
}

/**
 * =========================
 * Shared handler for main commands (works in both groups)
 * =========================
 */
async function handleMainCommands({ msg, text, replyBotId }) {
  const raw = (text || "").trim();
  const lower = raw.toLowerCase().trim();

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

  const mPicks = raw.match(/^picks\s*,\s*(.+)$/i);
  if (mPicks) {
    const idx = (mPicks[1] ?? "").toString().trim();
    const msgTxt = await buildPicksIndexMessage(idx);
    await postToGroupMe(msgTxt, replyBotId);
    return true;
  }

  // ✅ CHANGED: accept # picks OR "No Pick"
  const isNoPick = /^no\s*pick$/i.test(raw);
  const pickToken = isNoPick ? "No Pick" : (raw.match(/#\d+/) || [null])[0];
  if (!pickToken) return false;

  if (await isPicksLocked()) {
    await postToGroupMe("🔒 Picks are locked right now. No submissions accepted.", replyBotId);
    return true;
  }

  const hasAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0;

  // Chicago-local timestamp for Import sheet
  const createdAt = msg.created_at ? new Date(msg.created_at * 1000) : new Date();
  const timestampIso = toChicagoLocal(createdAt);

  const attachmentsJson = hasAttachments ? JSON.stringify(msg.attachments) : "";

  const row = [
    timestampIso,
    msg.group_id || "",
    msg.sender_id || "",
    msg.name || "",
    raw || "",
    attachmentsJson,
    msg.id || "",
  ];

  await appendRow(row);

  // Only do driver-count announcements for real # picks
  if (!isNoPick) {
    const senderName = msg.name || "";
    const driverCount = await getDriverCountForPickWithRetry(
      senderName,
      pickToken,
      6,
      700
    );

    if (driverCount === "3") {
      await postToGroupMe(`Final ${pickToken} pick for ${senderName}`, GROUPME_BOT_ID);
    } else if (driverCount === "4") {
      await postToGroupMe(
        `Exceeded 3 driver pick limit, ${senderName} please submit new pick`,
        replyBotId
      );
    }
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

    const replyBotId = isCommandGroup ? COMMAND_BOT_ID : GROUPME_BOT_ID;

    if (text && text.toLowerCase().trim() === "help") {
      await postToGroupMe(getHelpText(isCommandGroup), replyBotId);
      return res.sendStatus(200);
    }

    if (isCommandGroup) {
      const adminHandled = await handleAdminCommands({ msg, text, replyBotId });
      if (adminHandled) return res.sendStatus(200);

      const mainHandled = await handleMainCommands({ msg, text, replyBotId });
      if (!mainHandled && text) {
        await postToGroupMe("Unknown command.\n\nType 'help' to see commands.", replyBotId);
      }
      return res.sendStatus(200);
    }

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

