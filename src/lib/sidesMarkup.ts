import type { PDFPageProxy } from "pdfjs-dist";

// Audition sides carry production markup that decides what the actor performs:
// struck-out blocks (cut), START/END margin cues (selection bounds), FYI
// sections (context only), and margin notes (acting directions). This module
// reads that markup from the two places it lives in real sides PDFs:
//
//   - PDF annotations (Line slashes, Square white-outs, FreeText cues) — used
//     by Kill Royale-style, Highland, and date-stamped sides.
//   - The page content stream (red strikethrough strokes, white cover
//     rectangles) — used by sides with markup baked into the page.
//
// A third style (Actors Access) rasterizes all markup into a full-page image
// overlay; that's undetectable as geometry, so we only *detect* it here and the
// caller routes those documents to the vision parser.

export type Rect = { x0: number; y0: number; x1: number; y1: number };
/** Full-width horizontal band (vertical "FYI" rule) or a bounded box. */
export type Exclusion = { kind: "band" | "box"; rect: Rect };
export type CueKind = "start" | "end" | "note";
export type Cue = {
  kind: CueKind;
  /** Vertical center of the cue's annotation box. */
  y: number;
  /** Bottom edge of the box — an END cue keeps rows down to this line. */
  yBottom: number;
  text?: string;
};
export type StrikeSegment = { x0: number; x1: number; y: number };

export type AnnotationMarkup = { exclusions: Exclusion[]; cues: Cue[] };
export type ContentMarkup = {
  strikes: StrikeSegment[];
  covers: Rect[];
  /** A raster overlay large enough to hold markup we can't read as geometry. */
  hasImageOverlay: boolean;
};

/** Sentinels injected into the layout line stream; resolved server-side. */
export const SIDES_START_SENTINEL = "⟦SIDES:START⟧";
export const SIDES_END_SENTINEL = "⟦SIDES:END⟧";
export const SIDES_NOTE_PREFIX = "⟦SIDES:NOTE:";
export const SIDES_NOTE_SUFFIX = "⟧";

/** Text-layer cue lines ("START >", "< END") — sides markup typed into the page. */
export const TEXT_CUE = /^(?:START\s*>*|>+\s*START|<+\s*END|END\s*<*|STOP)$/;

const CUE_START = /^start\b/i;
const CUE_END = /^(?:end|stop)\b/i;
// Sides furniture that shows up as FreeText: titles, dates, page counters.
const CUE_FURNITURE = [
  /^\d{1,3}\s*\/\s*\d{1,3}$/, // "1/4"
  /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/, // "03.02.26"
  /^cont/i, // "CONT…"
  /^sc(?:ene)?\.?\s*\d+$/i, // "Sc. 1", "Scene 2"
  /\bsides?\b/i, // "LOLLY SIDES 1", "SILAS JENKINS Side"
  /^pg\s+\d+/i,
  /^role\b/i,
];

function classifyCueText(joined: string): CueKind | null {
  const text = joined.trim();
  if (!text) return null;
  if (CUE_FURNITURE.some((re) => re.test(text))) return null;
  if (CUE_START.test(text)) return "start";
  if (CUE_END.test(text)) return "end";
  if (text.length >= 12) return "note";
  return null;
}

type AnnotationLike = {
  subtype?: string;
  rect?: number[];
  lineCoordinates?: number[];
  quadPoints?: unknown;
  textContent?: string[];
};

/**
 * Read exclusion geometry and cue markers from a page's annotations.
 * Coordinates are PDF user space (y up), same space as text item transforms.
 */
export function readAnnotationMarkup(
  annotations: AnnotationLike[],
): AnnotationMarkup {
  const exclusions: Exclusion[] = [];
  const cues: Cue[] = [];

  for (const annotation of annotations) {
    const rect = annotation.rect;
    if (!rect || rect.length !== 4) continue;
    const box: Rect = {
      x0: Math.min(rect[0], rect[2]),
      y0: Math.min(rect[1], rect[3]),
      x1: Math.max(rect[0], rect[2]),
      y1: Math.max(rect[1], rect[3]),
    };

    switch (annotation.subtype) {
      case "Square": {
        // White-out cover boxes. Small squares (stamps, boxed titles) are not
        // exclusions — require a region large enough to hide script content.
        if (box.x1 - box.x0 >= 150 && box.y1 - box.y0 >= 60) {
          exclusions.push({ kind: "box", rect: box });
        }
        break;
      }
      case "StrikeOut": {
        exclusions.push({ kind: "box", rect: box });
        break;
      }
      case "Line": {
        const [lx0, ly0, lx1, ly1] = annotation.lineCoordinates ?? [
          box.x0,
          box.y0,
          box.x1,
          box.y1,
        ];
        const dx = Math.abs(lx1 - lx0);
        const dy = Math.abs(ly1 - ly0);
        const boxW = box.x1 - box.x0;
        const boxH = box.y1 - box.y0;
        if ((dx >= 60 && dy >= 60) || (boxW >= 100 && boxH >= 100)) {
          // Diagonal slash across a block — everything the slash's box touches
          // is cut. Some writers emit degenerate lineCoordinates, so a rect
          // tall AND wide enough to bound a slash counts too (cue arrows and
          // underlines have thin rects and never match).
          exclusions.push({ kind: "box", rect: box });
        } else if (dx < 30 && dy >= 60) {
          // Vertical rule beside/through a passage ("FYI", context-only) —
          // excludes the passage's full vertical extent regardless of x.
          exclusions.push({ kind: "band", rect: box });
        }
        // Short horizontal lines are arrows/underlines next to cues — ignore.
        break;
      }
      case "FreeText": {
        const joined = (annotation.textContent ?? []).join(" ").trim();
        const kind = classifyCueText(joined);
        if (kind) {
          cues.push({
            kind,
            y: (box.y0 + box.y1) / 2,
            yBottom: box.y0,
            ...(kind === "note" ? { text: joined } : {}),
          });
        }
        break;
      }
    }
  }

  return { exclusions, cues };
}

// ── Content-stream markup (baked-in strikes, white covers, raster overlays) ──

type Matrix = [number, number, number, number, number, number];

function multiply(a: Matrix | number[], b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

const isWhite = (rgb: number[]) =>
  rgb.length === 3 && rgb.every((c) => c >= 245);

/**
 * Scan a page's operator list for markup drawn into the content stream:
 * near-horizontal colored strokes at text height (strikethroughs), large
 * white fill rectangles (cover boxes hiding text that still extracts), and
 * page-sized raster images (Actors Access-style overlays).
 */
export async function scanContentMarkup(
  page: PDFPageProxy,
): Promise<ContentMarkup> {
  const { OPS, AnnotationMode } = await import("pdfjs-dist");
  // Annotation appearances are handled separately (readAnnotationMarkup) and
  // arrive here with unapplied positioning transforms — exclude them so an
  // annotation's white box is never mistaken for a content-stream cover.
  const operators = await page.getOperatorList({
    intent: "display",
    annotationMode: AnnotationMode.DISABLE,
  });
  const [vx0, vy0, vx1, vy1] = page.view;
  const pageArea = Math.abs((vx1 - vx0) * (vy1 - vy0));

  const strikes: StrikeSegment[] = [];
  const coverCandidates: { rect: Rect; opIndex: number }[] = [];
  const textPoints: { x: number; y: number; opIndex: number }[] = [];
  let overlayArea = 0;

  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  let fillColor = [0, 0, 0];
  let strokeColor = [0, 0, 0];
  const stack: { ctm: Matrix; fillColor: number[]; strokeColor: number[] }[] =
    [];

  for (let i = 0; i < operators.fnArray.length; i++) {
    const fn = operators.fnArray[i];
    const args = operators.argsArray[i];

    if (fn === OPS.save) {
      stack.push({ ctm, fillColor, strokeColor });
    } else if (fn === OPS.restore) {
      const prev = stack.pop();
      if (prev) ({ ctm, fillColor, strokeColor } = prev);
    } else if (fn === OPS.transform) {
      ctm = multiply(args as number[], ctm);
    } else if (fn === OPS.setFillRGBColor) {
      fillColor = args as number[];
    } else if (fn === OPS.setStrokeRGBColor) {
      strokeColor = args as number[];
    } else if (fn === OPS.setTextMatrix) {
      const m = args as number[];
      const [tx, ty] = applyMatrix(ctm, m[4], m[5]);
      textPoints.push({ x: tx, y: ty, opIndex: i });
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageMaskXObject
    ) {
      // Images paint into the unit square under the CTM; the determinant is
      // the painted area in page space.
      overlayArea = Math.max(
        overlayArea,
        Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]),
      );
    } else if (fn === OPS.constructPath) {
      const next = operators.fnArray[i + 1];
      const isStroke = next === OPS.stroke;
      const isFill = next === OPS.fill || next === OPS.eoFill;
      if (!isStroke && !isFill) continue;

      const [subOps, coords] = args as [number[], number[]];
      let ci = 0;
      let cursor: [number, number] | null = null;
      for (const subOp of subOps) {
        if (subOp === OPS.moveTo) {
          cursor = applyMatrix(ctm, coords[ci], coords[ci + 1]);
          ci += 2;
        } else if (subOp === OPS.lineTo) {
          const point = applyMatrix(ctm, coords[ci], coords[ci + 1]);
          ci += 2;
          if (isStroke && cursor && !isWhite(strokeColor)) {
            const dx = Math.abs(point[0] - cursor[0]);
            const dy = Math.abs(point[1] - cursor[1]);
            if (dy <= 2.5 && dx >= 18) {
              strikes.push({
                x0: Math.min(cursor[0], point[0]),
                x1: Math.max(cursor[0], point[0]),
                y: (cursor[1] + point[1]) / 2,
              });
            }
          }
          cursor = point;
        } else if (subOp === OPS.curveTo) {
          ci += 6;
          cursor = null;
        } else if (subOp === OPS.curveTo2 || subOp === OPS.curveTo3) {
          ci += 4;
          cursor = null;
        } else if (subOp === OPS.rectangle) {
          const [x, y, w, h] = coords.slice(ci, ci + 4);
          ci += 4;
          const [px0, py0] = applyMatrix(ctm, x, y);
          const [px1, py1] = applyMatrix(ctm, x + w, y + h);
          const rect: Rect = {
            x0: Math.min(px0, px1),
            y0: Math.min(py0, py1),
            x1: Math.max(px0, px1),
            y1: Math.max(py0, py1),
          };
          const width = rect.x1 - rect.x0;
          const height = rect.y1 - rect.y0;
          if (isFill && isWhite(fillColor)) {
            // Page-sized backgrounds aren't covers; require a mid-sized region.
            const clippedArea =
              Math.max(0, Math.min(rect.x1, vx1) - Math.max(rect.x0, vx0)) *
              Math.max(0, Math.min(rect.y1, vy1) - Math.max(rect.y0, vy0));
            if (clippedArea < pageArea * 0.9 && width >= 120 && height >= 60) {
              coverCandidates.push({ rect, opIndex: i });
            }
          }
        } else if (subOp === OPS.closePath) {
          cursor = null;
        }
      }
    }
  }

  // A cover only hides something if it was painted AFTER text it overlaps —
  // white rectangles painted before the text are just backgrounds.
  const covers = coverCandidates
    .filter(({ rect, opIndex }) =>
      textPoints.some(
        (point) =>
          point.opIndex < opIndex &&
          point.x >= rect.x0 &&
          point.x <= rect.x1 &&
          point.y >= rect.y0 &&
          point.y <= rect.y1,
      ),
    )
    .map(({ rect }) => rect);

  return { strikes, covers, hasImageOverlay: overlayArea >= pageArea * 0.25 };
}
