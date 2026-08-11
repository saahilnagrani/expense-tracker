// Read/write a single private JSON file in the user's Google Drive
// "appDataFolder" — a hidden per-user folder that ONLY this app can access
// (not visible in their normal Drive). Used for cross-device sync.
// Uses the access token obtained by gmail.js (scope drive.appdata).

import { getAccessToken } from "./gmail.js";

const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FILENAME = "expense-tracker-data.json";

function authHeader() {
  const t = getAccessToken();
  if (!t) throw new Error("Not connected to Google. Click Connect first.");
  return { Authorization: "Bearer " + t };
}

// Locate the sync file (if it exists yet). Returns { id, modifiedTime } or null.
export async function findFile() {
  const q = encodeURIComponent(`name = '${FILENAME}'`);
  const url = `${FILES}?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&pageSize=5`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) throw new Error(await driveErr("list", res));
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

export async function readFile(id) {
  const res = await fetch(`${FILES}/${id}?alt=media`, { headers: authHeader() });
  if (!res.ok) throw new Error(await driveErr("read", res));
  return res.json();
}

// Create (POST) or update (PATCH) the file with a multipart upload.
export async function writeFile(obj, existingId) {
  const boundary = "etsync" + Math.random().toString(36).slice(2);
  const metadata = existingId ? {} : { name: FILENAME, parents: ["appDataFolder"] };
  const body =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    "Content-Type: application/json\r\n\r\n" +
    JSON.stringify(obj) +
    `\r\n--${boundary}--`;
  const url = existingId
    ? `${UPLOAD}/${existingId}?uploadType=multipart`
    : `${UPLOAD}?uploadType=multipart`;
  const res = await fetch(url, {
    method: existingId ? "PATCH" : "POST",
    headers: { ...authHeader(), "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(await driveErr("write", res));
  return res.json();
}

async function driveErr(op, res) {
  const body = await res.text().catch(() => "");
  return `Drive ${op} failed (${res.status}): ${body.slice(0, 160)}`;
}
