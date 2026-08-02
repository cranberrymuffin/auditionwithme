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

export default function Practice() {
  const location = useLocation();
  const navigate = useNavigate();
  const file: File | null = location.state?.file ?? null;

  const [loading, setLoading] = useState(false);
  const [processingPhase, setProcessingPhase] = useState<"extracting" | "analyzing">("extracting");
  const [error, setError] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [characters, setCharacters] = useState<string[]>([]);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<string | null>(null);
  const [characterVoices, setCharacterVoices] = useState<Record<string, string>>({});
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesConfirmed, setVoicesConfirmed] = useState(false);
  const [scriptLanguage, setScriptLanguage] = useState({ code: "en", name: "English" });
  const [parseAttempt, setParseAttempt] = useState(0);
  // Bilingual editions: holds the translated parse until the user picks a language.
  const [languageChoice, setLanguageChoice] = useState<ParseData | null>(null);
  const toast = useToast();
  const ranAttempt = useRef(-1);

  const applyParseResult = (data: ParseData) => {
    const parsedSteps: Step[] = data.steps ?? [];
    const parsedCharacters: string[] = data.characters ?? [];
    setSteps(parsedSteps);
    setCharacters(parsedCharacters);
    setScriptLanguage({ code: data.languageCode ?? "en", name: data.languageName ?? "English" });
    if (parsedCharacters.length === 0) setSelectedRole("");
  };

  const voiceableSpeakers = characters.filter((s) => s !== selectedRole);

  useEffect(() => {
    if (!file) {
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
      setProcessingPhase("extracting");

      try {
        const pdfDocument = await loadPdf(file);
        let extractedLines: LayoutLineTuple[] | null = null;
        try {
          const extracted = await extractPdfLayout(file, pdfDocument);
          if (extracted.usable) extractedLines = extracted.lines;
        } catch (extractionError) {
          console.warn("PDF text extraction failed; using scanned-page parsing.", extractionError);
        }
        setProcessingPhase("analyzing");

        let data: ParseData;
        if (extractedLines !== null) {
          const res = await fetch("/api/parse-script", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ layout: { lines: extractedLines } }),
          });

          const responseText = await res.text();
          let payload: { error?: string } & typeof data = {};
          if (responseText) {
            try {
              payload = JSON.parse(responseText) as typeof payload;
            } catch {
              throw new Error(
                res.ok ? "The script service returned an invalid response." : SERVICE_DOWN_MESSAGE
              );
            }
          }
          if (!res.ok) {
            throw new Error(payload.error || SERVICE_DOWN_MESSAGE);
          }
          if (!responseText) throw new Error("The script service returned an empty response.");
          data = payload;
        } else {
          // Image-only PDF (scan) — render pages and parse chunks with vision.
          data = await parseScannedPdf(file, undefined, pdfDocument);
        }

        if (data.unreadableOriginalLanguage && (data.steps?.length ?? 0) > 0) {
          // Bilingual edition — let the user pick a language before rehearsing.
          setLanguageChoice(data);
        } else {
          applyParseResult(data);
        }
      } catch (err) {
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
        const response = await fetch("/api/character-voices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ characters: characterList, languageCode: scriptLanguage.code }),
        });
        const data = await response.json() as { voices?: Record<string, string>; error?: string };
        if (!response.ok) throw new Error(data.error || "Voice matching failed");
        // Merge under any manual picks the user already made while this was in flight.
        if (!cancelled && data.voices) {
          setCharacterVoices((previous) => ({ ...data.voices, ...previous }));
        }
      } catch (err) {
        console.error("Character voice matching error:", err);
        if (!cancelled) toast("Automatic voice casting didn't work — pick voices manually.");
      }
    })();

    return () => { cancelled = true; };
  }, [steps, scriptLanguage.code, toast]);

  // Full voice catalog, so the user can override auto-assigned voices
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/voices");
        const data = await response.json() as { voices?: Voice[]; error?: string };
        if (!response.ok) throw new Error(data.error || "Voice list fetch failed");
        if (!cancelled && Array.isArray(data.voices)) setVoices(data.voices);
      } catch (err) {
        console.error("Voice list fetch error:", err);
        if (!cancelled) toast("The voice catalog couldn't be loaded. Voice options may be limited.");
      }
    })();
    return () => { cancelled = true; };
  }, [toast]);

  const startReading = () => {
    setCharacterVoices((prev) => {
      const next = { ...prev };
      voiceableSpeakers.forEach((speaker) => {
        if (!next[speaker] && voices[0]) next[speaker] = voices[0].id;
      });
      return next;
    });
    setVoicesConfirmed(true);
  };

  const rehearseOriginalLanguage = async () => {
    if (!file) return;
    setLanguageChoice(null);
    setLoading(true);
    setProcessingPhase("analyzing");
    try {
      const result = await parseScannedPdf(file, undefined, undefined, {
        preferOriginalLanguage: true,
      });
      applyParseResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <ParsingScreen file={file!} phase={processingPhase} />;

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
          <h1 className="stage-error-title">Which version do you want to rehearse?</h1>
          <p className="stage-error-detail">
            This script prints its dialogue in two languages, and only the translation is
            readable as text. Rehearse the translation now, or have the original language
            read from the printed pages — that takes a few minutes.
          </p>
          <div className="stage-error-actions">
            <button
              type="button"
              className="stage-error-retry"
              onClick={() => {
                applyParseResult(languageChoice);
                setLanguageChoice(null);
              }}
            >
              Rehearse in {languageChoice.languageName ?? "the translation"}
            </button>
            <button type="button" className="stage-error-secondary" onClick={rehearseOriginalLanguage}>
              Read the original language (takes a few minutes)
            </button>
          </div>
        </div>
      </StageShell>
    );
  }

  if (steps.length === 0) {
    return (
      <StageShell>
        <div className="flex h-full flex-col items-center justify-center text-center">
          <p className="text-ink-soft">No spoken lines detected in this script.</p>
        </div>
      </StageShell>
    );
  }

  if (selectedRole === null && characters.length > 0) {
    return (
      <RolePicker
        characters={characters}
        steps={steps}
        fileName={file?.name ?? "Uploaded script"}
        initialSelected={roleDraft}
        onChoose={(role) => {
          setRoleDraft(role || null);
          setSelectedRole(role);
          setVoicesConfirmed(false);
        }}
      />
    );
  }

  if (selectedRole !== null && !voicesConfirmed && voiceableSpeakers.length > 0) {
    return (
      <VoiceCasting
        speakers={voiceableSpeakers}
        steps={steps}
        voices={voices}
        characterVoices={characterVoices}
        onPick={(speaker, voiceId) =>
          setCharacterVoices((prev) => ({ ...prev, [speaker]: voiceId }))
        }
        onStart={startReading}
        languageCode={scriptLanguage.code}
        languageName={scriptLanguage.name}
        onBack={() => {
          setSelectedRole(null);
          setVoicesConfirmed(false);
        }}
      />
    );
  }

  return (
    <Rehearsal
      steps={steps}
      selectedRole={selectedRole ?? ""}
      characterVoices={characterVoices}
      onBack={() => {
        if (voiceableSpeakers.length > 0) {
          setVoicesConfirmed(false);
        } else {
          setSelectedRole(null);
        }
      }}
      languageCode={scriptLanguage.code}
      fileName={file?.name ?? "Rehearsal"}
    />
  );
}
