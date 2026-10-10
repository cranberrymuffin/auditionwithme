import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Step } from "../../types";
import {
  describeVoice,
  humanizeVoiceLabel,
  normalizeSpeaker,
  voiceDisplayName,
  type Voice,
} from "../../lib/script";
import { useTtsPlayer } from "../../hooks/useTtsPlayer";
import {
  clampCharacterVolume,
  MAX_CHARACTER_VOLUME,
} from "../../lib/characterVolume";
import type { ReaderAudioPregenState } from "../../hooks/useReaderAudioPregen";
import { BrandMark } from "../SiteNav";
import StepHeader from "./StepHeader";
import { useToast } from "../../lib/toast";

type FilterKey = "accent" | "gender" | "age" | "tone";
// If the opening lines still aren't pre-generated after this long (a busy
// account, a slow network), offer to start anyway — those lines then fetch
// live during the take instead of keeping the actor waiting here.
const START_ANYWAY_AFTER_MS = 20_000;

const displayCharacter = (name: string) =>
  name
    .toLocaleLowerCase()
    .replace(/(^|[\s'-])\p{L}/gu, (letter) => letter.toLocaleUpperCase());

export default function VoiceCasting({
  speakers,
  steps,
  voices,
  characterVoices,
  characterVolumes,
  onVolumeChange,
  languageCode,
  languageName,
  onPick,
  preparing,
  pregen,
  onStart,
  onStartAnyway,
  onBack,
  scriptName,
}: {
  speakers: string[];
  steps: Step[];
  voices: Voice[];
  characterVoices: Record<string, string>;
  languageCode: string;
  languageName: string;
  onPick: (speaker: string, voiceId: string) => void;
  /** Speaker → level (missing = unity), fixed once the take starts. */
  characterVolumes: Record<string, number>;
  onVolumeChange: (speaker: string, volume: number) => void;
  /** Start was clicked and the scene partner's lines are being prepared;
   * Practice moves on to Rehearsal once the opening ones are ready. */
  preparing: boolean;
  pregen: ReaderAudioPregenState;
  /** Begin preparing with the current voices. */
  onStart: () => void;
  /** Skip the rest of the wait and go straight to Rehearsal. */
  onStartAnyway: () => void;
  onBack: () => void;
  /** The script's name, shown in the step row. */
  scriptName: string;
}) {
  const toast = useToast();
  const { play, stop, setVolume } = useTtsPlayer();
  const [activeSpeaker, setActiveSpeaker] = useState(speakers[0] ?? "");
  const [previewing, setPreviewing] = useState(false);
  const [filters, setFilters] = useState<Record<FilterKey, string>>({
    accent: "",
    gender: "",
    age: "",
    tone: "",
  });
  const [startAnywayOffered, setStartAnywayOffered] = useState(false);
  const preparingHeadingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (!preparing) {
      setStartAnywayOffered(false);
      return;
    }
    // The voice controls are gone while preparing: silence any preview still
    // playing and move focus off the vanished Start button.
    stop();
    setPreviewing(false);
    preparingHeadingRef.current?.focus();
    const timer = setTimeout(
      () => setStartAnywayOffered(true),
      START_ANYWAY_AFTER_MS,
    );
    return () => clearTimeout(timer);
  }, [preparing, stop]);

  const languageVoices = useMemo(() => {
    const matches = voices.filter((voice) => voice.language === languageCode);
    return matches.length ? matches : voices;
  }, [voices, languageCode]);

  const facetOptions = (key: FilterKey) => {
    const voicesMatchingOtherFilters = languageVoices.filter((voice) =>
      (Object.keys(filters) as FilterKey[]).every(
        (filterKey) =>
          filterKey === key ||
          !filters[filterKey] ||
          voice[filterKey] === filters[filterKey],
      ),
    );
    const values = new Set([
      ...voicesMatchingOtherFilters.map((voice) => voice[key]).filter(Boolean),
      ...(filters[key] ? [filters[key]] : []),
    ]);
    return [...values].sort().map((value) => ({
      value,
      count: voicesMatchingOtherFilters.filter((voice) => voice[key] === value)
        .length,
    }));
  };
  const facetTotal = (key: FilterKey) =>
    languageVoices.filter((voice) =>
      (Object.keys(filters) as FilterKey[]).every(
        (filterKey) =>
          filterKey === key ||
          !filters[filterKey] ||
          voice[filterKey] === filters[filterKey],
      ),
    ).length;

  const filteredVoices = languageVoices.filter((voice) =>
    (Object.keys(filters) as FilterKey[]).every(
      (key) => !filters[key] || voice[key] === filters[key],
    ),
  );
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const hasFilters = activeFilterCount > 0;

  const applyFilters = (nextFilters: Record<FilterKey, string>) => {
    stop();
    setPreviewing(false);
    setFilters(nextFilters);
    const firstMatch = languageVoices.find((voice) =>
      (Object.keys(nextFilters) as FilterKey[]).every(
        (key) => !nextFilters[key] || voice[key] === nextFilters[key],
      ),
    );
    if (firstMatch) onPick(activeSpeaker, firstMatch.id);
  };

  const dialogue = steps.filter(
    (step) =>
      normalizeSpeaker(step.speaker) === activeSpeaker &&
      step.verbalLine.trim(),
  );
  const previewLine = dialogue[0]?.verbalLine ?? `Hello, I'm ${activeSpeaker}.`;
  const currentVoice =
    voices.find((voice) => voice.id === characterVoices[activeSpeaker]) ??
    languageVoices[0];
  const volume = clampCharacterVolume(characterVolumes[activeSpeaker]);
  const changeVolume = (next: number) => {
    onVolumeChange(activeSpeaker, next);
    if (previewing) setVolume(next);
  };
  // The first voice each character is given (auto-casting, or the cast saved
  // from a past rehearsal) is the recommendation; anything picked under
  // Advanced options after that is the actor's own.
  const recommendedRef = useRef<Record<string, string>>({});
  speakers.forEach((speaker) => {
    if (!recommendedRef.current[speaker] && characterVoices[speaker]) {
      recommendedRef.current[speaker] = characterVoices[speaker];
    }
  });
  const isRecommended =
    !currentVoice ||
    !recommendedRef.current[activeSpeaker] ||
    recommendedRef.current[activeSpeaker] === currentVoice.id;
  // What's changed under the closed Advanced options, so it isn't hidden.
  const advancedNote = [
    activeFilterCount > 0 &&
      `${activeFilterCount} ${activeFilterCount === 1 ? "filter" : "filters"} on`,
    Math.round(volume * 100) !== 100 && `Volume ${Math.round(volume * 100)}%`,
  ]
    .filter(Boolean)
    .join(" · ");
  const visibleVoices =
    currentVoice &&
    !filteredVoices.some((voice) => voice.id === currentVoice.id)
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
      await play(
        { text: previewLine, voiceId: currentVoice.id },
        { volume, onEnded: () => setPreviewing(false) },
      );
    } catch {
      setPreviewing(false);
      toast("That voice preview couldn't be played. Try again.");
    }
  };

  const speakerList = speakers
    .map(displayCharacter)
    .join(speakers.length > 2 ? ", " : " and ");

  return (
    <main className="voice-setup-page">
      <header className="setup-header">
        <Link to="/" aria-label="Audition With Me home">
          <BrandMark />
        </Link>
        <div className="setup-progress">
          <span>
            Step 3 of 4 · Direct your scene partners
          </span>
          <div aria-hidden="true">
            <i />
            <i />
            <i className="is-active" />
            <i />
          </div>
        </div>
      </header>

      <section className="voice-setup-layout">
        <div className="voice-setup-intro">
          <button
            className="setup-back"
            onClick={() => {
              stop();
              onBack();
            }}
          >
            <span>←</span> Back
          </button>
          <StepHeader step={3} title="Direct your scene partners" scriptName={scriptName} />
          <h1>Choose your scene partner</h1>
          <div className="voice-setup-description">
            Select the {speakers.length === 1 ? "voice" : "voices"} that will
            read {speakerList}. Preview{" "}
            {speakers.length === 1 ? "it" : "each one"}, then adjust the voice
            settings before rehearsal.
          </div>
          <dl className="script-language">
            <dt>Script language</dt>
            <dd>{languageName}</dd>
          </dl>
        </div>

        <div className="voice-selector-panel">
          {preparing ? (
            <div className="preparing-panel">
              <header>
                <p>Cast locked in</p>
                <h2 ref={preparingHeadingRef} tabIndex={-1}>
                  Preparing your scene partners
                </h2>
              </header>
              <ul className="preparing-cast" aria-label="Your cast">
                {speakers.map((speaker) => {
                  const voice = voices.find(
                    (candidate) => candidate.id === characterVoices[speaker],
                  );
                  const descriptor = voice ? describeVoice(voice) : "";
                  return (
                    <li key={speaker}>
                      <span>{displayCharacter(speaker)}</span>
                      <strong>
                        {voice ? voiceDisplayName(voice.name) : "Default voice"}
                        {descriptor && <small> · {descriptor}</small>}
                      </strong>
                    </li>
                  );
                })}
              </ul>
              <div className="preparing-progress">
                <i
                  aria-hidden="true"
                  style={{
                    width: `${pregen.total ? (pregen.ready / pregen.total) * 100 : 0}%`,
                  }}
                />
                <span role="status">
                  {pregen.waitingForDirection || pregen.total === 0
                    ? "Directing the scene…"
                    : `Preparing your scene partner’s lines · ${pregen.ready} of ${pregen.total}`}
                </span>
              </div>
              <div className="preparing-note">
                <p>
                  {pregen.failed > 0
                    ? "Some lines couldn’t be pre-loaded; they’ll load as you go."
                    : "Rehearsal opens as soon as the first lines are ready."}
                </p>
                {(startAnywayOffered || pregen.failed > 0) && (
                  <button type="button" onClick={onStartAnyway}>
                    Start anyway
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {speakers.length > 1 && (
                <div
                  className="speaker-tabs"
                  role="tablist"
                  aria-label="Scene partners"
                >
                  {speakers.map((speaker) => (
                    <button
                      key={speaker}
                      role="tab"
                      aria-selected={activeSpeaker === speaker}
                      onClick={() => {
                        stop();
                        setPreviewing(false);
                        setActiveSpeaker(speaker);
                      }}
                    >
                      {displayCharacter(speaker)}
                    </button>
                  ))}
                </div>
              )}

              <header className="voice-panel-heading">
                <div>
                  <p>
                    {isRecommended ? "Recommended voice for" : "Your voice for"}
                  </p>
                  <h2>{displayCharacter(activeSpeaker)}</h2>
                </div>
              </header>
              <button
                className={`voice-preview-button ${previewing ? "is-playing" : ""}`}
                disabled={!currentVoice}
                onClick={preview}
              >
                <span aria-hidden="true">{previewing ? "Ⅱ" : "▶"}</span>
                {previewing ? "Pause preview" : "Preview voice"}
              </button>
              <q>{previewLine}</q>

              <details className="voice-advanced">
                <summary>
                  Advanced options
                  {advancedNote && <small>{advancedNote}</small>}
                  <span aria-hidden="true">+</span>
                </summary>
                <label className="voice-advanced-voice">
                  <span>Voice</span>
                  <select
                    value={currentVoice?.id ?? ""}
                    onChange={(event) =>
                      onPick(activeSpeaker, event.target.value)
                    }
                  >
                    {visibleVoices.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {voiceDisplayName(voice.name)} — {describeVoice(voice)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="voice-volume">
                  <span>Volume</span>
                  <input
                    type="range"
                    min="0"
                    max={MAX_CHARACTER_VOLUME}
                    step="0.05"
                    value={volume}
                    onChange={(event) =>
                      changeVolume(Number(event.target.value))
                    }
                    aria-label={`Volume for ${displayCharacter(activeSpeaker)}`}
                    aria-valuetext={`${Math.round(volume * 100)}%`}
                  />
                  <output>{Math.round(volume * 100)}%</output>
                </label>
                <div className="voice-filter-bar">
                  <div>
                    <strong>Refine voice filter</strong>
                    <span>
                      {filteredVoices.length} compatible{" "}
                      {filteredVoices.length === 1 ? "voice" : "voices"}
                    </span>
                  </div>
                  <button
                    disabled={!hasFilters}
                    onClick={() =>
                      applyFilters({
                        accent: "",
                        gender: "",
                        age: "",
                        tone: "",
                      })
                    }
                  >
                    Reset
                  </button>
                </div>
                <div className="voice-setup-filters">
                  {(["accent", "gender", "age", "tone"] as FilterKey[]).map(
                    (key) => (
                      <label key={key}>
                        <span>
                          {key === "gender"
                            ? "Voice type"
                            : humanizeVoiceLabel(key)}
                        </span>
                        <select
                          value={filters[key]}
                          onChange={(event) =>
                            applyFilters({
                              ...filters,
                              [key]: event.target.value,
                            })
                          }
                        >
                          <option value="">Any ({facetTotal(key)})</option>
                          {facetOptions(key).map(({ value, count }) => (
                            <option
                              key={value}
                              value={value}
                              disabled={count === 0}
                            >
                              {humanizeVoiceLabel(value)} ({count})
                            </option>
                          ))}
                        </select>
                      </label>
                    ),
                  )}
                </div>

                {filteredVoices.length === 0 && (
                  <p className="voice-filter-empty" role="status">
                    No additional voices match this combination. Your selected
                    voice is unchanged.
                  </p>
                )}
              </details>

              <button
                className="start-rehearsal"
                disabled={!currentVoice}
                onClick={onStart}
              >
                Start rehearsal <span>→</span>
              </button>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
