import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Step } from "../types";
import { normalizeSpeaker, type Voice } from "../lib/script";
import ParsingScreen from "../components/practice/ParsingScreen";
import RolePicker from "../components/practice/RolePicker";
import VoiceCasting from "../components/practice/VoiceCasting";
import Rehearsal from "../components/practice/Rehearsal";
import StageShell from "../components/practice/StageShell";

export default function Practice() {
  const location = useLocation();
  const navigate = useNavigate();
  const file: File | null = location.state?.file ?? null;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [characters, setCharacters] = useState<string[]>([]);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<string | null>(null);
  const [characterVoices, setCharacterVoices] = useState<Record<string, string>>({});
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesConfirmed, setVoicesConfirmed] = useState(false);
  const [scriptLanguage, setScriptLanguage] = useState({ code: "en", name: "English" });
  const didRun = useRef(false);

  const voiceableSpeakers = characters.filter((s) => s !== selectedRole);

  useEffect(() => {
    if (!file) {
      navigate("/", { replace: true });
      return;
    }
    if (didRun.current) return;
    didRun.current = true;

    // No AbortController here on purpose: this fetch is a single, non-restartable
    // ~30-60s call. Wiring an abort signal in before the fetch starts means React
    // StrictMode's dev-mode double-invoke (mount -> cleanup -> mount again) aborts
    // it within the same tick, and the didRun guard then blocks any retry — the
    // request silently dies before it can ever complete.
    const run = async () => {
      setLoading(true);

      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            resolve(result.split(",")[1]);
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const res = await fetch("/api/parse-script", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pdfData: base64 }),
        });

        const responseText = await res.text();
        let data: { error?: string; steps?: Step[]; characters?: string[]; languageCode?: string; languageName?: string } = {};
        if (responseText) {
          try {
            data = JSON.parse(responseText) as typeof data;
          } catch {
            throw new Error(
              res.ok
                ? "The script service returned an invalid response."
                : "The local script service is unavailable. Start it with `vercel dev --listen 3000`."
            );
          }
        }
        if (!res.ok) {
          throw new Error(
            data.error ||
              "The local script service is unavailable. Start it with `vercel dev --listen 3000`."
          );
        }
        if (!responseText) throw new Error("The script service returned an empty response.");

        const parsedSteps: Step[] = data.steps ?? [];
        const parsedCharacters: string[] = data.characters ?? [];
        setSteps(parsedSteps);
        setCharacters(parsedCharacters);
        setScriptLanguage({ code: data.languageCode ?? "en", name: data.languageName ?? "English" });
        if (parsedCharacters.length === 0) setSelectedRole("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setLoading(false);
      }
    };

    run();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      }
    })();

    return () => { cancelled = true; };
  }, [steps, scriptLanguage.code]);

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
      }
    })();
    return () => { cancelled = true; };
  }, []);

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

  if (loading) return <ParsingScreen file={file!} />;

  if (error) {
    return (
      <StageShell>
        <div className="flex h-full flex-col items-center justify-center text-center">
          <p className="eyebrow mb-5">Something went wrong</p>
          <p className="max-w-md text-coral-700 dark:text-coral-300">{error}</p>
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
