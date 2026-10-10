import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Step } from "../types";
import { normalizeSpeaker, type Voice } from "../lib/script";
import ParsingScreen from "../components/practice/ParsingScreen";
import RolePicker from "../components/practice/RolePicker";
import VoiceCasting from "../components/practice/VoiceCasting";
import Rehearsal from "../components/practice/Rehearsal";
import StageShell from "../components/practice/StageShell";
import { extractPdfLayout, loadPdf, type LayoutLineTuple } from "../lib/pdf";
import { parseScannedPdf } from "../lib/scannedScript";
import { useToast } from "../lib/toast";
import { apiFetch } from "../lib/api";
import { ApiError } from "../lib/apiError";
import { useAuth } from "../contexts/AuthContext";
import { saveScript, updateScript } from "../lib/scriptStore";
import { hashFile } from "../lib/scriptHash";
import { createParseCache, type CachedParseFields } from "../lib/parseCache";
import { DIRECTOR_VERSION } from "../lib/director";
import { leadingDirections } from "../lib/delivery";
import { useSeo } from "../components/Seo";
import { useReaderAudioPregen } from "../hooks/useReaderAudioPregen";
import { loadUpload, peekUpload } from "../lib/pendingUpload";
import { useStartRehearsal } from "../hooks/useStartRehearsal";

// Passed via navigate("/practice", { state: { replayScript } }) from My
// Account — re-launches practice from a script that's already been parsed,
// so no parse-script AI call happens for this session.
type ReplayScript = {
  /** Saved row id — present so casting/direction updates land on the row. */
  id?: string;
  title: string;
  steps: Step[];
  characters: string[];
  languageCode: string;
  languageName: string;
  /** Casting confirmed in a past rehearsal, speaker → voice id. */
  characterVoices?: Record<string, string> | null;
  /** Scene partner levels from a past rehearsal, speaker → gain. */
  characterVolumes?: Record<string, number> | null;
  /** AI-director delivery tags from a past parse, aligned with steps. */
  deliveryTags?: (string | null)[] | null;
  /** DIRECTOR_VERSION those tags were generated under (null/absent = stale). */
  directorVersion?: number | null;
  /** Characters previously rehearsed as, from the saved script row. */
  rolesRead?: string[] | null;
  /** Bilingual edition saved before its language was picked: ask again. */
  needsLanguageChoice?: boolean;
};

type ParseData = {
  steps?: Step[];
  characters?: string[];
  languageCode?: string;
  languageName?: string;
  /** Bilingual edition whose original-language text couldn't be extracted */
  unreadableOriginalLanguage?: boolean;
};

// In production the raw "run `vercel dev`" hint is developer noise; keep it dev-only.
const SERVICE_DOWN_MESSAGE = import.meta.env.DEV
  ? "The local script service isn't running. Start it with `vercel dev --listen 3000`."
  : "We couldn't reach the script service. Check your connection and try again.";

// Each wizard step has its own URL, so Back/Forward, reloads and the
// address bar all agree on where the actor is (MDN, History API).
const STEP_PATHS = ["/practice", "/practice/role", "/practice/voices", "/practice/rehearse"];
const stepFromPath = (pathname: string) => {
  const index = STEP_PATHS.indexOf(pathname.replace(/\/+$/, ""));
  return index === -1 ? 0 : index;
};

export default function Practice() {
  const location = useLocation();
  // Step 1's Replace script starts a new upload on this same route; keying
  // by its session starts the whole flow over for the new script.
  return <PracticeSession key={location.state?.session ?? "none"} />;
}

/** Finds the uploaded PDF (by the id Home put in history state) before the
 * flow mounts: this tab's copy at once, or IndexedDB's after a reload. */
function PracticeSession() {
  const location = useLocation();
  const [uploadId] = useState<string | null>(() => location.state?.uploadId ?? null);
  const [upload, setUpload] = useState<{ file: File | null } | null>(() =>
    !uploadId ? { file: null } : (() => {
      const file = peekUpload(uploadId);
      return file ? { file } : null;
    })(),
  );
  useEffect(() => {
    if (upload || !uploadId) return;
    let active = true;
    void loadUpload(uploadId).then((file) => {
      if (active) setUpload({ file });
    });
    return () => {
      active = false;
    };
  }, [upload, uploadId]);

  if (!upload) return <div className="cinematic-page" aria-busy="true" />;
  return <PracticeFlow file={upload.file} />;
}

// The steps' names, as the step counters show them.
const STEP_TITLES = ["Rehearsal setup", "Cast yourself", "Direct your scene partners", "Rehearsal"];

function PracticeFlow({ file }: { file: File | null }) {
  const startRehearsal = useStartRehearsal();
  // Step 1's Replace script: a new upload, in place of this one.
  const replaceScript = (next: File) => void startRehearsal(next, { replace: true });
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  // Read once: each wizard step below gets its own history entry, and the
  // router hands back a fresh copy of this state on every Back — reading it
  // live would make the file and replayScript look new and re-run setup.
  const [entryState] = useState(() => location.state);
  // Issued once by Home.tsx's start-rehearsal call; reused read-only by every
  // parse call below (including retries and the bilingual re-parse) — never
  // re-requested here. See api/_entitlement.ts and the auth-subscriptions plan.
  const rehearsalGrant: string | null = entryState?.rehearsalGrant ?? null;
  const replayScript: ReplayScript | null =
    entryState?.replayScript ?? null;
  // Home.tsx already hashed this upload for its saved-script lookup.
  const uploadContentHash: string | null = entryState?.contentHash ?? null;
  // Set by MyAccount's "Practice as X" button to jump straight to Rehearsal
  // with a previously-confirmed cast, skipping RolePicker/VoiceCasting.
  // Undefined (not just falsy — "" is a valid role, "listen to the full
  // scene") means "no preset", i.e. the ordinary/Recast flow through both
  // screens.
  const presetRoleRaw: unknown = entryState?.selectedRole;
  const hasPresetRole = typeof presetRoleRaw === "string";
  const presetRole = hasPresetRole ? (presetRoleRaw as string) : "";

  const [loading, setLoading] = useState(false);
  const [processingPhase, setProcessingPhase] = useState<
    "extracting" | "analyzing"
  >("extracting");
  const [error, setError] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [characters, setCharacters] = useState<string[]>([]);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<string | null>(null);
  const [characterVoices, setCharacterVoices] = useState<
    Record<string, string>
  >({});
  const [characterVolumes, setCharacterVolumes] = useState<
    Record<string, number>
  >({});
  // Saved scripts row backing this session, when the user is signed in —
  // casting and delivery tags are written back to it as they settle.
  const [scriptId, setScriptId] = useState<string | null>(null);
  // Per-line direction from the AI director (api/casting?action=direct-lines), aligned
  // by index with steps: performance markup on new parses, single-word tags on
  // rows saved before the markup upgrade. null until the pass finishes (or fails silently).
  const [deliveryTags, setDeliveryTags] = useState<(string | null)[] | null>(
    null,
  );
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesConfirmed, setVoicesConfirmed] = useState(false);
  // "Start rehearsal" was clicked on VoiceCasting: the scene partner's lines
  // are being pre-generated there, and Rehearsal opens once enough are ready.
  const [preparing, setPreparing] = useState(false);
  // Rehearsal was reached through that preparation, so its Start needn't
  // wait on pre-generation. False for paths that skip casting (monologues,
  // "Practice as X"), where Rehearsal's start overlay gates Start instead.
  const [preparedOnCasting, setPreparedOnCasting] = useState(false);
  // Characters the user has confirmed a full cast for and rehearsed as, this
  // script's saved row plus anything newly confirmed this session.
  const [rolesRead, setRolesRead] = useState<string[]>([]);
  const [scriptLanguage, setScriptLanguage] = useState({
    code: "en",
    name: "English",
  });
  const [parseAttempt, setParseAttempt] = useState(0);
  // Bilingual editions: holds the translated parse until the user picks a language.
  const [languageChoice, setLanguageChoice] = useState<ParseData | null>(null);
  // Finished parse waiting on the user's "Continue" click — the parsing screen
  // (with the PDF preview) stays up until they choose to proceed.
  const [pendingParse, setPendingParse] = useState<ParseData | null>(null);
  const toast = useToast();
  const ranAttempt = useRef(-1);
  // Grant taken here for an original-language read on a re-upload that was
  // served from its saved parse (Home.tsx takes none on a hash hit).
  const lateGrantRef = useRef<string | null>(null);

  const applyParseResult = (data: ParseData) => {
    const parsedSteps: Step[] = data.steps ?? [];
    const parsedCharacters: string[] = data.characters ?? [];
    setSteps(parsedSteps);
    setCharacters(parsedCharacters);
    setScriptLanguage({
      code: data.languageCode ?? "en",
      name: data.languageName ?? "English",
    });
    if (parsedCharacters.length === 0) setSelectedRole("");
  };

  // Hashed once per upload, so re-uploading the same PDF later (Home.tsx's
  // handleFile) finds the saved row instead of paying for another parse.
  const contentHashRef = useRef<Promise<string | null> | null>(null);
  const getContentHash = () =>
    (contentHashRef.current ??= uploadContentHash
      ? Promise.resolve(uploadContentHash)
      : file
        ? hashFile(file).catch(() => null)
        : Promise.resolve(null));

  // Saves the parse to the account the moment it arrives — before Continue
  // or the language pick — so a reload or back-out can't lose it. The first
  // write creates the row; Continue, the language pick and an original-
  // language re-parse all update that same row (a replay's row from the
  // start). Unconfirmed parses show on My Account like any other script.
  const parseCacheRef = useRef<
    ((fields: CachedParseFields) => Promise<void>) | null
  >(null);
  const cacheParse = (data: ParseData, needsLanguageChoice: boolean) => {
    if (!user) return;
    const userId = user.id;
    parseCacheRef.current ??= createParseCache({
      existingId: replayScript?.id,
      newId: () => crypto.randomUUID(),
      create: async (id, fields) =>
        saveScript(userId, {
          id,
          // The PDF's own name, extension and all, until the actor renames it.
          title: file?.name ?? "Untitled script",
          ...fields,
          contentHash: await getContentHash(),
        }),
      update: (id, fields) => updateScript(id, fields),
      onCreated: setScriptId,
      onError: (err) => console.error("Failed to save script to account:", err),
    });
    void parseCacheRef.current({
      steps: data.steps ?? [],
      characters: data.characters ?? [],
      languageCode: data.languageCode ?? "en",
      languageName: data.languageName ?? "English",
      needsLanguageChoice,
    });
  };

  const finalizeParse = (data: ParseData) => {
    applyParseResult(data);
    cacheParse(data, false);
  };

  const voiceableSpeakers = characters.filter((s) => s !== selectedRole);

  // Replay path: launch straight from a previously saved parse, no AI call.
  // Saved casting and delivery tags seed state so the auto-cast and director
  // effects below can skip their model calls.
  useEffect(() => {
    if (!replayScript) return;
    if (replayScript.id) setScriptId(replayScript.id);
    // Saved before its language was picked: ask again rather than rehearse
    // the translation the user never chose.
    if (replayScript.needsLanguageChoice) {
      setLanguageChoice({
        steps: replayScript.steps,
        characters: replayScript.characters,
        languageCode: replayScript.languageCode,
        languageName: replayScript.languageName,
        unreadableOriginalLanguage: true,
      });
      return;
    }
    applyParseResult({
      steps: replayScript.steps,
      characters: replayScript.characters,
      languageCode: replayScript.languageCode,
      languageName: replayScript.languageName,
    });
    if (replayScript.characterVoices && Object.keys(replayScript.characterVoices).length) {
      setCharacterVoices(replayScript.characterVoices);
    }
    if (replayScript.characterVolumes) {
      setCharacterVolumes(replayScript.characterVolumes);
    }
    // Tags from an older director prompt are dropped rather than seeded, so
    // the director effect below re-runs with the current prompt (and the
    // persist effect overwrites the row). The scene reads unadorned until
    // the new tags land, exactly as on a fresh parse.
    if (replayScript.deliveryTags && replayScript.directorVersion === DIRECTOR_VERSION) {
      setDeliveryTags(replayScript.deliveryTags);
    }
    if (replayScript.rolesRead) setRolesRead(replayScript.rolesRead);
    // A role read before already has a complete cast saved on this row (see
    // startReading below) — skip straight to Rehearsal instead of re-running
    // RolePicker/VoiceCasting.
    if (hasPresetRole) {
      setRoleDraft(presetRole || null);
      setSelectedRole(presetRole);
      setVoicesConfirmed(true);
    }
  }, [replayScript, hasPresetRole, presetRole]);

  useEffect(() => {
    if (replayScript) return;
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
    // it within the same tick, and the didRun guard then blocks any retry — the
    // request silently dies before it can ever complete.
    const run = async () => {
      setLoading(true);
      setError("");
      setPendingParse(null);
      setProcessingPhase("extracting");

      try {
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
        setProcessingPhase("analyzing");

        let data: ParseData;
        if (extractedLines !== null) {
          const res = await apiFetch("/api/parse-script", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-rehearsal-grant": rehearsalGrant,
            },
            body: JSON.stringify({ layout: { lines: extractedLines } }),
          });

          if (res.status === 401 || res.status === 403) {
            const body = await res
              .json()
              .catch(() => ({}) as { error?: string });
            throw new ApiError(
              res.status,
              body.error ?? "Session or rehearsal grant is no longer valid",
            );
          }

          const responseText = await res.text();
          let payload: { error?: string } & typeof data = {};
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
          data = payload;
        } else {
          // Image-only PDF (scan) — render pages and parse chunks with vision.
          data = await parseScannedPdf(
            file,
            rehearsalGrant,
            undefined,
            pdfDocument,
          );
        }

        if (data.unreadableOriginalLanguage && (data.steps?.length ?? 0) > 0) {
          // Bilingual edition — let the user pick a language before rehearsing.
          cacheParse(data, true);
          setLanguageChoice(data);
        } else {
          // Hold on the parsing screen (PDF preview visible) until the user
          // clicks Continue — never auto-advance into casting.
          cacheParse(data, false);
          setPendingParse(data);
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          navigate("/login", { replace: true });
          return;
        }
        if (err instanceof ApiError && err.status === 403) {
          toast(
            "Your rehearsal session expired — please re-upload your script.",
          );
          navigate("/", { replace: true });
          return;
        }
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setLoading(false);
      }
    };

    run();
  }, [parseAttempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-cast: fetch a fitting voice for each character when steps first load
  useEffect(() => {
    if (!steps.length) return;
    let cancelled = false;
    const uniqueSpeakers = [
      ...new Set(steps.map((s) => normalizeSpeaker(s.speaker)).filter(Boolean)),
    ];
    // Replays with a complete saved casting keep their scene partners —
    // don't re-run auto-casting and risk recasting voices.
    const savedVoices = replayScript?.characterVoices;
    if (savedVoices && uniqueSpeakers.every((name) => savedVoices[name])) {
      return;
    }
    const characterList = uniqueSpeakers.map((name) => ({
      name,
      sampleLines: steps
        .filter((s) => normalizeSpeaker(s.speaker) === name)
        .slice(0, 3)
        .map((s) => s.verbalLine)
        .filter(Boolean),
    }));
    if (!characterList.length) return;

    void (async () => {
      try {
        const response = await apiFetch("/api/casting?action=voices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            characters: characterList,
            languageCode: scriptLanguage.code,
          }),
        });
        const data = (await response.json()) as {
          voices?: Record<string, string>;
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || "Voice matching failed");
        // Merge under any manual picks the user already made while this was in flight.
        if (!cancelled && data.voices) {
          setCharacterVoices((previous) => ({ ...data.voices, ...previous }));
        }
      } catch (err) {
        console.error("Character voice matching error:", err);
        if (!cancelled)
          toast("Automatic voice casting didn't work — pick voices manually.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [steps, scriptLanguage.code, replayScript, toast]);

  // AI director pass: annotate each line with performance markup (inline v3
  // audio tags + pacing punctuation — how the scene partner should read it)
  // once steps load. Purely an enhancement — failures are silent and the
  // rehearsal reads lines unadorned.
  useEffect(() => {
    if (!steps.length || deliveryTags) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch("/api/casting?action=direct-lines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lines: steps.map((step) => ({
              speaker: normalizeSpeaker(step.speaker),
              text: step.verbalLine,
              direction: leadingDirections(step.content) || undefined,
            })),
          }),
        });
        const data = (await response.json()) as {
          tags?: (string | null)[];
          error?: string;
        };
        if (!response.ok) throw new Error(data.error || "Line direction failed");
        if (!cancelled && Array.isArray(data.tags)) setDeliveryTags(data.tags);
      } catch (err) {
        console.error("Line direction error:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [steps, deliveryTags]);

  // Write freshly generated delivery tags back to the saved row so replays
  // skip the director call. Guarded so it fires once per session. Stamped
  // with DIRECTOR_VERSION so a later prompt change knows to re-direct them.
  const persistedTagsRef = useRef(false);
  useEffect(() => {
    if (!user || !scriptId || !deliveryTags || persistedTagsRef.current) return;
    persistedTagsRef.current = true;
    if (replayScript?.deliveryTags && replayScript.directorVersion === DIRECTOR_VERSION) {
      return; // current tags already stored on the row
    }
    void updateScript(scriptId, { deliveryTags, directorVersion: DIRECTOR_VERSION }).catch((err) =>
      console.error("Failed to save delivery tags:", err),
    );
  }, [user, scriptId, deliveryTags, replayScript]);

  // Full voice catalog, so the user can override auto-assigned voices
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch("/api/eleven-account");
        if (response.status === 401) {
          if (!cancelled) navigate("/login", { replace: true });
          return;
        }
        const data = (await response.json()) as {
          voices?: Voice[];
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || "Voice list fetch failed");
        if (!cancelled && Array.isArray(data.voices)) setVoices(data.voices);
      } catch (err) {
        console.error("Voice list fetch error:", err);
        if (!cancelled)
          toast(
            "The voice catalog couldn't be loaded. Voice options may be limited.",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast, navigate]);

  const withDefaultVoices = () => {
    const next = { ...characterVoices };
    voiceableSpeakers.forEach((speaker) => {
      if (!next[speaker] && voices[0]) next[speaker] = voices[0].id;
    });
    return next;
  };

  // VoiceCasting's "Start rehearsal": fill any uncast speaker so the voices
  // pre-generated are exactly the ones Rehearsal will play, then prepare.
  const beginPreparing = () => {
    setCharacterVoices(withDefaultVoices());
    setPreparing(true);
  };

  const startReading = () => {
    const next = withDefaultVoices();
    setPreparing(false);
    setPreparedOnCasting(true);
    setCharacterVoices(next);
    setVoicesConfirmed(true);
    const nextRolesRead =
      selectedRole && !rolesRead.includes(selectedRole)
        ? [...rolesRead, selectedRole]
        : rolesRead;
    if (nextRolesRead !== rolesRead) setRolesRead(nextRolesRead);
    // Persist the confirmed casting so replaying this script keeps the same
    // scene partner instead of re-running auto-casting, and so My Account can
    // offer "Practice as X" for this role without going through casting again.
    if (user && scriptId) {
      void updateScript(scriptId, {
        characterVoices: next,
        characterVolumes,
        rolesRead: nextRolesRead,
      }).catch((err) => console.error("Failed to save voice casting:", err));
    }
  };

  // Monologues (no other characters to voice) never reach startReading —
  // VoiceCasting is skipped entirely — so record the role here instead.
  const recordRoleReadWithNoCasting = (role: string) => {
    if (!role || rolesRead.includes(role)) return;
    const next = [...rolesRead, role];
    setRolesRead(next);
    if (user && scriptId) {
      void updateScript(scriptId, { rolesRead: next }).catch((err) =>
        console.error("Failed to save role history:", err),
      );
    }
  };

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
      let grant = rehearsalGrant ?? lateGrantRef.current;
      if (!grant) {
        const res = await apiFetch("/api/start-rehearsal", { method: "POST" });
        if (res.status === 402) {
          toast("You're out of free sessions — subscribe to keep rehearsing.");
          navigate("/pricing");
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { grant?: string };
        if (!res.ok || !body.grant) {
          throw new Error("Couldn't start a new rehearsal. Please try again.");
        }
        grant = lateGrantRef.current = body.grant;
      }
      const result = await parseScannedPdf(
        file,
        grant,
        undefined,
        undefined,
        {
          preferOriginalLanguage: true,
        },
      );
      cacheParse(result, false);
      // Same continue-gate as the initial parse — this path takes minutes, so
      // the user may have stepped away; don't jump into casting unprompted.
      setPendingParse(result);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate("/login", { replace: true });
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        toast("Your rehearsal session expired — please re-upload your script.");
        navigate("/", { replace: true });
        return;
      }
      // Back to the choice with the translation still in hand — the error
      // screen's "Try again" would re-run the whole first parse instead.
      toast(err instanceof Error ? err.message : "An error occurred");
      setLanguageChoice(translation);
    } finally {
      setLoading(false);
    }
  };

  // Pre-generate the scene partner's lines from the moment "Start rehearsal"
  // is clicked on VoiceCasting (never while just browsing voices — every line
  // costs credits), and keep going through Rehearsal so the take itself makes
  // no ElevenLabs round trips. The voice controls are hidden while preparing,
  // so the cast can't change mid-run; backing out stops it, and the next click
  // restarts with only the changed lines.
  const rehearsalShowing =
    !loading &&
    !pendingParse &&
    !error &&
    !languageChoice &&
    steps.length > 0 &&
    selectedRole !== null &&
    (voicesConfirmed || voiceableSpeakers.length === 0);
  const pregen = useReaderAudioPregen({
    enabled: preparing || rehearsalShowing,
    steps,
    selectedRole: selectedRole ?? "",
    characterVoices,
    deliveryTags,
    // Pinned, as in Rehearsal — part of the cache key.
    intensity: "natural",
    scriptId,
  });

  // Opening lines ready: move on to Rehearsal by themselves. The hook stays
  // enabled across the switch with the same lines, so generation carries on.
  const startReadingRef = useRef(startReading);
  startReadingRef.current = startReading;
  useEffect(() => {
    if (preparing && pregen.canStart) startReadingRef.current();
  }, [preparing, pregen.canStart]);

  // Step 1 (upload) revisited: the parse is already applied, so this only
  // shows the finished upload screen again until Continue (or Forward).
  // A script parsed before (re-uploaded, or reopened from My Auditions)
  // opens here too, already complete — every rehearsal starts at step 1.
  const [reviewingUpload, setReviewingUpload] = useState(
    () => !!replayScript && !hasPresetRole && !replayScript.needsLanguageChoice,
  );
  // The role last picked, so Forward can re-pick it ("" — listen to the
  // whole scene — is a real choice, unlike roleDraft's null).
  const chosenRoleRef = useRef<string | null>(null);
  // "Practice as" jumps straight into Rehearsal, so it alone has no step 1
  // to go back to.
  const hasUploadStep = !hasPresetRole;

  const chooseRole = (role: string) => {
    chosenRoleRef.current = role;
    setRoleDraft(role || null);
    setSelectedRole(role);
    setVoicesConfirmed(false);
    setPreparedOnCasting(false);
    if (role && characters.filter((s) => s !== role).length === 0) {
      recordRoleReadWithNoCasting(role);
    }
  };

  // Wizard step on screen, mirroring the render order below: 0 upload
  // (parsing, its finished preview, or anything before a role can be
  // picked), 1 RolePicker, 2 VoiceCasting, 3 Rehearsal.
  const wizardStep =
    loading || pendingParse || reviewingUpload || error || languageChoice || steps.length === 0
      ? 0
      : selectedRole === null
        ? characters.length > 0 ? 1 : 0
        : !voicesConfirmed && voiceableSpeakers.length > 0
          ? 2
          : 3;

  // The tab title names the step, like a page of its own would.
  useSeo({
    title: STEP_TITLES[wizardStep],
    description: "Rehearse your script with every other character read aloud.",
    path: "/practice",
    noindex: true,
  });

  // Each step has its own URL and history entry, so Back and Forward (and a
  // phone's back swipe) move through the wizard like pages. One effect keeps
  // the two in step, whichever moved: the app advancing (push a new entry),
  // or history moving (show that step — back directly, forward by re-making
  // the choice that led there). A reload restarts at the upload.
  const historyStep = stepFromPath(location.pathname);
  const locationStateRef = useRef(location.state);
  locationStateRef.current = location.state;
  const prevHistoryStepRef = useRef(historyStep);
  // Set just before the app navigates, so that move isn't taken for the
  // user's own Back/Forward.
  const selfNavRef = useRef(false);
  // The step history asked for, while the screen catches up to it.
  const targetStepRef = useRef<number | null>(null);
  const movedOnceRef = useRef(false);
  // A take in progress, reported by Rehearsal. Leaving through history
  // can't be cancelled (beforeunload doesn't fire for it), so it's
  // confirmed by hand below.
  const recordingActiveRef = useRef(false);
  // Set when the leave was already confirmed (Rehearsal's own Back button).
  const leaveConfirmedRef = useRef(false);

  // practiceIndex counts this flow's entries below the current one, so the
  // in-app Back only goes through history when there's a step to return to.
  const goToStepUrl = (step: number, replace: boolean) => {
    selfNavRef.current = true;
    const state = locationStateRef.current;
    const practiceIndex = (state?.practiceIndex ?? 0) + (replace ? 0 : 1);
    navigate(STEP_PATHS[step], { replace, state: { ...state, practiceIndex } });
  };

  const showEarlierStep = (target: number) => {
    setPreparing(false);
    if (target <= 1) {
      setSelectedRole(null);
      setVoicesConfirmed(false);
      if (target === 0) setReviewingUpload(true);
    } else {
      setVoicesConfirmed(false);
    }
  };

  /** Re-makes the choice that leads past the current step; false if
   * there's none to re-make (still parsing, no role picked yet). */
  const advanceStep = (): boolean => {
    if (wizardStep === 0) {
      if (reviewingUpload) {
        setReviewingUpload(false);
        return true;
      }
      if (pendingParse) {
        finalizeParse(pendingParse);
        setPendingParse(null);
        return true;
      }
      return false;
    }
    if (wizardStep === 1) {
      if (chosenRoleRef.current === null) return false;
      chooseRole(chosenRoleRef.current);
      return true;
    }
    if (wizardStep === 2) {
      // Same as Start: prepare, and Rehearsal opens once lines are ready.
      if (!preparing) beginPreparing();
      return true;
    }
    return false;
  };

  useEffect(() => {
    const historyMoved = prevHistoryStepRef.current !== historyStep;
    prevHistoryStepRef.current = historyStep;
    if (historyMoved) {
      if (selfNavRef.current) selfNavRef.current = false;
      else targetStepRef.current = historyStep;
    }

    const target = targetStepRef.current;
    if (target !== null) {
      if (target === wizardStep) {
        targetStepRef.current = null;
        return;
      }
      if (target < wizardStep) {
        const confirmed = leaveConfirmedRef.current;
        leaveConfirmedRef.current = false;
        if (
          wizardStep === 3 &&
          recordingActiveRef.current &&
          !confirmed &&
          !window.confirm("You have unsaved changes. Are you sure you want to leave?")
        ) {
          // Stay on the take: put its entry back.
          targetStepRef.current = null;
          goToStepUrl(3, false);
          return;
        }
        if (target === 0 && !hasUploadStep) {
          // Nothing of this flow before the role: keep going back, out.
          targetStepRef.current = null;
          navigate(-1);
          return;
        }
        showEarlierStep(target);
        return;
      }
      // Forward: one step at a time; this effect runs again as each lands.
      if (!advanceStep()) {
        targetStepRef.current = null;
        goToStepUrl(wizardStep, true);
      }
      return;
    }

    // The app moved the wizard. Without an upload step, the first step
    // reached takes over /practice's entry rather than stacking on it.
    if (wizardStep === historyStep) return;
    const first = !movedOnceRef.current;
    movedOnceRef.current = true;
    if (wizardStep > historyStep) goToStepUrl(wizardStep, first && !hasUploadStep);
    else goToStepUrl(wizardStep, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to step moves only
  }, [wizardStep, historyStep]);

  /** In-app Back: through history when there's an earlier step entry (so
   * browser Back/Forward stay in step), else `fallback`. */
  const stepBack = (fallback: () => void) => {
    if ((location.state?.practiceIndex ?? 0) > 0) {
      leaveConfirmedRef.current = true;
      navigate(-1);
    } else fallback();
  };

  if (loading) return <ParsingScreen file={file!} phase={processingPhase} onReplace={replaceScript} />;
  if (pendingParse) {
    return (
      <ParsingScreen
        file={file!}
        phase="done"
        onReplace={replaceScript}
        onContinue={() => {
          finalizeParse(pendingParse);
          setPendingParse(null);
        }}
      />
    );
  }
  if (reviewingUpload) {
    return (
      <ParsingScreen
        file={file}
        title={replayScript?.title}
        phase="done"
        onReplace={replaceScript}
        onContinue={() => setReviewingUpload(false)}
      />
    );
  }

  if (error) {
    return (
      <StageShell>
        <div className="flex h-full flex-col items-center justify-center text-center">
          <p className="eyebrow mb-4">Something went wrong</p>
          <h1 className="stage-error-title">We couldn’t read that script.</h1>
          <p className="stage-error-detail">{error}</p>
          <div className="stage-error-actions">
            <button
              type="button"
              className="stage-error-retry"
              onClick={() => setParseAttempt((attempt) => attempt + 1)}
            >
              Try again
            </button>
            <button
              type="button"
              className="stage-error-secondary"
              onClick={() => navigate("/")}
            >
              Upload a different script
            </button>
          </div>
        </div>
      </StageShell>
    );
  }

  if (languageChoice) {
    return (
      <StageShell>
        <div className="flex h-full flex-col items-center justify-center text-center">
          <p className="eyebrow mb-4">Bilingual edition</p>
          <h1 className="stage-error-title">
            Which version do you want to rehearse?
          </h1>
          <p className="stage-error-detail">
            This script prints its dialogue in two languages, and only the
            translation is readable as text. Rehearse the translation now, or
            have the original language read from the printed pages — that takes
            a few minutes.
            {!file && " Re-upload the PDF to have the original language read."}
          </p>
          <div className="stage-error-actions">
            <button
              type="button"
              className="stage-error-retry"
              onClick={() => {
                finalizeParse(languageChoice);
                setLanguageChoice(null);
              }}
            >
              Rehearse in {languageChoice.languageName ?? "the translation"}
            </button>
            {file && (
              <button
                type="button"
                className="stage-error-secondary"
                onClick={rehearseOriginalLanguage}
              >
                Read the original language (takes a few minutes)
              </button>
            )}
          </div>
        </div>
      </StageShell>
    );
  }

  if (steps.length === 0) {
    return (
      <StageShell>
        <div className="flex h-full flex-col items-center justify-center text-center">
          <p className="text-ink-soft">
            No spoken lines detected in this script.
          </p>
        </div>
      </StageShell>
    );
  }

  if (selectedRole === null && characters.length > 0) {
    return (
      <RolePicker
        characters={characters}
        steps={steps}
        fileName={file?.name ?? replayScript?.title ?? "Uploaded script"}
        initialSelected={roleDraft}
        onChoose={chooseRole}
        onBack={() => stepBack(() => navigate(replayScript ? "/account" : "/"))}
      />
    );
  }

  if (
    selectedRole !== null &&
    !voicesConfirmed &&
    voiceableSpeakers.length > 0
  ) {
    return (
      <VoiceCasting
        speakers={voiceableSpeakers}
        steps={steps}
        voices={voices}
        characterVoices={characterVoices}
        onPick={(speaker, voiceId) =>
          setCharacterVoices((prev) => ({ ...prev, [speaker]: voiceId }))
        }
        characterVolumes={characterVolumes}
        onVolumeChange={(speaker, volume) =>
          setCharacterVolumes((prev) => ({ ...prev, [speaker]: volume }))
        }
        preparing={preparing}
        pregen={pregen}
        onStart={beginPreparing}
        onStartAnyway={startReading}
        languageCode={scriptLanguage.code}
        languageName={scriptLanguage.name}
        onBack={() =>
          stepBack(() => {
            setPreparing(false);
            setSelectedRole(null);
            setVoicesConfirmed(false);
          })
        }
      />
    );
  }

  return (
    <Rehearsal
      steps={steps}
      selectedRole={selectedRole ?? ""}
      characterVoices={characterVoices}
      characterVolumes={characterVolumes}
      deliveryTags={deliveryTags ?? []}
      onBack={() =>
        stepBack(() => {
          if (voiceableSpeakers.length > 0) {
            setVoicesConfirmed(false);
          } else {
            setSelectedRole(null);
          }
        })
      }
      languageCode={scriptLanguage.code}
      fileName={file?.name ?? replayScript?.title ?? "Rehearsal"}
      scriptId={scriptId}
      pregen={pregen}
      awaitPregen={!preparedOnCasting}
      onRecordingActiveChange={(active) => {
        recordingActiveRef.current = active;
      }}
    />
  );
}
