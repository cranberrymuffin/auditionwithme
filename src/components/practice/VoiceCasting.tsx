import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Step } from "../../types";
import {
  describeVoice,
  humanizeVoiceLabel,
  normalizeSpeaker,
  voiceDisplayName,
  type Voice,
} from "../../lib/script";
import { useTtsPlayer } from "../../hooks/useTtsPlayer";
import { Wordmark } from "../SiteNav";
import { useToast } from "../../lib/toast";

type FilterKey = "accent" | "gender" | "age" | "tone";

const displayCharacter = (name: string) =>
  name.toLocaleLowerCase().replace(/(^|[\s'-])\p{L}/gu, (letter) => letter.toLocaleUpperCase());

export default function VoiceCasting({
  speakers,
  steps,
  voices,
  characterVoices,
  languageCode,
  languageName,
  onPick,
  onStart,
  onBack,
}: {
  speakers: string[];
  steps: Step[];
  voices: Voice[];
  characterVoices: Record<string, string>;
  languageCode: string;
  languageName: string;
  onPick: (speaker: string, voiceId: string) => void;
  onStart: () => void;
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const { play, stop } = useTtsPlayer();
  const [activeSpeaker, setActiveSpeaker] = useState(speakers[0] ?? "");
  const [previewing, setPreviewing] = useState(false);
  const [filters, setFilters] = useState<Record<FilterKey, string>>({ accent: "", gender: "", age: "", tone: "" });

  const languageVoices = useMemo(() => {
    const matches = voices.filter((voice) => voice.language === languageCode);
    return matches.length ? matches : voices;
  }, [voices, languageCode]);

  const facetOptions = (key: FilterKey) => {
    const voicesMatchingOtherFilters = languageVoices.filter((voice) =>
      (Object.keys(filters) as FilterKey[]).every(
        (filterKey) => filterKey === key || !filters[filterKey] || voice[filterKey] === filters[filterKey]
      )
    );
    const values = new Set([
      ...voicesMatchingOtherFilters.map((voice) => voice[key]).filter(Boolean),
      ...(filters[key] ? [filters[key]] : []),
    ]);
    return [...values].sort().map((value) => ({
      value,
      count: voicesMatchingOtherFilters.filter((voice) => voice[key] === value).length,
    }));
  };
  const facetTotal = (key: FilterKey) =>
    languageVoices.filter((voice) =>
      (Object.keys(filters) as FilterKey[]).every(
        (filterKey) => filterKey === key || !filters[filterKey] || voice[filterKey] === filters[filterKey]
      )
    ).length;

  const filteredVoices = languageVoices.filter((voice) =>
    (Object.keys(filters) as FilterKey[]).every((key) => !filters[key] || voice[key] === filters[key])
  );
  const hasFilters = Object.values(filters).some(Boolean);

  const applyFilters = (nextFilters: Record<FilterKey, string>) => {
    stop();
    setPreviewing(false);
    setFilters(nextFilters);
    const firstMatch = languageVoices.find((voice) =>
      (Object.keys(nextFilters) as FilterKey[]).every(
        (key) => !nextFilters[key] || voice[key] === nextFilters[key]
      )
    );
    if (firstMatch) onPick(activeSpeaker, firstMatch.id);
  };

  const dialogue = steps.filter((step) => normalizeSpeaker(step.speaker) === activeSpeaker && step.verbalLine.trim());
  const previewLine = dialogue[0]?.verbalLine ?? `Hello, I'm ${activeSpeaker}.`;
  const currentVoice = voices.find((voice) => voice.id === characterVoices[activeSpeaker]) ?? languageVoices[0];
  const visibleVoices = currentVoice && !filteredVoices.some((voice) => voice.id === currentVoice.id)
    ? [currentVoice, ...filteredVoices]
    : filteredVoices;

  const preview = async () => {
    if (previewing) {
      stop();
      setPreviewing(false);
      return;
    }
    if (!currentVoice) return;
    setPreviewing(true);
    try {
      await play({ text: previewLine, voiceId: currentVoice.id }, { onEnded: () => setPreviewing(false) });
    } catch {
      setPreviewing(false);
      toast("That voice preview couldn't be played. Try again.");
    }
  };

  const speakerList = speakers.map(displayCharacter).join(speakers.length > 2 ? ", " : " and ");

  return (
    <main className="voice-setup-page">
      <header className="setup-header">
        <Link to="/" aria-label="Audition With Me home"><Wordmark /></Link>
        <div className="setup-progress" aria-label="Step 3 of 4: Voice setup">
          <span>Step 3 of 4</span>
          <div aria-hidden="true"><i /><i /><i className="is-active" /><i /></div>
        </div>
        <button onClick={() => navigate("/")} className="setup-header-action">Replace script</button>
      </header>

      <section className="voice-setup-layout">
        <div className="voice-setup-intro">
          <button className="voice-setup-back" onClick={() => { stop(); onBack(); }}><span>←</span> Back</button>
          <p>Step 3 of 4 · Voice setup</p>
          <h1>Choose your scene partner</h1>
          <div className="voice-setup-description">
            Select the {speakers.length === 1 ? "voice" : "voices"} that will read {speakerList}.
            Preview {speakers.length === 1 ? "it" : "each one"}, then adjust the voice settings before rehearsal.
          </div>
          <dl className="script-language">
            <dt>Script language</dt>
            <dd>{languageName}</dd>
          </dl>
        </div>

        <div className="voice-selector-panel">
          {speakers.length > 1 && (
            <div className="speaker-tabs" role="tablist" aria-label="Scene partners">
              {speakers.map((speaker) => (
                <button
                  key={speaker}
                  role="tab"
                  aria-selected={activeSpeaker === speaker}
                  onClick={() => { stop(); setPreviewing(false); setActiveSpeaker(speaker); }}
                >
                  {displayCharacter(speaker)}
                </button>
              ))}
            </div>
          )}

          <header className="voice-panel-heading">
            <div><p>Choose a voice for</p><h2>{displayCharacter(activeSpeaker)}</h2></div>
            <span>{dialogue.length} {dialogue.length === 1 ? "dialogue turn" : "dialogue turns"}</span>
          </header>

          <div className="voice-filter-bar">
            <div><strong>Refine voice filter</strong><span>{filteredVoices.length} compatible {filteredVoices.length === 1 ? "voice" : "voices"}</span></div>
            <button disabled={!hasFilters} onClick={() => applyFilters({ accent: "", gender: "", age: "", tone: "" })}>Reset</button>
          </div>
          <div className="voice-setup-filters">
            {(["accent", "gender", "age", "tone"] as FilterKey[]).map((key) => (
              <label key={key}>
                <span>{key === "gender" ? "Voice type" : humanizeVoiceLabel(key)}</span>
                <select
                  value={filters[key]}
                  onChange={(event) => applyFilters({ ...filters, [key]: event.target.value })}
                >
                  <option value="">Any ({facetTotal(key)})</option>
                  {facetOptions(key).map(({ value, count }) => (
                    <option key={value} value={value} disabled={count === 0}>
                      {humanizeVoiceLabel(value)} ({count})
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {filteredVoices.length === 0 && (
            <p className="voice-filter-empty" role="status">
              No additional voices match this combination. Your selected voice is unchanged.
            </p>
          )}

          <div className="selected-voice">
            <div className="selected-voice-heading"><span>Selected voice</span><strong>{currentVoice ? voiceDisplayName(currentVoice.name) : "Loading voices…"}</strong></div>
            {currentVoice && <p>{describeVoice(currentVoice)}</p>}
            <select
              aria-label={`Selected voice for ${activeSpeaker}`}
              value={currentVoice?.id ?? ""}
              onChange={(event) => onPick(activeSpeaker, event.target.value)}
            >
              {visibleVoices.map((voice) => <option key={voice.id} value={voice.id}>{voiceDisplayName(voice.name)} — {describeVoice(voice)}</option>)}
            </select>
            <button className={`voice-preview-button ${previewing ? "is-playing" : ""}`} disabled={!currentVoice} onClick={preview}>
              <span aria-hidden="true">{previewing ? "Ⅱ" : "▶"}</span>
              {previewing ? "Pause preview" : "Preview voice"}
            </button>
            <q>{previewLine}</q>
          </div>

          <button className="start-rehearsal" disabled={!currentVoice} onClick={() => { stop(); onStart(); }}>
            Start rehearsal <span>→</span>
          </button>
        </div>
      </section>
    </main>
  );
}
