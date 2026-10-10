import { useEffect, useMemo, useRef, useState } from "react";
import type { Step } from "../../types";
import {
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
import {
  CHARACTER_EMOTION_STEP,
  characterEmotionLabel,
  characterPaceLabel,
  clampCharacterEmotion,
  clampCharacterPace,
  MAX_CHARACTER_PACE,
  MIN_CHARACTER_PACE,
} from "../../lib/characterDelivery";
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

const displayCharacter = displayCharacterName;

export default function VoiceCasting({
  speakers,
  steps,
  voices,
  characterVoices,
  characterVolumes,
  onVolumeChange,
  characterEmotions,
  onEmotionChange,
  characterPaces,
  onPaceChange,
  languageCode,
  onPick,
  onStart,
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
  /** Speaker → emotion, -1 … 1 (missing = natural); changes the generated read. */
  characterEmotions: Record<string, number>;
  onEmotionChange: (speaker: string, emotion: number) => void;
  /** Speaker → playback rate (missing = normal), applied client-side. */
  characterPaces: Record<string, number>;
  onPaceChange: (speaker: string, pace: number) => void;
  /** On to step 4 with the current voices. */
  onStart: () => void;
  /** Back to an earlier step (1-based), from the header's step bars. */
  onGoToStep: (step: number) => void;
  /** The script's name, shown in the step row. */
  scriptName: string;
}) {
  const toast = useToast();
  const { play, stop, setVolume, setPlaybackRate } = useTtsPlayer();
  const [activeSpeaker, setActiveSpeaker] = useState(speakers[0] ?? "");
  // The speaker whose voice preview is playing, if any.
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Filters that just changed because of a pick in another one.
  const [changedFilters, setChangedFilters] = useState<FilterKey[]>([]);
  const toggleAdvanced = (open: boolean) => {
    // The card that's playing is about to go.
    stop();
    setPreviewing(null);
    setAdvancedOpen(open);
  };

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
  const emotion = clampCharacterEmotion(characterEmotions[activeSpeaker]);
  const changeEmotion = (next: number) => {
    // A preview playing was generated at the old emotion: hearing the new
    // one means playing it again.
    if (previewing === activeSpeaker) {
      stop();
      setPreviewing(null);
    }
    onEmotionChange(activeSpeaker, next);
  };
  const pace = clampCharacterPace(characterPaces[activeSpeaker]);
  const changePace = (next: number) => {
    onPaceChange(activeSpeaker, next);
    if (previewing === activeSpeaker) setPlaybackRate(next);
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
  // And their starting emotion and pace.
  const initialDeliveryRef = useRef<
    Record<string, { emotion: number; pace: number }>
  >({});
  speakers.forEach((speaker) => {
    if (!(speaker in initialDeliveryRef.current)) {
      initialDeliveryRef.current[speaker] = {
        emotion: clampCharacterEmotion(characterEmotions[speaker]),
        pace: clampCharacterPace(characterPaces[speaker]),
      };
    }
  });
  const initialDelivery = initialDeliveryRef.current[activeSpeaker];
  const voiceChanged = !!initialVoiceId && initialVoiceId !== currentVoice?.id;
  const volumeChanged = volume !== initialVolume;
  const emotionChanged = emotion !== initialDelivery?.emotion;
  const paceChanged = pace !== initialDelivery?.pace;

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
        {
          text: previewLineFor(speaker),
          voiceId: voice.id,
          emotion: clampCharacterEmotion(characterEmotions[speaker]) || undefined,
        },
        {
          volume: clampCharacterVolume(characterVolumes[speaker]),
          speed: clampCharacterPace(characterPaces[speaker]),
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
        <span>Tap a card to hear who’s reading each part.</span>
      </div>
      <>
          {/* Under the title, open or not; the options take the cards'
              place while open. */}
          <Accordion
            id="voice-advanced"
            className="voice-advanced-accordion"
            open={advancedOpen}
            onOpenChange={toggleAdvanced}
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
                  disabled={
                    !voiceChanged &&
                    !volumeChanged &&
                    !emotionChanged &&
                    !paceChanged
                  }
                  onClick={() => {
                    if (volumeChanged) changeVolume(initialVolume);
                    if (paceChanged) changePace(initialDelivery.pace);
                    if (emotionChanged) changeEmotion(initialDelivery.emotion);
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
              <label className="voice-volume">
                <span>Emotion</span>
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step={CHARACTER_EMOTION_STEP}
                  value={emotion}
                  onChange={(event) => changeEmotion(Number(event.target.value))}
                  aria-label={`Emotion for ${displayCharacter(activeSpeaker)}`}
                  aria-valuetext={characterEmotionLabel(emotion)}
                />
                <output>{characterEmotionLabel(emotion)}</output>
              </label>
              <label className="voice-volume">
                <span>Pace</span>
                <input
                  type="range"
                  min={MIN_CHARACTER_PACE}
                  max={MAX_CHARACTER_PACE}
                  step="0.05"
                  value={pace}
                  onChange={(event) => changePace(Number(event.target.value))}
                  aria-label={`Pace for ${displayCharacter(activeSpeaker)}`}
                  aria-valuetext={characterPaceLabel(pace)}
                  list="voice-pace-marks"
                />
                <datalist id="voice-pace-marks">
                  <option value="1" label="Normal" />
                </datalist>
                <output>{characterPaceLabel(pace)}</output>
              </label>
              <p className="voice-filter-note">
                Emotion sets how much feeling goes into each line: Reserved
                keeps it even, Expressive lets it swing. Pace speeds the voice
                up or slows it down without changing its pitch.
              </p>
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
              {/* Picks are kept as they're made: Save just closes, like
                  Done customizing. */}
              <button
                type="button"
                className="voice-advanced-save"
                onClick={() => toggleAdvanced(false)}
              >
                Save
              </button>
            </div>
          </Accordion>

          {!advancedOpen && (
            <CastGrid
              items={speakers}
              label="Scene partners"
              renderCard={playCard}
            />
          )}

          {/* While customizing, Save is the way out: one primary at a time. */}
          {!advancedOpen && (
            <SetupActions
              onBack={() => {
                stop();
                onGoToStep(2);
              }}
              nextLabel="Get ready"
              nextDisabled={!currentVoice}
              nextHint="No voice is available for this script’s language yet."
              onNext={onStart}
            />
          )}
        </>
    </SetupStep>
  );
}
