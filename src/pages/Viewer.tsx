import { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import type { Step } from "../types";

type Voice = {
  id: string;
  name: string;
  gender: string;
  age: string;
  accent: string;
  description: string;
};

function describeVoice(v: Voice): string {
  return [v.gender, v.age, v.accent].filter(Boolean).join(" · ") + (v.description ? ` — ${v.description}` : "");
}

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
  const [error, setError] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [characters, setCharacters] = useState<string[]>([]);
  const [characterVoices, setCharacterVoices] = useState<Record<string, string>>({});
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesConfirmed, setVoicesConfirmed] = useState(false);
  const [matchedWordCount, setMatchedWordCount] = useState(0);
  const didRun = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  // Derived values used in effect deps — must be computed before effects
  const currentStep = steps[currentStepIndex];
  const speakers = characters;
  const voiceableSpeakers = speakers.filter(s => s !== selectedRole);
  // Block playback until every other character has a voice assigned
  const showVoiceGate =
    !loading && !error && steps.length > 0 && selectedRole !== null && !voicesConfirmed && voiceableSpeakers.length > 0;
  const isMyLine =
    !!selectedRole && !showVoiceGate && normalizeSpeaker(currentStep?.speaker ?? "") === selectedRole;

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
    // request silently dies before it can ever complete. The original two-call
    // version avoided this because its abort controller was only created after the
    // first call had already resolved, by which point StrictMode's synchronous
    // cleanup had already run and found nothing to abort.
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

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Script parsing failed");

        const parsedSteps: Step[] = data.steps ?? [];
        const parsedCharacters: string[] = data.characters ?? [];
        setSteps(parsedSteps);
        setCharacters(parsedCharacters);
        if (parsedCharacters.length === 0) setSelectedRole("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setLoading(false);
      }
    };

    run();
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
      .then(data => {
        // Merge under any manual picks the user already made while this was in flight
        if (data.voices) setCharacterVoices(prev => ({ ...data.voices, ...prev }));
      })
      .catch(err => console.error("Character voice matching error:", err));
  }, [steps]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the full voice catalog once, so the user can override auto-assigned voices
  useEffect(() => {
    fetch("/api/voices")
      .then(res => res.json())
      .then(data => { if (data.voices) setVoices(data.voices); })
      .catch(err => console.error("Voice list fetch error:", err));
  }, []);

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
    if (!steps.length || selectedRole === null || showVoiceGate) return;
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
  }, [currentStepIndex, steps, selectedRole, characterVoices, showVoiceGate]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const loadingText = "Claude is reading your script…";

  const showRolePicker = !loading && !error && steps.length > 0 && selectedRole === null && speakers.length > 0;

  const chooseRole = (role: string) => {
    setSelectedRole(role);
    setVoicesConfirmed(false);
  };

  const startReading = () => {
    setCharacterVoices(prev => {
      const next = { ...prev };
      voiceableSpeakers.forEach(speaker => {
        if (!next[speaker] && voices[0]) next[speaker] = voices[0].id;
      });
      return next;
    });
    setVoicesConfirmed(true);
  };

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
      {loading && (
        <div className="home-hero viewer-loading">
          <div className="home-crescent" />
          <div className="home-text">
            <h1 className="home-title">READING<br />YOUR SCRIPT</h1>
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
                  onClick={() => chooseRole(speaker)}
                >
                  {speaker}
                </button>
              ))}
            </div>
            <button
              className="role-picker__skip"
              onClick={() => chooseRole("")}
            >
              Just watch
            </button>
          </div>
          {hills}
        </div>
      )}

      {showVoiceGate && (
        <div className="role-picker">
          <div className="home-crescent" />
          <div className="role-picker__content">
            <h2 className="role-picker__title">
              CAST THE<br />OTHER<br />VOICES
            </h2>
            <p className="role-picker__subtitle">Choose a voice for each character before you start</p>
            <div className="voice-gate__list">
              {voiceableSpeakers.map(speaker => (
                <div className="voice-picker__row" key={speaker}>
                  <span className="voice-picker__name">{speaker}</span>
                  <select
                    className="voice-picker__select"
                    value={characterVoices[speaker] ?? voices[0]?.id ?? ""}
                    onChange={(e) =>
                      setCharacterVoices(prev => ({ ...prev, [speaker]: e.target.value }))
                    }
                  >
                    {voices.length === 0 && <option value="">Loading voices…</option>}
                    {voices.map(v => (
                      <option key={v.id} value={v.id}>{describeVoice(v)}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <button
              className="voice-gate__start"
              onClick={startReading}
              disabled={voices.length === 0}
            >
              Start Reading
            </button>
          </div>
          {hills}
        </div>
      )}

      <div className="viewer-page">
        <header className="viewer-header">
          <div className="viewer-header__left">
            <button className="viewer-header__brand" onClick={() => navigate("/")}>
              AuditionWithMe
            </button>
            <Link to="/about" className="site-nav__link">About</Link>
          </div>
        </header>

        <div className="viewer-body">
          {error && <p className="viewer-error">{error}</p>}

          {!loading && !error && steps.length === 0 && (
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
