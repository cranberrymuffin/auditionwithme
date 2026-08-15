import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  readAnnotationMarkup,
  scanContentMarkup,
  SIDES_END_SENTINEL,
  SIDES_NOTE_PREFIX,
  SIDES_NOTE_SUFFIX,
  SIDES_START_SENTINEL,
  TEXT_CUE,
  type AnnotationMarkup,
  type ContentMarkup,
  type Cue,
  type Exclusion,
} from "./sidesMarkup";

const MIN_TEXT_CHARACTERS = 100;
const MIN_CHARACTERS_PER_PAGE = 25;

// Sides are short excerpts; content-stream markup scanning (an extra pass per
// page) is capped so feature-length scripts skip it.
const CONTENT_SCAN_ALWAYS_MAX_PAGES = 24;
const CONTENT_SCAN_SIDES_MAX_PAGES = 60;
const VISION_ROUTE_MAX_PAGES = 20;

/** [page, x, text] — one visual text line with its left-edge x position. */
export type LayoutLineTuple = [number, number, string];

export type SidesSignals = {
  /** Sides markup (annotations, cues, strikes) was found and applied. */
  detected: boolean;
  /**
   * The document carries a raster markup overlay we cannot read as geometry
   * (Actors Access-style sides) — parse it with vision, not the text layer.
   */
  visionRecommended: boolean;
};

export type PdfLayoutResult = {
  /** Lines in reading order with indentation, for layout-aware parsing */
  lines: LayoutLineTuple[];
  pageCount: number;
  durationMs: number;
  usable: boolean;
  sides: SidesSignals;
};

export async function loadPdf(file: File): Promise<PDFDocumentProxy> {
  const [{ getDocument, GlobalWorkerOptions }, workerModule] =
    await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);

  GlobalWorkerOptions.workerSrc = workerModule.default;
  return getDocument({ data: await file.arrayBuffer() }).promise;
}

type Item = { x: number; width: number; height: number; text: string };
type Row = { y: number; items: Item[] };
type PageData = {
  pageNumber: number;
  rows: Row[];
  markup: AnnotationMarkup;
  content?: ContentMarkup;
};

function rowHeight(row: Row): number {
  return row.items.reduce((h, item) => Math.max(h, item.height), 10);
}

/** Vertical anchor used to test a row against exclusion geometry. */
function rowMidY(row: Row): number {
  return row.y + rowHeight(row) * 0.35;
}

function rowExcluded(row: Row, exclusions: Exclusion[]): boolean {
  if (!exclusions.length) return false;
  const mid = rowMidY(row);
  const rowX0 = Math.min(...row.items.map((item) => item.x));
  const rowX1 = Math.max(...row.items.map((item) => item.x + item.width));
  for (const { kind, rect } of exclusions) {
    if (mid < rect.y0 || mid > rect.y1) continue;
    if (kind === "band") return true;
    const overlap = Math.min(rect.x1, rowX1) - Math.max(rect.x0, rowX0);
    if (overlap >= Math.min((rowX1 - rowX0) * 0.3, 20)) return true;
  }
  return false;
}

/** Drop glyphs crossed by a strikethrough stroke; keeps the rest of the row. */
function dropStruckItems(row: Row, strikes: ContentMarkup["strikes"]): Item[] {
  if (!strikes.length) return row.items;
  return row.items.filter((item) => {
    const centerX = item.x + item.width / 2;
    // Strike sits in the glyph body near the baseline; the tolerance covers
    // varied strike placement without matching strokes a full line away.
    return !strikes.some(
      (strike) =>
        centerX >= strike.x0 - 1 &&
        centerX <= strike.x1 + 1 &&
        Math.abs(strike.y - (row.y + item.height * 0.3)) <=
          Math.max(item.height * 0.55, 5),
    );
  });
}

/**
 * Compute where in a page's row list (sorted top-to-bottom) a cue's sentinel
 * belongs. START snaps to the top of the paragraph it points into so a speech
 * is never cut mid-sentence; END splits directly at the cue.
 */
function cueInsertionIndex(rows: Row[], cue: Cue): number {
  if (!rows.length) return 0;
  let nearest = 0;
  for (let i = 1; i < rows.length; i++) {
    if (Math.abs(rows[i].y - cue.y) < Math.abs(rows[nearest].y - cue.y))
      nearest = i;
  }
  if (cue.kind === "start") {
    if (Math.abs(rows[nearest].y - cue.y) > 40) {
      // Cue floats far from any text — fall back to pure y ordering.
      return rows.findIndex((row) => row.y < cue.y) === -1
        ? rows.length
        : rows.findIndex((row) => row.y < cue.y);
    }
    let index = nearest;
    while (index > 0 && rows[index - 1].y - rows[index].y <= 18) index--;
    return index;
  }
  if (cue.kind === "end") {
    // The cue's box sits beside the last selected line — keep every row whose
    // baseline is at or above the box's bottom edge.
    const below = rows.findIndex((row) => row.y < cue.yBottom);
    return below === -1 ? rows.length : below;
  }
  // Note: insert at its own vertical position.
  const below = rows.findIndex((row) => row.y < cue.y);
  return below === -1 ? rows.length : below;
}

/** Split a row into segments on large horizontal gaps (multi-column text). */
function rowToSegments(row: Row): { x: number; text: string }[] {
  const sorted = [...row.items].sort((a, b) => a.x - b.x);
  type Segment = { x: number; end: number; text: string };
  const segments: Segment[] = [];
  let segment: Segment | null = null;
  for (const item of sorted) {
    if (segment && item.x - segment.end > 50) {
      segments.push(segment);
      segment = null;
    }
    if (!segment)
      segment = { x: item.x, end: item.x + item.width, text: item.text };
    else {
      // Some PDFs emit one item per glyph (including the space glyph itself),
      // so a real inter-word space is already in `item.text` — adding another
      // one here would space out every single letter. Only synthesize a space
      // for a real positional gap (word-spacing encoded purely via cursor
      // movement, no dedicated space glyph), and never when either side
      // already carries whitespace.
      const gap = item.x - segment.end;
      const alreadySpaced = /\s$/.test(segment.text) || /^\s/.test(item.text);
      const needsSpace = !alreadySpaced && gap > item.height * 0.15;
      segment.text += (needsSpace ? " " : "") + item.text;
      segment.end = Math.max(segment.end, item.x + item.width);
    }
  }
  if (segment) segments.push(segment);
  return segments
    .map((part) => ({ x: part.x, text: part.text.replace(/\s+/g, " ").trim() }))
    .filter((part) => part.text);
}

/**
 * Extract text as visual lines with indentation (x position), with audition
 * sides markup applied: struck/covered/slashed content is dropped, START/END
 * cues become sentinel lines the server resolves into selection bounds, and
 * margin notes are carried along as parenthetical cue lines.
 */
export async function extractPdfLayout(
  file: File,
  loadedDocument?: PDFDocumentProxy,
): Promise<PdfLayoutResult> {
  const startedAt = performance.now();
  const document = loadedDocument ?? (await loadPdf(file));
  const pages: PageData[] = [];
  let annotationMarkupFound = false;
  let textCueFound = false;

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();

    // Group items into visual lines by y position (2pt tolerance).
    const rows: Row[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) <= 2);
      if (!row) {
        row = { y, items: [] };
        rows.push(row);
      }
      row.items.push({
        x,
        width: item.width ?? 0,
        height: item.height || 10,
        text: item.str,
      });
    }
    rows.sort((a, b) => b.y - a.y); // top of page first

    const markup = readAnnotationMarkup(await page.getAnnotations());
    if (markup.exclusions.length || markup.cues.length)
      annotationMarkupFound = true;
    if (
      !textCueFound &&
      rows.some((row) => rowToSegments(row).some((s) => TEXT_CUE.test(s.text)))
    ) {
      textCueFound = true;
    }

    pages.push({ pageNumber, rows, markup });
  }

  // Content-stream markup pass (baked-in strikes/covers, raster overlays).
  // Capped by page count — sides are short excerpts.
  let sidesDetected = annotationMarkupFound || textCueFound;
  const runContentScan =
    document.numPages <= CONTENT_SCAN_ALWAYS_MAX_PAGES ||
    (sidesDetected && document.numPages <= CONTENT_SCAN_SIDES_MAX_PAGES);
  if (runContentScan) {
    let struckRows = 0;
    for (const pageData of pages) {
      const page = await document.getPage(pageData.pageNumber);
      pageData.content = await scanContentMarkup(page);
      for (const row of pageData.rows) {
        if (
          pageData.content.strikes.some(
            (strike) =>
              Math.abs(strike.y - (row.y + rowHeight(row) * 0.3)) <=
              Math.max(rowHeight(row) * 0.55, 5),
          )
        ) {
          struckRows += 1;
        }
      }
    }
    // Multiple strikethrough strokes at text height are themselves a sides
    // signal, even without annotations or cue text.
    if (struckRows >= 2) sidesDetected = true;
  }

  const lines: LayoutLineTuple[] = [];
  let meaningfulCharacters = 0;
  let overlayTextPages = 0;

  for (const pageData of pages) {
    const { pageNumber, markup, content } = pageData;
    const exclusions: Exclusion[] = [
      ...markup.exclusions,
      // Content-stream white covers hide text that still extracts; only
      // trusted once the document is known to be marked-up sides.
      ...(sidesDetected && content
        ? content.covers.map((rect): Exclusion => ({ kind: "box", rect }))
        : []),
    ];

    let rows = pageData.rows.filter((row) => !rowExcluded(row, exclusions));
    if (sidesDetected && content?.strikes.length) {
      rows = rows
        .map((row) => ({
          y: row.y,
          items: dropStruckItems(row, content.strikes),
        }))
        .filter((row) => row.items.length > 0);
    }

    const pageChars = rows.reduce(
      (n, row) =>
        n +
        row.items.reduce(
          (m, item) => m + item.text.replace(/\s/g, "").length,
          0,
        ),
      0,
    );
    if (content?.hasImageOverlay && pageChars >= 200) overlayTextPages += 1;

    // Merge annotation cues into the row stream as sentinel lines.
    const inserts = markup.cues
      .map((cue) => ({ cue, index: cueInsertionIndex(rows, cue) }))
      .sort((a, b) => a.index - b.index);
    let insertCursor = 0;
    const emitCue = (cue: Cue) => {
      const text =
        cue.kind === "start"
          ? SIDES_START_SENTINEL
          : cue.kind === "end"
            ? SIDES_END_SENTINEL
            : `${SIDES_NOTE_PREFIX}${cue.text ?? ""}${SIDES_NOTE_SUFFIX}`;
      lines.push([pageNumber, 0, text]);
    };

    for (let i = 0; i <= rows.length; i++) {
      while (
        insertCursor < inserts.length &&
        inserts[insertCursor].index === i
      ) {
        emitCue(inserts[insertCursor].cue);
        insertCursor += 1;
      }
      if (i === rows.length) break;
      for (const segment of rowToSegments(rows[i])) {
        lines.push([pageNumber, Math.round(segment.x), segment.text]);
        meaningfulCharacters += segment.text.replace(/\s/g, "").length;
      }
    }
  }

  const visionRecommended =
    !sidesDetected &&
    document.numPages <= VISION_ROUTE_MAX_PAGES &&
    overlayTextPages >= 2 &&
    overlayTextPages >= document.numPages / 2;

  return {
    lines,
    pageCount: document.numPages,
    durationMs: performance.now() - startedAt,
    usable:
      meaningfulCharacters >= MIN_TEXT_CHARACTERS &&
      meaningfulCharacters / Math.max(document.numPages, 1) >=
        MIN_CHARACTERS_PER_PAGE,
    sides: { detected: sidesDetected, visionRecommended },
  };
}

// Scanned pages are sent to vision models, which downscale past ~1568px anyway —
// rendering larger only wastes upload bytes.
const RENDER_MAX_DIMENSION = 1536;
const RENDER_JPEG_QUALITY = 0.8;

/** Render one page to a base64 JPEG (no data: prefix) for vision parsing. */
export async function renderPdfPageToJpeg(
  document: PDFDocumentProxy,
  pageNumber: number,
): Promise<string> {
  const page = await document.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(
    RENDER_MAX_DIMENSION / Math.max(base.width, base.height),
    3,
  );
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
