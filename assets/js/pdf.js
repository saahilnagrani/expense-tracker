// Thin wrapper around the vendored pdf.js to turn a PDF (possibly
// password-protected, like bank e-statements) into plain text lines.

import * as pdfjs from "../../vendor/pdfjs/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "../../vendor/pdfjs/pdf.worker.min.mjs",
  import.meta.url
).href;

export class PdfPasswordError extends Error {
  constructor(msg) { super(msg || "Password required"); this.name = "PdfPasswordError"; }
}

// Extract text from PDF bytes. Returns { pages: string[], lines: string[] }.
// `lines` reconstructs rows using item positions so tabular statements read
// closer to how they look on screen. Throws PdfPasswordError if the password
// is wrong or missing.
export async function extractText(bytes, password = "") {
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: bytes,
      password: password || undefined,
      // Statements are text PDFs; disable font/image work we don't need.
      disableFontFace: true,
      isEvalSupported: false,
    }).promise;
  } catch (e) {
    const name = e && (e.name || e.message || "");
    if (/password/i.test(name) || e.code === 1 || e.code === 2) {
      throw new PdfPasswordError(
        password ? "Incorrect PDF password." : "This PDF is password protected."
      );
    }
    throw e;
  }

  const pages = [];
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(content.items.map((i) => i.str).join(" "));
    lines.push(...groupIntoLines(content.items));
  }
  await doc.destroy();
  return { pages, lines, text: lines.join("\n") };
}

// Group text items into visual rows by their y-coordinate, then order each
// row left-to-right by x. Good enough for statement transaction tables.
function groupIntoLines(items) {
  const rows = [];
  const tol = 3; // y tolerance in pdf units
  for (const it of items) {
    if (!it.str || !it.transform) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) <= tol);
    if (!row) { row = { y, cells: [] }; rows.push(row); }
    row.cells.push({ x, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y); // top of page first
  return rows.map((r) =>
    r.cells.sort((a, b) => a.x - b.x).map((c) => c.s).join(" ").replace(/\s+/g, " ").trim()
  ).filter(Boolean);
}
