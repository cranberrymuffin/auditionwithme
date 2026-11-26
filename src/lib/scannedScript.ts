import type { Step } from "../types";
import { loadPdf, renderPdfPageToJpeg } from "./pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { apiFetch } from "./api";
import { apiFailure } from "./parseErrors";
import { PAGES_PER_CHUNK, chunkIsFull } from "./pageChunks";

// Scanned (image-only) PDFs have no text layer, so the fast text parse can't
// run. Instead: render pages to JPEGs in the browser, send them to
// /api/parse-pages in page-range chunks — each chunk parses in parallel while
// later pages are still rendering — then stitch the chunk results together.
// lib/pageChunks.ts decides where one chunk ends and the next begins.

export type ScannedParseResult = {
  steps: Step[];
  characters: string[];
  languageCode: string;
  languageName: string;
};

type ChunkResult = {
  steps?: Step[];
  characters?: string[];
  languageCode?: string;
  languageName?: string;
  error?: string;
};

export type ScannedProgress = {
  renderedPages: number;
  parsedChunks: number;
  totalPages: number;
  totalChunks: number;
};

export type ScannedParseOptions = {
  /** Bilingual editions: transcribe the original language, not the translation */
  preferOriginalLanguage?: boolean;
};

export async function parseScannedPdf(
  file: File,
  /** Rehearsal grant from api/start-rehearsal.ts — reused read-only by every
   * chunk and retry for this upload, never re-requested here. See
   * api/_entitlement.ts and the auth-subscriptions plan's Decision 2. */
  grant: string,
  onProgress?: (progress: ScannedProgress) => void,
  loadedDocument?: PDFDocumentProxy,
  options?: ScannedParseOptions,
): Promise<ScannedParseResult> {
  const document = loadedDocument ?? (await loadPdf(file));
  const totalPages = document.numPages;
  const totalChunks = Math.ceil(totalPages / PAGES_PER_CHUNK);
  const progress: ScannedProgress = {
    renderedPages: 0,
    parsedChunks: 0,
    totalPages,
    totalChunks,
  };

  // Render sequentially (rendering shares the main thread) but fire each
  // chunk's parse request as soon as its pages are ready, so network/model time
  // overlaps with rendering the rest of the document.
  const chunkPromises: Promise<ChunkResult>[] = [];
  const send = (images: string[]) => {
    chunkPromises.push(
      parseChunk(images, grant, options).then((result) => {
        progress.parsedChunks += 1;
        onProgress?.({ ...progress });
        return result;
      }),
    );
    // Until every page is rendered the chunk count is an estimate (by
    // page count); heavy pages split into more.
    progress.totalChunks = Math.max(progress.totalChunks, chunkPromises.length);
  };
  let images: string[] = [];
  let chars = 0;
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const image = await renderPdfPageToJpeg(document, pageNumber);
    if (chunkIsFull(images.length, chars, image.length)) {
      send(images);
      images = [];
      chars = 0;
    }
    images.push(image);
    chars += image.length;
    progress.renderedPages += 1;
    onProgress?.({ ...progress });
  }
  if (images.length) send(images);
  progress.totalChunks = chunkPromises.length;

  const results = await Promise.all(chunkPromises);
  const merged = mergeChunkResults(results);
  return canonicalizeCharacters(merged);
}

/**
 * Collapse per-chunk speaker-name variants ("WIDOW T" vs "WIDOW TWANKEY") into
 * one canonical name per character. Non-fatal: on failure the raw names stay.
 */
async function canonicalizeCharacters(
  result: ScannedParseResult,
): Promise<ScannedParseResult> {
  if (result.characters.length < 2) return result;
  try {
    // Auth-only (rate-limited), not grant-gated — this is bookkeeping for an
    // already-granted upload, not a new billable session (plan Decision 3).
    const response = await apiFetch("/api/casting?action=canonicalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ characters: result.characters }),
    });
    const data = (await response.json()) as {
      canonical?: Record<string, string>;
    };
    if (!response.ok || !data.canonical) return result;
    const canonical = data.canonical;

    const characters: string[] = [];
    for (const name of result.characters) {
      const mapped = canonical[name] ?? name;
      if (!characters.includes(mapped)) characters.push(mapped);
    }
    return {
      ...result,
      characters,
      steps: result.steps.map((step) => ({
        ...step,
        speaker: canonical[step.speaker] ?? step.speaker,
      })),
    };
  } catch (error) {
    console.warn(
      "Character canonicalization failed; keeping raw names.",
      error,
    );
    return result;
  }
}

const CHUNK_MAX_ATTEMPTS = 3; // upstream content filtering is stochastic — retries usually clear it

async function parseChunk(
  images: string[],
  grant: string,
  options?: ScannedParseOptions,
  attempt = 0,
): Promise<ChunkResult> {
  const response = await apiFetch("/api/parse-pages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-rehearsal-grant": grant },
    body: JSON.stringify({
      images,
      preferOriginalLanguage: options?.preferOriginalLanguage,
    }),
  });
  if (!response.ok) {
    // An expired session or grant, a body over the size limit and a rate
    // limit won't clear on an immediate retry — surface them at once
    // instead of burning three attempts. The rest (the upstream content
    // filter, a timeout) are stochastic, and a retry usually clears them.
    const retryable = ![401, 403, 413, 429].includes(response.status);
    if (retryable && attempt < CHUNK_MAX_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      return parseChunk(images, grant, options, attempt + 1);
    }
    throw await apiFailure(response, "A section of the script could not be read.");
  }
  return (await response.json()) as ChunkResult;
}

function mergeChunkResults(results: ChunkResult[]): ScannedParseResult {
  const steps: Step[] = [];
  const characters: string[] = [];
  // Character casing/spelling can drift between chunks — canonicalize to the
  // first-seen form, matched case-insensitively.
  const canonical = new Map<string, string>();

  const canonicalName = (name: string): string => {
    const key = name.trim().toLowerCase();
    if (!key) return "";
    const existing = canonical.get(key);
    if (existing) return existing;
    const cleaned = name.trim();
    canonical.set(key, cleaned);
    return cleaned;
  };

  for (const result of results) {
    let chunkSteps = (result.steps ?? []).map((step) => ({
      ...step,
      speaker: canonicalName(step.speaker),
    }));

    // A leading unlabeled step continues the previous chunk's final speech.
    if (steps.length && chunkSteps.length && !chunkSteps[0].speaker) {
      const previous = steps[steps.length - 1];
      const continuation = chunkSteps[0];
      previous.verbalLine = [previous.verbalLine, continuation.verbalLine]
        .filter(Boolean)
        .join(" ");
      previous.content = [...previous.content, ...continuation.content];
      chunkSteps = chunkSteps.slice(1);
    }

    steps.push(...chunkSteps);
    for (const name of result.characters ?? []) {
      const cleaned = canonicalName(name);
      if (cleaned && !characters.includes(cleaned)) characters.push(cleaned);
    }
  }

  const language = results.find((result) => result.languageCode);
  return {
    steps,
    characters,
    languageCode: language?.languageCode ?? "en",
    languageName: language?.languageName ?? "English",
  };
}
