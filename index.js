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

app.post("/groupme", async (req, res) => {
  const msg = req.body;

  try {
    if (!msg) return res.sendStatus(200);

    // Prevent loops + avoid bot chatter
    if (msg.sender_type === "bot") return res.sendStatus(200);
    if (GROUPME_BOT_ID && msg.sender_id === GROUPME_BOT_ID) return res.sendStatus(200);

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
