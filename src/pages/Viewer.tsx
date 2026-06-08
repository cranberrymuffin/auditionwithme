import { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Step } from "../types";

function normalizeSpeaker(name: string): string {
  return name
    .replace(/\s*\(cont['']?d\.?\)/gi, "")
    .replace(/\s*\(v\.?o\.?\)/gi, "")
    .replace(/\s*\(o\.?s\.?\)/gi, "")
    .replace(/\s*\(o\.?c\.?\)/gi, "")
    .replace(/\s*\(pre-lap\)/gi, "")
    .trim();
}

function countMatchedWords(scriptWords: string[], transcript: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const spoken = transcript.toLowerCase().split(/\s+/).map(norm).filter(Boolean);
  const script = scriptWords.map(norm).filter(Boolean);
  let si = 0;
  for (let pi = 0; pi < spoken.length && si < script.length; pi++) {
    if (script[si] === spoken[pi]) si++;
  }
  return si;
}

function renderTrackedWords(text: string, matchedCount: number) {
  const chunks = text.split(/(\s+)/);
  let wordIdx = 0;
  return chunks.map((chunk, i) => {
    if (/^\s+$/.test(chunk)) return chunk;
    const idx = wordIdx++;
    let cls = "word--unsaid";
    if (idx < matchedCount) cls = "word--said";
    else if (idx === matchedCount) cls = "word--current";
    return <span key={i} className={cls}>{chunk}</span>;
  });
}

export default function Viewer() {
  const location = useLocation();
  const navigate = useNavigate();
  const file: File | null = location.state?.file ?? null;

  const [loading, setLoading] = useState(false);
  const [stepsLoading, setStepsLoading] = useState(false);
  const [error, setError] = useState("");
  const [stepsError, setStepsError] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [characters, setCharacters] = useState<string[]>([]);
  const [characterVoices, setCharacterVoices] = useState<Record<string, string>>({});
  const [matchedWordCount, setMatchedWordCount] = useState(0);
  const stepsAbortRef = useRef<AbortController | null>(null);
  const didRun = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  // Derived values used in effect deps — must be computed before effects
  const currentStep = steps[currentStepIndex];
  const isMyLine = !!selectedRole && normalizeSpeaker(currentStep?.speaker ?? "") === selectedRole;

  useEffect(() => {
    if (!file) {
      navigate("/", { replace: true });
      return;
    }
    if (didRun.current) return;
    didRun.current = true;

    const run = async () => {
      setLoading(true);
      let scriptText = "";

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

        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pdfData: base64 }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Analysis failed");
        scriptText = data.script;
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
        setLoading(false);
        return;
      }

      setLoading(false);

      const controller = new AbortController();
      stepsAbortRef.current = controller;
      setStepsLoading(true);

      try {
        const stepsRes = await fetch("/api/parse-steps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scriptText }),
          signal: controller.signal,
        });
        if (!stepsRes.ok) throw new Error("Failed to parse steps");
        const parsed = await stepsRes.json();
        const parsedSteps: Step[] = parsed.steps ?? [];
        const parsedCharacters: string[] = parsed.characters ?? [];
        setSteps(parsedSteps);
        setCharacters(parsedCharacters);
        if (parsedCharacters.length === 0) setSelectedRole("");
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        console.error("parse-steps error:", e);
        setStepsError("Step-through view unavailable.");
      } finally {
        setStepsLoading(false);
      }
    };

    run();

    return () => stepsAbortRef.current?.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset word tracking when step changes
  useEffect(() => {
    setMatchedWordCount(0);
  }, [currentStepIndex]);

  // Fetch a voice for each character when steps first load
  useEffect(() => {
    if (!steps.length) return;
    const uniqueSpeakers = [...new Set(steps.map(s => normalizeSpeaker(s.speaker)).filter(Boolean))];
    const characterList = uniqueSpeakers.map(name => ({
      name,
      sampleLines: steps
        .filter(s => normalizeSpeaker(s.speaker) === name)
        .slice(0, 3)
        .map(s => s.verbalLine)
        .filter(Boolean),
    }));
    fetch("/api/character-voices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ characters: characterList }),
    })
      .then(res => res.json())
      .then(data => { if (data.voices) setCharacterVoices(data.voices); })
      .catch(err => console.error("Character voice matching error:", err));
  }, [steps]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  };

  // TTS: auto-play other characters' lines
  useEffect(() => {
    if (!steps.length || selectedRole === null) return;
    const step = steps[currentStepIndex];
    if (!step?.verbalLine?.trim()) return;
    if (selectedRole && step.speaker === selectedRole) return;

    stopAudio();
    const controller = new AbortController();

    fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: step.verbalLine,
        voiceId: characterVoices[normalizeSpeaker(step.speaker)],
      }),
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error("TTS failed");
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.play().catch(() => {});
      })
      .catch((err) => {
        if (err.name !== "AbortError") console.error("TTS error:", err);
      });

    return () => {
      controller.abort();
      stopAudio();
    };
  }, [currentStepIndex, steps, selectedRole, characterVoices]); // eslint-disable-line react-hooks/exhaustive-deps

  // Word tracking: browser SpeechRecognition with monotonic count (never regresses)
  useEffect(() => {
    if (!isMyLine) return;

    setMatchedWordCount(0);

    const SpeechRecognitionImpl =
      (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionImpl) return;

    const scriptWords = currentStep.verbalLine.split(/\s+/).filter(Boolean);
    const state = { finalText: "", aborted: false };

    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          state.finalText += t + " ";
        } else {
          interim = t;
        }
      }
      const count = countMatchedWords(scriptWords, state.finalText + interim);
      // Only advance — never let a browser restart walk the count backwards
      setMatchedWordCount(prev => Math.max(prev, count));
    };

    // Chrome stops recognition after silence even with continuous:true — restart it
    recognition.onend = () => {
      if (!state.aborted) recognition.start();
    };

    recognition.onerror = (event: any) => {
      if (event.error !== "aborted" && event.error !== "no-speech") {
        console.error("SpeechRecognition error:", event.error);
      }
    };

    recognition.start();

    return () => {
      state.aborted = true;
      recognition.stop();
    };
  }, [currentStepIndex, isMyLine]); // eslint-disable-line react-hooks/exhaustive-deps

  const goNext = () => {
    stopAudio();
    setCurrentStepIndex((i) => Math.min(i + 1, steps.length - 1));
  };

  const goPrev = () => {
    stopAudio();
    setCurrentStepIndex((i) => Math.max(i - 1, 0));
  };

  const isLoading = loading || stepsLoading;
  const loadingText = loading
    ? "Claude is reading your script…"
    : "Preparing step-through view…";

  const speakers = characters;
  const showRolePicker = !isLoading && !error && steps.length > 0 && selectedRole === null && speakers.length > 0;

  const hills = (
    <div className="home-hills">
      <svg
        className="home-hill home-hill--back"
        viewBox="0 0 1440 300"
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M0,180 C200,80 480,240 720,140 C960,40 1200,160 1440,120 L1440,300 L0,300 Z"
          fill="rgba(232,117,106,0.55)"
        />
      </svg>
      <svg
        className="home-hill home-hill--front"
        viewBox="0 0 1440 300"
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M0,240 C240,180 480,280 720,220 C960,160 1200,260 1440,220 L1440,300 L0,300 Z"
          fill="#E8756A"
        />
      </svg>
    </div>
  );

  return (
    <>
      {isLoading && (
        <div className="home-hero viewer-loading">
          <div className="home-crescent" />
          <div className="home-text">
            <h1 className="home-title">
              {loading ? <>READING<br />YOUR SCRIPT</> : <>ALMOST<br />READY</>}
            </h1>
            <p className="home-subtitle">{loadingText}</p>
          </div>
          {hills}
        </div>
      )}

      {showRolePicker && (
        <div className="role-picker">
          <div className="home-crescent" />
          <div className="role-picker__content">
            <h2 className="role-picker__title">
              WHO ARE<br />YOU<br />READING<br />FOR?
            </h2>
            <p className="role-picker__subtitle">Select your character to get started</p>
            <div className="role-picker__grid">
              {speakers.map(speaker => (
                <button
                  key={speaker}
                  className="role-picker__btn"
                  onClick={() => setSelectedRole(speaker)}
                >
                  {speaker}
                </button>
              ))}
            </div>
            <button
              className="role-picker__skip"
              onClick={() => setSelectedRole("")}
            >
              Just watch
            </button>
          </div>
          {hills}
        </div>
      )}

      <div className="viewer-page">
        <header className="viewer-header">
          <button className="viewer-header__brand" onClick={() => navigate("/")}>
            AuditionWithMe
          </button>
          {selectedRole !== null && speakers.length > 0 && (
            <button
              className="viewer-header__role-btn"
              onClick={() => setSelectedRole(null)}
            >
              {selectedRole || "Watching"}
            </button>
          )}
        </header>

        <div className="viewer-body">
          {error && <p className="viewer-error">{error}</p>}
          {stepsError && <p className="viewer-error">{stepsError}</p>}

          {!isLoading && !error && steps.length === 0 && !stepsError && (
            <p className="viewer-empty">No spoken lines detected in this script.</p>
          )}

          {currentStep && selectedRole !== null && (
            <div className={`viewer-step${isMyLine ? " viewer-step--yours" : ""}`}>
              <div className="viewer-step__header">
                <p className="viewer-step__speaker">{currentStep.speaker || "—"}</p>
                {isMyLine && <span className="viewer-step__your-badge">YOU</span>}
                {isMyLine && (
                  <span className="viewer-step__mic-dot" aria-label="Listening" />
                )}
              </div>
              <div className="viewer-step__content">
                {currentStep.content.map((line, i) =>
                  line.kind === "verbal" ? (
                    <p key={i} className="viewer-step__verbal">
                      {isMyLine
                        ? renderTrackedWords(line.text, matchedWordCount)
                        : line.text}
                    </p>
                  ) : (
                    <p key={i} className="viewer-step__nonverbal">{line.text}</p>
                  )
                )}
              </div>
              <div className="viewer-step__footer">
                <button
                  className="viewer-btn"
                  onClick={goPrev}
                  disabled={currentStepIndex === 0}
                >
                  ← Prev
                </button>
                <p className="viewer-step__counter">
                  Step {currentStepIndex + 1} of {steps.length}
                </p>
                <button
                  className="viewer-btn"
                  onClick={goNext}
                  disabled={currentStepIndex >= steps.length - 1}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>

        {hills}
      </div>
    </>
  );
}
