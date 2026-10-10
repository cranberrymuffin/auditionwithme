import { useEffect, useMemo, useRef, useState } from "react";
import type { Step } from "../../types";
import {
  describeVoice,
  dialogueTurnsLabel,
  displayCharacterName,
  humanizeVoiceLabel,
  spokenLines,
  voiceDisplayName,
  type Voice,
} from "../../lib/script";
import { useTtsPlayer } from "../../hooks/useTtsPlayer";
import {
  clampCharacterVolume,
  MAX_CHARACTER_VOLUME,
} from "../../lib/characterVolume";
import type { ReaderAudioPregenState } from "../../hooks/useReaderAudioPregen";
import SetupStep from "./SetupStep";
import SetupActions from "./SetupActions";
import CastGrid, { CastCard } from "./CastGrid";
import Accordion from "./Accordion";
import { useToast } from "../../lib/toast";

type FilterKey = "accent" | "gender" | "age" | "tone";
const FILTER_KEYS: FilterKey[] = ["gender", "accent", "age", "tone"];
const filterLabel = (key: FilterKey) =>
  key === "gender" ? "Voice type" : humanizeVoiceLabel(key);
// How long a filter that changed because of another one stays highlighted.
const CHANGED_HIGHLIGHT_MS = 1600;
// If the opening lines still aren't pre-generated after this long (a busy
// account, a slow network), offer to start anyway — those lines then fetch
// live during the take instead of keeping the actor waiting here.
const START_ANYWAY_AFTER_MS = 20_000;
// Share of the scene partner's lines pre-generated before Start rehearsal
// opens up on the preparing screen (the opening lines must be ready too).
const READY_TO_START_SHARE = 0.25;

const displayCharacter = displayCharacterName;

export default function VoiceCasting({
  speakers,
  steps,
  voices,
  characterVoices,
  characterVolumes,
  onVolumeChange,
  languageCode,
  onPick,
  preparing,
  pregen,
  onStart,
  onStartAnyway,
  onGoToStep,
  scriptName,
}: {
  speakers: string[];
  steps: Step[];
  voices: Voice[];
  characterVoices: Record<string, string>;
  languageCode: string;
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
  /** Back to an earlier step (1-based), from the header's step bars. */
  onGoToStep: (step: number) => void;
  /** The script's name, shown in the step row. */
  scriptName: string;
}) {
  const toast = useToast();
  const { play, stop, setVolume } = useTtsPlayer();
  const [activeSpeaker, setActiveSpeaker] = useState(speakers[0] ?? "");
  // The speaker whose voice preview is playing, if any.
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Filters that just changed because of a pick in another one.
  const [changedFilters, setChangedFilters] = useState<FilterKey[]>([]);
  const [startAnywayOffered, setStartAnywayOffered] = useState(false);
  const preparingHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const readyToStart =
    pregen.done ||
    (pregen.canStart &&
      pregen.total > 0 &&
      pregen.ready / pregen.total >= READY_TO_START_SHARE);
  const canStartNow =
    readyToStart || startAnywayOffered || pregen.failed > 0;

  useEffect(() => {
    if (!preparing) {
      setStartAnywayOffered(false);
      return;
    }
    // The voice controls are gone while preparing: silence any preview still
    // playing and move focus off the vanished Start button.
    stop();
    setPreviewing(null);
    preparingHeadingRef.current?.focus();
    const timer = setTimeout(
      () => setStartAnywayOffered(true),
      START_ANYWAY_AFTER_MS,
    );
    return () => clearTimeout(timer);
  }, [preparing, stop]);

  useEffect(() => {
    if (!changedFilters.length) return;
    const timer = setTimeout(() => setChangedFilters([]), CHANGED_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [changedFilters]);

  const languageVoices = useMemo(() => {
    const matches = voices.filter((voice) => voice.language === languageCode);
    return matches.length ? matches : voices;
  }, [voices, languageCode]);

  // Every value among the language's voices, whatever the other filters.
  // Every value among the language's voices, whatever the other filters.
  const facetValues = (key: FilterKey) =>
    [
      ...new Set(languageVoices.map((voice) => voice[key]).filter(Boolean)),
    ].sort();

  const previewLineFor = (speaker: string) =>
    spokenLines(steps, speaker)[0]?.verbalLine ?? `Hello, I'm ${speaker}.`;
  // The voice actually cast for a speaker — none while casting's still
  // running. (voiceFor below falls back so the controls always have one.)
  const castVoice = (speaker: string) =>
    voices.find((voice) => voice.id === characterVoices[speaker]);
  const voiceFor = (speaker: string) =>
    voices.find((voice) => voice.id === characterVoices[speaker]) ??
    languageVoices[0];
  const currentVoice = voiceFor(activeSpeaker);
  const volume = clampCharacterVolume(characterVolumes[activeSpeaker]);
  const changeVolume = (next: number) => {
    onVolumeChange(activeSpeaker, next);
    if (previewing === activeSpeaker) setVolume(next);
  };
  // The voice each speaker started with (auto-cast, or saved from a past
  // rehearsal), for Restore default.
  const initialVoicesRef = useRef<Record<string, string>>({});
  speakers.forEach((speaker) => {
    if (!initialVoicesRef.current[speaker] && characterVoices[speaker]) {
      initialVoicesRef.current[speaker] = characterVoices[speaker];
    }
  });
  const initialVoiceId = initialVoicesRef.current[activeSpeaker];
  // Likewise each speaker's starting volume.
  const initialVolumesRef = useRef<Record<string, number>>({});
  speakers.forEach((speaker) => {
    if (!(speaker in initialVolumesRef.current)) {
      initialVolumesRef.current[speaker] = clampCharacterVolume(
        characterVolumes[speaker],
      );
    }
  });
  const initialVolume = initialVolumesRef.current[activeSpeaker];
  const voiceChanged = !!initialVoiceId && initialVoiceId !== currentVoice?.id;
  const volumeChanged = volume !== initialVolume;

  const pickVoice = (voiceId: string) => {
    stop();
    setPreviewing(null);
    onPick(activeSpeaker, voiceId);
  };
  // The filters show the current voice's own type, accent, age and tone.
  // Picking one switches to a voice with it that keeps the most of the other
  // three (ties going to the earlier filters); the rest change to match.
  const changedBy = (voice: Voice, key: FilterKey) =>
    FILTER_KEYS.filter(
      (other) => other !== key && voice[other] !== currentVoice?.[other],
    );
  const bestVoiceFor = (key: FilterKey, value: string) => {
    const score = (voice: Voice) => {
      const kept = FILTER_KEYS.filter(
        (other) => other !== key && !changedBy(voice, key).includes(other),
      );
      return (
        kept.length * 16 +
        kept.reduce(
          (bits, other) => bits + (8 >> FILTER_KEYS.indexOf(other)),
          0,
        )
      );
    };
    return languageVoices
      .filter((voice) => voice[key] === value)
      .reduce<
        Voice | undefined
      >((top, voice) => (!top || score(voice) > score(top) ? voice : top), undefined);
  };
  // A filter's options, each labeled with the other filters picking it would
  // change; the ones that change nothing first, then fewest changes.
  const filterOptions = (key: FilterKey) =>
    facetValues(key)
      .map((value) => {
        const best =
          value === currentVoice?.[key] ? undefined : bestVoiceFor(key, value);
        const changes = best ? changedBy(best, key) : [];
        const name = humanizeVoiceLabel(value);
        return {
          value,
          changes,
          label: changes.length
            ? `${name} (also changes ${changes.map((other) => filterLabel(other).toLowerCase()).join(" and ")})`
            : name,
        };
      })
      .sort((a, b) => a.changes.length - b.changes.length);
  const pickFilter = (key: FilterKey, value: string) => {
    const best = bestVoiceFor(key, value);
    if (!best) return;
    setChangedFilters(changedBy(best, key));
    pickVoice(best.id);
  };

  // A card's play button: plays that speaker's voice, or stops it if it's
  // the one playing. The speaker becomes the one Advanced options adjusts.
  const preview = async (speaker: string) => {
    stop();
    if (previewing === speaker) {
      setPreviewing(null);
      return;
    }
    const voice = voiceFor(speaker);
    if (!voice) return;
    setActiveSpeaker(speaker);
    setPreviewing(speaker);
    try {
      await play(
        { text: previewLineFor(speaker), voiceId: voice.id },
        {
          volume: clampCharacterVolume(characterVolumes[speaker]),
          onEnded: () =>
            setPreviewing((playing) => (playing === speaker ? null : playing)),
        },
      );
    } catch {
      setPreviewing((playing) => (playing === speaker ? null : playing));
      toast("That voice preview couldn't be played. Try again.");
    }
  };

  // \uFE0E: text, not emoji, so ▶ takes the card's color.
  const playMark = (playing: boolean) => (playing ? "Ⅱ" : "▶\uFE0E");
  // A speaker's card: plays their voice reading their first line.
  const playCard = (speaker: string) => {
    const playing = previewing === speaker;
    return (
      <CastCard
        key={speaker}
        aria-pressed={playing}
        active={playing}
        className="role-option--play"
        mark={playMark(playing)}
        name={displayCharacter(speaker)}
        detail={`${castVoice(speaker) ? `Voice: ${voiceDisplayName(castVoice(speaker)!.name)}` : "Choosing a voice…"} · ${dialogueTurnsLabel(spokenLines(steps, speaker).length)}`}
        aria-label={castVoice(speaker) ? `Play ${displayCharacter(speaker)}'s voice, ${voiceDisplayName(castVoice(speaker)!.name)}` : `${displayCharacter(speaker)}: choosing a voice`}
        quote={previewLineFor(speaker)}
        disabled={!castVoice(speaker)}
        onClick={() => preview(speaker)}
      />
    );
  };

  return (
    <SetupStep
      step={3}
      scriptName={scriptName}
      onGoToStep={(step) => {
        stop();
        onGoToStep(step);
      }}
    >
      <div className="role-intro">
        <h1>Your scene partners</h1>
        {!preparing && (
          <span>Tap a card to hear who’s reading each part.</span>
        )}
      </div>
      {preparing ? (
        <div className="voice-selector-panel preparing-panel">
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
          {/* The progress bar is the start button: disabled until enough
              lines are ready, unless it's been a while or some failed, when
              it offers Start anyway. */}
          <button
            type="button"
            className={`preparing-progress ${canStartNow ? "is-ready" : ""}`}
            disabled={!canStartNow}
            onClick={onStartAnyway}
          >
            <i
              aria-hidden="true"
              style={{
                width: `${pregen.total ? (pregen.ready / pregen.total) * 100 : 0}%`,
              }}
            />
            <span role="status">
              {pregen.waitingForDirection || pregen.total === 0
                ? "Directing the scene…"
                : `${
                    readyToStart
                      ? "Start rehearsal"
                      : canStartNow
                        ? "Start anyway"
                        : "Preparing your scene partner’s lines"
                  } · ${pregen.ready} of ${pregen.total}`}
            </span>
          </button>
          <div className="preparing-note">
            <p>
              {pregen.failed > 0
                ? "Some lines couldn’t be pre-loaded; they’ll load as you go."
                : readyToStart
                  ? "The rest keep loading while you rehearse."
                  : "You can start once enough lines are ready."}
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Under the title, open or not; the options take the cards'
              place while open. */}
          <Accordion
            id="voice-advanced"
            className="voice-advanced-accordion"
            open={advancedOpen}
            onOpenChange={(open) => {
              // The card that's playing is about to go.
              stop();
              setPreviewing(null);
              setAdvancedOpen(open);
            }}
            showLabel="Customize voices"
            hideLabel="Done customizing"
          >
            <div className="voice-advanced-panel">
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
                        setPreviewing(null);
                        setActiveSpeaker(speaker);
                      }}
                    >
                      {displayCharacter(speaker)}
                    </button>
                  ))}
                </div>
              )}
              <div className="voice-advanced-preview">
                <button
                  type="button"
                  className={`role-option--play ${previewing === activeSpeaker ? "is-selected" : ""}`}
                  aria-pressed={previewing === activeSpeaker}
                  aria-label={`Play ${displayCharacter(activeSpeaker)}'s voice`}
                  disabled={!currentVoice}
                  onClick={() => preview(activeSpeaker)}
                >
                  <span className="role-radio" aria-hidden="true">
                    {playMark(previewing === activeSpeaker)}
                  </span>
                </button>
                <span className="role-option-copy">
                  <q>{previewLineFor(activeSpeaker)}</q>
                </span>
              </div>
              <div className="voice-filter-bar">
                <div>
                  <strong>Refine voice</strong>
                </div>
                <button
                  disabled={!voiceChanged && !volumeChanged}
                  onClick={() => {
                    if (volumeChanged) changeVolume(initialVolume);
                    if (voiceChanged) pickVoice(initialVoiceId);
                  }}
                >
                  Restore default
                </button>
              </div>
              <label className="voice-volume">
                <span>Volume</span>
                <input
                  type="range"
                  min="0"
                  max={MAX_CHARACTER_VOLUME}
                  step="0.05"
                  value={volume}
                  onChange={(event) => changeVolume(Number(event.target.value))}
                  aria-label={`Volume for ${displayCharacter(activeSpeaker)}`}
                  aria-valuetext={`${Math.round(volume * 100)}%${volume === 1 ? ", normal" : ""}`}
                  list="voice-volume-marks"
                />
                <datalist id="voice-volume-marks">
                  <option value="1" label="Normal" />
                </datalist>
                <output>{volume === 1 ? "Normal" : `${Math.round(volume * 100)}%`}</output>
              </label>
              <div className="voice-setup-filters">
                {FILTER_KEYS.map((key) => (
                  <label
                    key={key}
                    className={
                      changedFilters.includes(key) ? "is-changed" : undefined
                    }
                  >
                    <span>{filterLabel(key)}</span>
                    <select
                      value={currentVoice?.[key] ?? ""}
                      onChange={(event) => pickFilter(key, event.target.value)}
                    >
                      {!currentVoice?.[key] && (
                        <option value="" disabled>
                          —
                        </option>
                      )}
                      {filterOptions(key).map(({ value, label }) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <p className="voice-filter-note">
                Each choice switches to the closest real voice; anything that
                changes along with it is highlighted.
              </p>
            </div>
          </Accordion>

          {!advancedOpen && (
            <CastGrid
              items={speakers}
              label="Scene partners"
              renderCard={playCard}
            />
          )}

          <SetupActions
            onBack={() => {
              stop();
              onGoToStep(2);
            }}
            nextLabel="Start rehearsal"
            nextDisabled={!currentVoice}
            nextHint="No voice is available for this script’s language yet."
            onNext={onStart}
          />
        </>
      )}
    </SetupStep>
  );
}
