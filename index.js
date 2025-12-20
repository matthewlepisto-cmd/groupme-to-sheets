import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json({ limit: "1mb" }));

const SPREADSHEET_ID =
  process.env.SPREADSHEET_ID || "1xT7jHcFOVIkkcljwtyDj9NlNIP8S7pn9qVNDna7wuEw";
const SHEET_NAME = process.env.SHEET_NAME || "Import";
const GOOGLE_CREDS_JSON = process.env.GOOGLE_CREDS_JSON;
const GROUPME_BOT_ID = process.env.GROUPME_BOT_ID || "0cb4eb2388c240e337b026610a";

if (!SPREADSHEET_ID || !GOOGLE_CREDS_JSON) {
  console.error("Missing env vars: SPREADSHEET_ID and/or GOOGLE_CREDS_JSON");
  process.exit(1);
}

function getSheetsClient() {
  const creds = JSON.parse(GOOGLE_CREDS_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

if (text && text.toLowerCase() === "run results") {
  await fetch(process.env.APPS_SCRIPT_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "run_results" }),
  });

  await postToGroupMe("🏁 Results import started…");
  return res.sendStatus(200);
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
 * Reads Driver Count tab layout:
 * - Row 1: names repeated across multiple columns
 * - Row 3: labels for those columns ("Driver" or "Count")
 * - Data rows (row 4+): driver token like "#2" under the sender's Driver column
 *   and the corresponding count under the sender's Count column (same row).
 */
async function getDriverCountForPick(senderName, pickToken) {
  const sheets = getSheetsClient();

  // Adjust the range if your sheet is larger
  const range = `Driver Count!A1:ZZ2000`;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const values = resp.data.values || [];
  if (values.length < 4) return null;

  const row1 = values[0] || []; // names
  const row3 = values[2] || []; // "Driver" / "Count"

  const norm = (v) => (v ?? "").toString().trim();
  const normLower = (v) => norm(v).toLowerCase();

  const sender = norm(senderName);
  if (!sender) return null;

  let driverCol = -1;
  let countCol = -1;

  // Find the sender's Driver column and Count column
  for (let c = 0; c < Math.max(row1.length, row3.length); c++) {
    const nameAtC = norm(row1[c]);
    if (nameAtC !== sender) continue;

    const label = normLower(row3[c]);
    if (label === "driver") driverCol = c;
    if (label === "count") countCol = c;
  }

  if (driverCol === -1 || countCol === -1) return null;

  const pick = norm(pickToken);

  // Data begins at sheet row 4 -> index 3
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

  const rows = values.slice(1); // skip headers

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

  // Name (A) + Points (B), rows 12–37
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

  const rows = values.slice(1); // skip headers

  const lines = rows
    .filter((r) => (r[0] ?? "").toString().trim() !== "")
    .map((r, i) => {
      const name = (r[0] ?? "").toString().trim();
      const pts = (r[1] ?? "").toString().trim();
      return `${String(i + 1).padStart(2, " ")}. ${name} — ${pts}`;
    });

  return "🏁 Leaderboard\n" + lines.join("\n");
}

function chunkText(text, maxLen) {
  if (!text || text.length <= maxLen) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);

    // Prefer splitting on newline for nicer chunks
    const lastNl = text.lastIndexOf("\n", end);
    if (lastNl > start + 50) end = lastNl;

    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

async function postToGroupMe(text) {
  const url = "https://api.groupme.com/v3/bots/post";

  const chunks = chunkText(text, 900);
  for (const chunk of chunks) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_id: GROUPME_BOT_ID, text: chunk }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("GroupMe post failed:", res.status, body);
    }
  }
}

const SCHEDULE_SHEET = process.env.SCHEDULE_SHEET || "Schedule";
const SCHEDULE_POLL_MS = Number(process.env.SCHEDULE_POLL_MS || 60_000); // 1 min
const SCHEDULE_LOOKAHEAD_MS = Number(process.env.SCHEDULE_LOOKAHEAD_MS || 2 * 60_000); // 2 min

function toIso(dt) {
  return dt ? new Date(dt).toISOString() : new Date().toISOString();
}

/**
 * Reads scheduled messages and returns rows that are due.
 * Assumes columns:
 * A: SendAt (datetime)
 * B: Message
 * C: Sent (YES/blank)
 * D: SentAt
 */
async function getDueScheduledMessages(now = new Date()) {
  const sheets = getSheetsClient();
  const range = `${SCHEDULE_SHEET}!A2:D`;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const values = resp.data.values || [];
  const due = [];

  // We treat "due" as: sendAt <= now and within lookahead window to be resilient
  const nowMs = now.getTime();
  const windowStart = nowMs - SCHEDULE_LOOKAHEAD_MS;

  for (let i = 0; i < values.length; i++) {
    const row = values[i] || [];
    const sendAtRaw = row[0];
    const message = (row[1] ?? "").toString();
    const sent = (row[2] ?? "").toString().trim().toUpperCase();

    if (!sendAtRaw || !message) continue;
    if (sent === "YES") continue;

    // Google Sheets API returns datetimes as strings unless you use valueRenderOption.
    // We'll parse permissively.
    const sendAt = new Date(sendAtRaw);
    if (isNaN(sendAt.getTime())) continue;

    const sendAtMs = sendAt.getTime();

    if (sendAtMs <= nowMs && sendAtMs >= windowStart) {
      // rowIndex in sheet is i + 2 because range starts at A2
      due.push({
        rowIndex: i + 2,
        message,
        sendAt,
      });
    }
  }

  return due;
}

async function markScheduledMessageSent(rowIndex, sentAt = new Date()) {
  const sheets = getSheetsClient();

  // Write "YES" to column C and ISO timestamp to column D
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SCHEDULE_SHEET}!C${rowIndex}:D${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [["YES", toIso(sentAt)]] },
  });
}

/**
 * Polls schedule sheet, sends any due messages, and marks them sent.
 */
async function runScheduleTick() {
  try {
    const due = await getDueScheduledMessages(new Date());
    if (!due.length) return;

    for (const item of due) {
      await postToGroupMe(item.message);
      await markScheduledMessageSent(item.rowIndex, new Date());
    }
  } catch (err) {
    console.error("Schedule tick error:", err);
  }
}


app.post("/groupme", async (req, res) => {
  const msg = req.body;

  try {
    if (!msg) return res.sendStatus(200);

    // Ignore bot messages to prevent loops
    if (msg.sender_type === "bot") return res.sendStatus(200);
    if (GROUPME_BOT_ID && msg.sender_id === GROUPME_BOT_ID) return res.sendStatus(200);

    const text = msg.text?.trim();

    // Respond to "Board Update"
    if (text && text.toLowerCase() === "board update") {
      const board = await buildLeaderboardMessage();
      await postToGroupMe(board);
      return res.sendStatus(200);
    }

// Respond to "Crown Jewel"
if (text && text.toLowerCase() === "crown jewel") {
  const crownMsg = await buildCrownJewelMessage();
  await postToGroupMe(crownMsg);
  return res.sendStatus(200);
}

    
    // Respond to "wins"
    if (text && text.toLowerCase() === "wins") {
      const winsMsg = await buildWinsMessage();
      await postToGroupMe(winsMsg);
      return res.sendStatus(200);
    }

    // Only handle/import messages that contain #
    if (!text || !text.includes("#")) return res.sendStatus(200);

    // Extract first hashtag token (e.g., "#2") from the message
    const pickToken = (text.match(/#[^\s]+/) || [text])[0];

    // Look up driver count from "Driver Count" sheet
    const senderName = msg.name || "";
    const driverCount = await getDriverCountForPick(senderName, pickToken);

    // Respond back to GroupMe
    if (driverCount !== null && driverCount !== undefined && driverCount !== "") {
      await postToGroupMe(`Pick Submitted, ${pickToken} - ${driverCount}`);
    } else {
      await postToGroupMe(`Pick Submitted, ${pickToken} - ?`);
    }

    // Append to Import tab
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
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(200);
  }
});

// Kick off schedule polling
setInterval(() => {
  runScheduleTick();
}, SCHEDULE_POLL_MS);

// Optional: run once at startup
runScheduleTick().catch(() => {});


const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));






