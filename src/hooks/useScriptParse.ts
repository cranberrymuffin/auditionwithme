import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { extractPdfLayout, loadPdf, type LayoutLineTuple } from "../lib/pdf";
import { parseScannedPdf } from "../lib/scannedScript";
import { apiFetch } from "../lib/api";
import { ApiError } from "../lib/apiError";
import { useToast } from "../lib/toast";
import { apiFailure, requestRehearsalGrant } from "../lib/parseErrors";
import type { ParseData } from "./useScriptPersistence";

// A parse with no spoken lines means the PDF isn't a script (a resume, a
// headshot, a contract…) — caught right after upload, before it's saved.
const hasSpokenLines = (data: ParseData) =>
  (data.steps ?? []).some((step) => step.verbalLine?.trim());
export const NOT_A_SCRIPT_MESSAGE =
  "We didn't find any spoken lines in this PDF. Upload a script or sides with character names and dialogue.";

// In production the raw "run `vercel dev`" hint is developer noise; keep it dev-only.
const SERVICE_DOWN_MESSAGE = import.meta.env.DEV
  ? "The local script service isn't running. Start it with `vercel dev --listen 3000`."
  : "We couldn't reach the script service. Check your connection and try again.";

/** Reads the PDF and has it parsed: its text layer by /api/parse-script, or
 * its pages by vision where there's no usable text. `onAnalyzing` fires as
 * the PDF has been read and the parse call begins. */
async function parseUpload(
  file: File,
  rehearsalGrant: string,
  onAnalyzing: () => void,
): Promise<ParseData> {
  const pdfDocument = await loadPdf(file);
  let extractedLines: LayoutLineTuple[] | null = null;
  try {
    const extracted = await extractPdfLayout(file, pdfDocument);
    // Sides with a raster markup overlay (X-boxes, START/END cues drawn
    // as an image) can't be honored from the text layer — the vision
    // path sees and applies the markup instead.
    if (extracted.usable && !extracted.sides.visionRecommended) {
      extractedLines = extracted.lines;
    }
  } catch (extractionError) {
    console.warn(
      "PDF text extraction failed; using scanned-page parsing.",
      extractionError,
    );
  }
  onAnalyzing();

  if (extractedLines === null) {
    // Image-only PDF (scan) — render pages and parse chunks with vision.
    return parseScannedPdf(file, rehearsalGrant, undefined, pdfDocument);
  }

  const res = await apiFetch("/api/parse-script", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-rehearsal-grant": rehearsalGrant,
    },
    body: JSON.stringify({ layout: { lines: extractedLines } }),
  });

  // Auth, grant, size, timeout and rate-limit answers each get their own
  // wording (lib/parseErrors.ts); what's left falls through to the generic
  // handling below.
  if ([401, 403, 413, 429, 504].includes(res.status)) {
    throw await apiFailure(res, "Session or rehearsal grant is no longer valid");
  }

  const responseText = await res.text();
  let payload: { error?: string } & ParseData = {};
  if (responseText) {
    try {
      payload = JSON.parse(responseText) as typeof payload;
    } catch {
      throw new Error(
        res.ok
          ? "The script service returned an invalid response."
          : SERVICE_DOWN_MESSAGE,
      );
    }
  }
  if (!res.ok) {
    throw new Error(payload.error || SERVICE_DOWN_MESSAGE);
  }
  if (!responseText)
    throw new Error("The script service returned an empty response.");
  return payload;
}

/**
 * Step 1's parse of a fresh upload: runs once on mount (and again on Try
 * again), then hands the result over — as `pendingParse` (Practice moves on
 * from a clean one, see its auto-continue), or as `languageChoice` for a
 * bilingual edition. Also owns the original-language re-read a bilingual
 * edition can ask for. Does nothing for a replay (`skip`), whose parse is
 * already saved.
 */
export function useScriptParse({
  file,
  rehearsalGrant,
  skip,
  cacheParse,
}: {
  file: File | null;
  /** Issued once by Home.tsx's start-rehearsal call; reused read-only by
   * every parse call here (retries and the bilingual re-parse included). */
  rehearsalGrant: string | null;
  skip: boolean;
  cacheParse: (data: ParseData, needsLanguageChoice: boolean) => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [processingPhase, setProcessingPhase] = useState<
    "extracting" | "analyzing"
  >("extracting");
  const [error, setError] = useState("");
  // The upload parsed fine but holds no dialogue: retrying won't help.
  const [notScript, setNotScript] = useState(false);
  // Too large for the service: the same file would only fail again.
  const [tooLarge, setTooLarge] = useState(false);
  // The grant in use: the one the upload came with, until it expires and a
  // fresh one quietly takes its place (see refreshGrant).
  const grantRef = useRef(rehearsalGrant);
  const [parseAttempt, setParseAttempt] = useState(0);
  // Bilingual editions: holds the translated parse until the user picks a language.
  const [languageChoice, setLanguageChoice] = useState<ParseData | null>(null);
  // Finished parse waiting on the user's "Continue" click — the parsing screen
  // (with the PDF preview) stays up until they choose to proceed.
  const [pendingParse, setPendingParse] = useState<ParseData | null>(null);
  // Which read produced pendingParse: the upload's own parse (Practice moves
  // straight on from a clean one) or the original-language re-read (which
  // always waits for Continue).
  const [parseSource, setParseSource] = useState<"upload" | "original-language">("upload");
  const ranAttempt = useRef(-1);
  // Grant taken here for an original-language read on a re-upload that was
  // served from its saved parse (Home.tsx takes none on a hash hit).
  const lateGrantRef = useRef<string | null>(null);
  // A parse outlives the screen that asked for it (see the effect below),
  // so what it does on landing is checked against this. Set per mount, not
  // per effect run: StrictMode's dev remount must not orphan the one run
  // the ranAttempt guard allows.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** A grant lasts an hour, and an upload can sit on step 1 (or come back
   * through a reload) for longer. A new one costs nothing — it only
   * re-checks the plan — so an expired grant is replaced out of sight
   * rather than sending the actor back to upload again. Null if there's
   * no replacing it. */
  const refreshGrant = async (): Promise<string | null> => {
    try {
      const fresh = await requestRehearsalGrant();
      if (fresh) grantRef.current = fresh;
      return fresh;
    } catch (err) {
      console.warn("Couldn't renew the rehearsal grant:", err);
      return null;
    }
  };

  /** Runs `parse` with the current grant; if the service turns the grant
   * away, once more with a fresh one. */
  const withGrantRetry = async <T,>(grant: string, parse: (grant: string) => Promise<T>): Promise<T> => {
    try {
      return await parse(grant);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 403) throw err;
      const fresh = await refreshGrant();
      if (!fresh) throw err;
      return parse(fresh);
    }
  };

  /** Sends the actor on if `err` is the service turning the session away;
   * false if it's some other failure for the caller to show. */
  const redirectIfUnauthorized = (err: unknown): boolean => {
    if (!(err instanceof ApiError)) return false;
    if (err.status === 401) {
      navigate("/login", { replace: true });
      return true;
    }
    if (err.status === 403) {
      // Only reached when a fresh grant couldn't be had either.
      toast("We couldn’t pick your rehearsal back up. Please upload your script again.");
      navigate("/", { replace: true });
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (skip) return;
    if (!file || !rehearsalGrant) {
      navigate("/", { replace: true });
      return;
    }
    // Guard against StrictMode's dev-mode double-invoke while still allowing
    // the "Try again" button to re-run by bumping parseAttempt.
    if (ranAttempt.current === parseAttempt) return;
    ranAttempt.current = parseAttempt;

    // No AbortController here on purpose: this fetch is a single, non-restartable
    // ~30-60s call. Wiring an abort signal in before the fetch starts means React
    // StrictMode's dev-mode double-invoke (mount -> cleanup -> mount again) aborts
    // it within the same tick, and the ranAttempt guard then blocks any retry —
    // the request silently dies before it can ever complete. So the call runs
    // to the end even if the actor leaves, and only what it does to the screen
    // is held back (mountedRef).
    const run = async () => {
      setLoading(true);
      setError("");
      setNotScript(false);
      setTooLarge(false);
      setPendingParse(null);
      setProcessingPhase("extracting");

      try {
        const data = await withGrantRetry(grantRef.current ?? rehearsalGrant, (grant) =>
          parseUpload(file, grant, () => {
            if (mountedRef.current) setProcessingPhase("analyzing");
          }),
        );

        if (!hasSpokenLines(data)) {
          if (!mountedRef.current) return;
          // Not a script: stop here, before it's saved to the account or
          // the actor can continue into casting.
          setNotScript(true);
          setError(NOT_A_SCRIPT_MESSAGE);
          return;
        }
        // Saved even if the actor has left: the parse is paid for, and
        // coming back to this script finds it instead of parsing again.
        cacheParse(data, Boolean(data.unreadableOriginalLanguage));
        if (!mountedRef.current) return;
        if (data.unreadableOriginalLanguage) {
          // Bilingual edition — let the user pick a language before rehearsing.
          setLanguageChoice(data);
        } else {
          // Practice decides whether this waits for Continue or moves on.
          setParseSource("upload");
          setPendingParse(data);
        }
      } catch (err) {
        if (!mountedRef.current) {
          console.warn("Script parsing failed after the page was left:", err);
          return;
        }
        if (redirectIfUnauthorized(err)) return;
        console.error("Script parsing failed:", err);
        setTooLarge(err instanceof ApiError && err.reason === "too_large");
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    };

    void run();
  }, [parseAttempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const rehearseOriginalLanguage = async () => {
    if (!file || !languageChoice) return;
    const translation = languageChoice;
    setLanguageChoice(null);
    setLoading(true);
    setProcessingPhase("analyzing");
    try {
      // Reuses the same grant as the initial parse — this is a re-parse of
      // the same upload, not a new billable session. A re-upload served from
      // its saved parse never took one, so it takes one now.
      let grant = grantRef.current ?? lateGrantRef.current;
      if (!grant) {
        const issued = await requestRehearsalGrant();
        if (!mountedRef.current) return;
        if (issued === null) {
          toast("Start your free trial or subscribe to keep rehearsing.");
          navigate("/pricing");
          return;
        }
        grant = lateGrantRef.current = issued;
      }
      const result = await withGrantRetry(grant, (current) =>
        parseScannedPdf(file, current, undefined, undefined, {
          preferOriginalLanguage: true,
        }),
      );
      if (!hasSpokenLines(result)) {
        throw new Error(
          "We couldn't read the original language from the printed pages.",
        );
      }
      cacheParse(result, false);
      if (!mountedRef.current) return;
      // Same continue-gate as the initial parse — this path takes minutes, so
      // the user may have stepped away; don't jump into casting unprompted.
      setParseSource("original-language");
      setPendingParse(result);
    } catch (err) {
      if (!mountedRef.current) {
        console.warn("Original-language read failed after the page was left:", err);
        return;
      }
      if (redirectIfUnauthorized(err)) return;
      // Back to the choice with the translation still in hand — the error
      // screen's "Try again" would re-run the whole first parse instead.
      toast(err instanceof Error ? err.message : "An error occurred");
      setLanguageChoice(translation);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  return {
    loading,
    processingPhase,
    error,
    notScript,
    tooLarge,
    retry: () => setParseAttempt((attempt) => attempt + 1),
    languageChoice,
    setLanguageChoice,
    pendingParse,
    parseSource,
    setPendingParse,
    rehearseOriginalLanguage,
  };
}
