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

 // Respond to "wins"
    if (text && text.toLowerCase() === "wins") {
      const winsMsg = await buildWinsMessage();
      await postToGroupMe(winsMsg);
      return res.sendStatus(200);
    }
    
    // Only import messages that contain #
    if (!text || !text.includes("#")) return res.sendStatus(200);

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
      text || "",              // ✅ trimmed text saved
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));


