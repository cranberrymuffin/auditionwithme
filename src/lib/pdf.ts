import type { PDFDocumentProxy } from "pdfjs-dist";

const MIN_TEXT_CHARACTERS = 100;
const MIN_CHARACTERS_PER_PAGE = 25;

/** [page, x, text] — one visual text line with its left-edge x position. */
export type LayoutLineTuple = [number, number, string];

export type PdfLayoutResult = {
  /** Lines in reading order with indentation, for layout-aware parsing */
  lines: LayoutLineTuple[];
  pageCount: number;
  durationMs: number;
  usable: boolean;
};

export async function loadPdf(file: File): Promise<PDFDocumentProxy> {
  const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);

  GlobalWorkerOptions.workerSrc = workerModule.default;
  return getDocument({ data: await file.arrayBuffer() }).promise;
}

/**
 * Extract text as visual lines with indentation (x position). The layout lets
 * the server classify screenplay lines deterministically; strategies that only
 * need plain text flatten these lines server-side.
 */
export async function extractPdfLayout(
  file: File,
  loadedDocument?: PDFDocumentProxy
): Promise<PdfLayoutResult> {
  const startedAt = performance.now();
  const document = loadedDocument ?? (await loadPdf(file));
  const lines: LayoutLineTuple[] = [];
  let meaningfulCharacters = 0;

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();

    // Group items into visual lines by y position (2pt tolerance).
    type Row = { y: number; items: { x: number; width: number; text: string }[] };
    const rows: Row[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) <= 2);
      if (!row) {
        row = { y, items: [] };
        rows.push(row);
      }
      row.items.push({ x, width: item.width ?? 0, text: item.str });
    }

    rows.sort((a, b) => b.y - a.y); // top of page first
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      // Split multi-column rows (e.g. bilingual editions, side-by-side text)
      // on large horizontal gaps so each column becomes its own line.
      type Segment = { x: number; end: number; text: string };
      const segments: Segment[] = [];
      let segment: Segment | null = null;
      for (const item of row.items) {
        if (segment && item.x - segment.end > 50) {
          segments.push(segment);
          segment = null;
        }
        if (!segment) segment = { x: item.x, end: item.x + item.width, text: item.text };
        else {
          segment.text += ` ${item.text}`;
          segment.end = Math.max(segment.end, item.x + item.width);
        }
      }
      if (segment) segments.push(segment);

      for (const part of segments) {
        const text = part.text.replace(/\s+/g, " ").trim();
        if (!text) continue;
        lines.push([pageNumber, Math.round(part.x), text]);
        meaningfulCharacters += text.replace(/\s/g, "").length;
      }
    }
    page.cleanup();
  }

  return {
    lines,
    pageCount: document.numPages,
    durationMs: performance.now() - startedAt,
    usable:
      meaningfulCharacters >= MIN_TEXT_CHARACTERS &&
      meaningfulCharacters / Math.max(document.numPages, 1) >= MIN_CHARACTERS_PER_PAGE,
  };
}

// Scanned pages are sent to vision models, which downscale past ~1568px anyway —
// rendering larger only wastes upload bytes.
const RENDER_MAX_DIMENSION = 1536;
const RENDER_JPEG_QUALITY = 0.8;

/** Render one page to a base64 JPEG (no data: prefix) for vision parsing. */
export async function renderPdfPageToJpeg(
  document: PDFDocumentProxy,
  pageNumber: number
): Promise<string> {
  const page = await document.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(RENDER_MAX_DIMENSION / Math.max(base.width, base.height), 3);
  const viewport = page.getViewport({ scale });

  const canvas = window.document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");

  await page.render({ canvasContext: context, viewport }).promise;
  const dataUrl = canvas.toDataURL("image/jpeg", RENDER_JPEG_QUALITY);
  page.cleanup();
  canvas.width = 0;
  canvas.height = 0;

  return dataUrl.split(",")[1];
}

