import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json({ limit: "1mb" }));

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "1xT7jHcFOVIkkcljwtyDj9NlNIP8S7pn9qVNDna7wuEw";
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

// Read a range from the Leaderboard tab and turn it into a GroupMe-friendly message
async function buildLeaderboardMessage() {
  const sheets = getSheetsClient();

  // Adjust range to what you want to display
  // Example: A1:D21 shows header + top 20 rows
  const range = `Leaderboard!A1:D21`;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const values = resp.data.values || [];
  if (!values.length) return "Leaderboard tab is empty.";

  // Simple formatting: rows joined by " | "
  const lines = values.map((row) => row.map((c) => String(c ?? "")).join(" | "));
  return `🏁 Leaderboard\n` + lines.join("\n");
}

// Post a message back to GroupMe as your bot
async function postToGroupMe(text) {
  // GroupMe bot post endpoint
  // Docs: POST /bots/post with bot_id and text :contentReference[oaicite:1]{index=1}
  const url = "https://api.groupme.com/v3/bots/post";

  // GroupMe messages have a max length; to be safe, chunk around 900 chars.
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

function chunkText(text, maxLen) {
  if (!text || text.length <= maxLen) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);

    // Try to split on newline for nicer chunks
    const lastNl = text.lastIndexOf("\n", end);
    if (lastNl > start + 50) end = lastNl;

    chunks.push(text.slice(start, end));
    start = end;
  }

  return chunks;
}


app.post("/groupme", async (req, res) => {
  const msg = req.body;

  try {
    if (!msg) return res.sendStatus(200);

    // Prevent loops + avoid bot chatter
    if (msg.sender_type === "bot") return res.sendStatus(200);
    if (GROUPME_BOT_ID && msg.sender_id === GROUPME_BOT_ID) return res.sendStatus(200);
    // Ignore bot messages
    const text = msg.text?.trim();
    if (!text || !text.includes("#")) {
      return res.sendStatus(200);
    }

// Trigger: Board Update (case-insensitive)
if (text && text.toLowerCase() === "board update") {
  const board = await buildLeaderboardMessage();
  await postToGroupMe(board);
  return res.sendStatus(200);
}
    
    const hasText = typeof msg.text === "string" && msg.text.length > 0;
    const hasAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0;
    if (!hasText && !hasAttachments) return res.sendStatus(200);

    const timestampIso = msg.created_at
      ? new Date(msg.created_at * 1000).toISOString()
      : new Date().toISOString();

    const attachmentsJson = hasAttachments ? JSON.stringify(msg.attachments) : "";

    // Columns: timestamp | group_id | sender_id | sender_name | text | attachments | message_id
    const row = [
      timestampIso,
      msg.group_id || "",
      msg.sender_id || "",
      msg.name || "",
      msg.text || "",
      attachmentsJson,
      msg.id || ""
    ];

    await appendRow(row);
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    // Return 200 to stop GroupMe retries; rely on logs to diagnose
    return res.sendStatus(200);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));


