// Client-side Gmail access for a static site (GitHub Pages friendly).
// Uses Google Identity Services (GIS) token flow to get a short-lived
// access token entirely in the browser — no backend, no client secret.
// Requires a Google OAuth *Web* Client ID whose authorized JavaScript
// origins include this site's origin. Scope: gmail.readonly.

const GIS_SRC = "https://accounts.google.com/gsi/client";
// gmail.readonly = read statements; drive.appdata = private per-user sync file
// stored in a hidden Drive folder only this app can see (cross-device sync).
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.appdata";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

let _tokenClient = null;
let _accessToken = null;
let _tokenExpiry = 0;
let _gisLoaded = null;

function loadGis() {
  if (_gisLoaded) return _gisLoaded;
  _gisLoaded = new Promise((resolve, reject) => {
    if (window.google && window.google.accounts) return resolve();
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load Google sign-in library (network blocked?)"));
    document.head.appendChild(s);
  });
  return _gisLoaded;
}

export function isSignedIn() {
  return !!_accessToken && Date.now() < _tokenExpiry - 5000;
}

// Current access token (for Drive REST calls in drive.js). Null if not signed in.
export function getAccessToken() {
  return isSignedIn() ? _accessToken : null;
}

// Interactive sign-in / token request. Must be triggered by a user click.
// `hint` (an email) preselects the account so multi-account users don't have
// to pick every time.
export async function connect(clientId, hint) {
  if (!clientId) throw new Error("Missing Google Client ID. Add it in Settings.");
  await loadGis();
  return new Promise((resolve, reject) => {
    try {
      _tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        hint: hint || undefined,
        callback: (resp) => {
          if (resp.error) return reject(new Error(resp.error_description || resp.error));
          _accessToken = resp.access_token;
          _tokenExpiry = Date.now() + (resp.expires_in ? resp.expires_in * 1000 : 3600 * 1000);
          resolve(true);
        },
      });
      _tokenClient.requestAccessToken({ prompt: _accessToken ? "" : "consent" });
    } catch (e) {
      reject(e);
    }
  });
}

// The connected account's email address (for storing as a future hint).
export async function getProfileEmail() {
  try { const d = await api("/profile"); return d.emailAddress || ""; } catch { return ""; }
}

// Try to restore a token silently on page load (no popup, no re-consent) —
// works when the user has already granted access and has an active Google
// session. Resolves true if a token was obtained, false otherwise.
export async function silentConnect(clientId, hint) {
  if (!clientId) return false;
  try { await loadGis(); } catch { return false; }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      _tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        hint: hint || undefined,
        callback: (resp) => {
          if (resp && resp.access_token) {
            _accessToken = resp.access_token;
            _tokenExpiry = Date.now() + (resp.expires_in ? resp.expires_in * 1000 : 3600 * 1000);
            finish(true);
          } else finish(false);
        },
        error_callback: () => finish(false),
      });
      _tokenClient.requestAccessToken({ prompt: "" }); // silent
      setTimeout(() => finish(false), 6000); // give up quietly
    } catch { finish(false); }
  });
}

export function disconnect() {
  if (_accessToken && window.google) {
    try { google.accounts.oauth2.revoke(_accessToken, () => {}); } catch {}
  }
  _accessToken = null;
  _tokenExpiry = 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (n) => Math.min(8000, 800 * 2 ** n);

// Gmail GET with a per-request timeout and retries. Mobile browsers freeze a
// backgrounded tab and silently drop its in-flight fetches (screen lock, app
// switch), leaving the await hung forever — which is exactly what stalls an
// import mid-way. An AbortController timeout turns that hang into a retryable
// error, and transient 429/5xx responses are retried with backoff too.
async function api(path, { tries = 4, timeoutMs = 30000 } = {}) {
  if (!isSignedIn()) throw new Error("Not connected to Gmail. Click Connect first.");
  const url = API + path;
  const headers = { Authorization: "Bearer " + _accessToken };
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { headers, signal: ctrl.signal });
    } catch (e) {
      // Aborted (timeout) or a dropped connection after backgrounding — retry.
      clearTimeout(timer);
      lastErr = e;
      if (attempt < tries - 1) { await sleep(backoff(attempt)); continue; }
      throw new Error("Network problem reaching Gmail — check your connection and try again.");
    }
    clearTimeout(timer);
    if (res.status === 401) {
      _accessToken = null;
      throw new Error("Gmail session expired. Please connect again.");
    }
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < tries - 1) {
      await sleep(backoff(attempt)); continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Gmail API error ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }
  throw lastErr || new Error("Gmail request failed");
}

// List message ids matching a Gmail search query.
export async function searchMessages(query, max = 50) {
  const out = [];
  let pageToken = "";
  do {
    const q = encodeURIComponent(query);
    const pt = pageToken ? `&pageToken=${pageToken}` : "";
    const data = await api(`/messages?q=${q}&maxResults=100${pt}`);
    (data.messages || []).forEach((m) => out.push(m.id));
    pageToken = data.nextPageToken || "";
  } while (pageToken && out.length < max);
  return out.slice(0, max);
}

// Full message metadata + payload (for headers, body, attachment ids).
export async function getMessage(id) {
  return api(`/messages/${id}?format=full`);
}

// Download an attachment's raw bytes as a Uint8Array.
export async function getAttachment(messageId, attachmentId) {
  const data = await api(`/messages/${messageId}/attachments/${attachmentId}`);
  return b64urlToBytes(data.data);
}

// ---- helpers to pull structured bits out of a Gmail message payload ----
export function header(msg, name) {
  const h = (msg.payload && msg.payload.headers) || [];
  const f = h.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return f ? f.value : "";
}

export function messageDate(msg) {
  // internalDate is ms since epoch as a string.
  const d = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date();
  return d;
}

// Walk MIME parts and return { text, pdfs: [{filename, attachmentId, size}] }
export function extractParts(msg) {
  const pdfs = [];
  let text = "";
  let html = "";
  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || "";
    const fn = part.filename || "";
    const body = part.body || {};
    if (fn && /\.pdf$/i.test(fn) && body.attachmentId) {
      pdfs.push({ filename: fn, attachmentId: body.attachmentId, size: body.size || 0 });
    } else if (mime === "text/plain" && body.data) {
      text += b64urlToText(body.data) + "\n";
    } else if (mime === "text/html" && body.data) {
      html += b64urlToText(body.data) + "\n";
    } else if (fn && /octet-stream/i.test(mime) && body.attachmentId && /\.pdf$/i.test(fn)) {
      pdfs.push({ filename: fn, attachmentId: body.attachmentId, size: body.size || 0 });
    }
    (part.parts || []).forEach(walk);
  };
  walk(msg.payload);
  if (!text && html) text = htmlToText(html);
  return { text, html, pdfs };
}

function b64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToText(b64url) {
  const bytes = b64urlToBytes(b64url);
  return new TextDecoder("utf-8").decode(bytes);
}

function htmlToText(html) {
  const div = document.createElement("div");
  div.innerHTML = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  return (div.textContent || "").replace(/ /g, " ");
}
