import { useEffect, useMemo, useRef, useState } from "react";
import type { Step } from "../../types";
import {
  dialogueTurnsLabel,
  humanizeVoiceLabel,
  spokenLines,
  type Voice,
} from "../../lib/script";
import { useTtsPlayer } from "../../hooks/useTtsPlayer";
import {
  clampCharacterVolume,
  MAX_CHARACTER_VOLUME,
} from "../../lib/characterVolume";
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
  /** On to step 4 with the current voices. */
  onStart: () => void;
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
            ? `${name} · changes ${changes.map((other) => filterLabel(other).toLowerCase()).join(", ")}`
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
        name={speaker}
        detail={dialogueTurnsLabel(spokenLines(steps, speaker).length)}
        quote={previewLineFor(speaker)}
        disabled={!voiceFor(speaker)}
        onClick={() => preview(speaker)}
      />
    );
  };

  return (
    <SetupStep
      step={3}
      title="Direct your scene partners"
      scriptName={scriptName}
      onGoToStep={(step) => {
        stop();
        onGoToStep(step);
      }}
    >
      <div className="role-intro">
        <h1>Your readers</h1>
      </div>
      <>
          {/* Under the title, open or not; the options take the cards'
              place while open. */}
          <Accordion
            id="voice-advanced"
            className="voice-advanced-accordion"
            open={advancedOpen}
            onOpenChange={toggleAdvanced}
            showLabel="Show advanced options"
            hideLabel="Hide advanced options"
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
                  aria-valuetext={`${Math.round(volume * 100)}%`}
                />
                <output>{Math.round(volume * 100)}%</output>
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
              {/* Picks are kept as they're made: Save just closes, like
                  Hide advanced options. */}
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

          {/* Hidden while advanced options are open: close them to leave
              the step. */}
          {!advancedOpen && (
            <SetupActions
              onBack={() => {
                stop();
                onGoToStep(2);
              }}
              nextLabel="Get ready"
              nextDisabled={!currentVoice}
              onNext={onStart}
            />
          )}
        </>
    </SetupStep>
  );
}
