/**
 * documentParse: extract text/markdown from PDF, DOCX, XLSX and Markdown files
 * so the model can read them (small local models can't consume raw files).
 *
 * Runs in the main (Node) process. PDF uses pdfjs-dist, loaded via dynamic
 * import because pdfjs-dist v6 is ESM-only while the main process compiles to
 * CommonJS. PDF extraction is best-effort: a scanned PDF with no text layer —
 * or any extraction failure — returns a graceful "could not extract" note
 * rather than throwing, because the primary image path is an OCR/vision model.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import mammoth from "mammoth";
import { Workbook } from "exceljs";

export interface DocumentParseResult {
  mimeType: string;
  text: string;
}

/**
 * mammoth's `.d.ts` only declares `convertToHtml`; `convertToMarkdown` exists at
 * runtime, so narrow it here. Mammoth's input accepts { path | buffer | file }.
 */
const { convertToMarkdown } = mammoth as unknown as {
  convertToMarkdown: (input: { buffer: ArrayBuffer }) => Promise<{ value: string; messages: unknown[] }>;
};

/** Max rows/columns rendered per XLSX sheet before truncating the table. */
const MAX_ROWS = 200;
const MAX_COLS = 40;

/**
 * Parse a file on disk into `{ mimeType, text }`. `mimeType` may be omitted and
 * is derived from the file extension. Throws for unsupported types.
 */
export async function parseDocument(
  path: string,
  mimeType?: string,
): Promise<DocumentParseResult> {
  const mime = mimeType ?? mimeTypeFromPath(path);
  // `readFileSync` buffers may share a single backing ArrayBuffer (Node reuses
  // it across calls), so copy the bytes into a fresh ArrayBuffer before
  // parsing — otherwise a later read would overwrite an earlier file's bytes.
  // The copy is accepted by pdfjs (data), mammoth (source) and exceljs (load)
  // without conversion, avoiding Buffer/Uint8Array typing churn across the libs.
  const bytes = readFileSync(path);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const arrayBuffer: ArrayBuffer = copy.buffer;

  switch (mime) {
    case "application/pdf":
      return { mimeType: mime, text: await extractPdf(arrayBuffer) };
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return { mimeType: mime, text: await extractDocx(arrayBuffer) };
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return { mimeType: mime, text: await extractXlsx(arrayBuffer) };
    case "text/markdown":
    case "text/plain":
      return { mimeType: mime, text: new TextDecoder().decode(arrayBuffer) };
    default:
      throw new Error(`unsupported file type "${mime}" for ${path}`);
  }
}

/* ----------------------------- parsers ------------------------------ */

/** pdfjs-dist v6 is ESM-only; dynamic import + a file:// worker URL. */
async function loadPdfJs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    const { createRequire } = await import("node:module");
    const workerPath = createRequire(__filename).resolve(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    );
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
  } catch {
    /* worker is optional — pdfjs runs inline (slower) if it can't be found */
  }
  return pdfjs;
}

/**
 * Best-effort text extraction. Scanned/image PDFs return a graceful note.
 *
 * No standardFontDataUrl: pdfjs loads base-14 font data with fetch(), which
 * can't read file:// URLs in the Node worker thread — passing the bundled
 * pdfjs-dist/standard_fonts dir trades one console warning for a failed
 * fetch. Text extraction needs no font data; real PDFs embed font subsets
 * anyway, so the warning only appears for the rare non-embedded base-14 PDF.
 */
async function extractPdf(bytes: ArrayBuffer): Promise<string> {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const text = await page.getTextContent();
    const str = text.items.map((item: any) => item.str ?? "").join(" ");
    pages.push(`--- Page ${i}/${doc.numPages} ---\n${str.trim()}`);
  }
  const all = pages.join("\n\n").trim();
  return (
    all ||
    "(no extractable text layer — this looks like a scanned image; use an OCR or vision model to read it)"
  );
}

async function extractDocx(bytes: ArrayBuffer): Promise<string> {
  const { value } = await convertToMarkdown({ buffer: bytes });
  return value.trim() || "(no extractable text in the DOCX)";
}

async function extractXlsx(bytes: ArrayBuffer): Promise<string> {
  const workbook = new Workbook();
  await workbook.xlsx.load(bytes);

  const sheets: string[] = [];
  workbook.worksheets.forEach((sheet) => {
    const matrix: string[][] = [];
    sheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell((cell) => cells.push(cellToString(cell.value)));
      if (cells.some((c) => c.length > 0)) matrix.push(cells);
    });
    sheets.push(`### Sheet: ${sheet.name}\n\n${buildTable(matrix)}`);
  });
  return sheets.join("\n\n");
}

/* ----------------------------- formatting --------------------------- */

/** Render a markdown table from a 2D string matrix (header = first row). */
function buildTable(matrix: string[][]): string {
  if (!matrix.length) return "(empty sheet)";
  const rows = matrix.slice(0, MAX_ROWS + 1);
  const header = rows[0];
  const cols = Math.min(header.length, MAX_COLS);
  const head = `| ${header.slice(0, cols).map(escapeCell).join(" | ")} |`;
  const sep = `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`;
  const body = rows.slice(1).map((r) => `| ${r.slice(0, cols).map(escapeCell).join(" | ")} |`);
  const out = [head, sep, ...body];
  if (matrix.length > MAX_ROWS || header.length > MAX_COLS) {
    out.push(`… (truncated to ${MAX_ROWS} rows × ${MAX_COLS} columns)`);
  }
  return out.join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Flatten an ExcelJS cell value (string/number/Date/Hyperlink/RichText) to text. */
function cellToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return `[error: ${value.message}]`;
  if (Array.isArray(value)) return value.map((r: { text: string }) => r.text).join(" ");
  const hyper = value as { target?: string };
  if (hyper && typeof hyper.target === "string") return hyper.target;
  return String(value);
}

/* ------------------------------ helpers ----------------------------- */

function mimeTypeFromPath(path: string): string {
  const ext = path.replace(/.*[.]/, "").toLowerCase();
  return (
    {
      pdf: "application/pdf",
      md: "text/markdown",
      markdown: "text/markdown",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }[ext] || "application/octet-stream"
  );
}
