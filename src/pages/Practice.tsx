import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { ReplayScript, Step } from "../types";
import ParsingScreen from "../components/practice/ParsingScreen";
import ParseErrorScreen from "../components/practice/ParseErrorScreen";
import LanguageChoiceScreen from "../components/practice/LanguageChoiceScreen";
import RolePicker from "../components/practice/RolePicker";
import VoiceCasting from "../components/practice/VoiceCasting";
import CoachScenePartners from "../components/practice/CoachScenePartners";
import Rehearsal from "../components/practice/Rehearsal";
import { useAuth } from "../contexts/AuthContext";
import { findSavedScript, updateScript } from "../lib/scriptStore";
import { DIRECTOR_VERSION } from "../lib/director";
import { useSeo } from "../lib/seo";
import { useReaderAudioPregen } from "../hooks/useReaderAudioPregen";
import { coachTakeMap, loadCoachTakes } from "../lib/coachTakeStore";
import { readerLineIndices } from "../lib/readerLines";
import { loadUpload, peekUpload } from "../lib/pendingUpload";
import { loadScriptPdf } from "../lib/scriptPdfStore";
import { useStartRehearsal } from "../hooks/useStartRehearsal";
import { useScriptPersistence, type ParseData } from "../hooks/useScriptPersistence";
import { NOT_A_SCRIPT_MESSAGE, useScriptParse } from "../hooks/useScriptParse";
import { useAutoCasting } from "../hooks/useAutoCasting";
import { useVoiceCatalog } from "../hooks/useVoiceCatalog";
import { useDirectorTags } from "../hooks/useDirectorTags";
import { stepFromPath, useWizardHistory } from "../hooks/useWizardHistory";
import { STEP_NAMES } from "../components/practice/stepNames";

export default function Practice() {
  const location = useLocation();
  // Step 1's Replace script starts a new upload on this same route; keying
  // by its session starts the whole flow over for the new script.
  return <PracticeSession key={location.state?.session ?? "none"} />;
}

/** Finds the script's PDF before the flow mounts: a fresh upload (by the id
 * Home put in history state) from this tab at once or IndexedDB after a
 * reload, or a saved script's own stored PDF when it's reopened from My
 * Auditions. */
function PracticeSession() {
  const location = useLocation();
  const { user } = useAuth();
  const [uploadId] = useState<string | null>(
    () => location.state?.uploadId ?? null,
  );
  const [savedScriptId] = useState<string | null>(
    () => location.state?.replayScript?.id ?? null,
  );
  const [contentHash] = useState<string | null>(
    () => location.state?.contentHash ?? null,
  );
  const [upload, setUpload] = useState<{ file: File | null } | null>(() => {
    if (uploadId) {
      const file = peekUpload(uploadId);
      return file ? { file } : null;
    }
    return savedScriptId ? null : { file: null };
  });
  // The script as saved now, not as history state remembers it: after a
  // reload, a fresh upload's parse (and any casting and direction since) is
  // on its saved row, so the session picks up from there instead of paying
  // for the parse, casting and director calls again. undefined = looking.
  const [saved, setSaved] = useState<ReplayScript | null | undefined>(() =>
    savedScriptId || contentHash ? undefined : null,
  );
  useEffect(() => {
    if (upload) return;
    let active = true;
    const load = uploadId
      ? loadUpload(uploadId)
      : savedScriptId
        ? loadScriptPdf(savedScriptId).catch((err) => {
            // The script still opens, just without its PDF to show.
            console.warn("Couldn't load the script's stored PDF:", err);
            return null;
          })
        : Promise.resolve(null);
    void load.then((file) => {
      if (active) setUpload({ file });
    });
    return () => {
      active = false;
    };
  }, [upload, uploadId, savedScriptId]);
  useEffect(() => {
    if (saved !== undefined || !user) return;
    let active = true;
    void findSavedScript(user.id, { id: savedScriptId, contentHash })
      .catch((err) => {
        // Not the same as "not saved": the session carries on from history
        // state alone, and a fresh upload is parsed again.
        console.warn("Couldn't look up the saved script:", err);
        return null;
      })
      .then((script) => {
        if (active) setSaved(script);
      });
    return () => {
      active = false;
    };
  }, [saved, user, savedScriptId, contentHash]);

  if (!upload || saved === undefined)
    return <div className="cinematic-page" aria-busy="true" />;
  return <PracticeFlow file={upload.file} saved={saved} />;
}

function PracticeFlow({
  file,
  saved,
}: {
  file: File | null;
  /** This script's saved row, when it has one already (a replay, or a
   * reload after the parse landed). */
  saved: ReplayScript | null;
}) {
  const startRehearsal = useStartRehearsal();
  // Step 1's Replace script: a new upload, in place of this one.
  const replaceScript = (next: File) =>
    void startRehearsal(next, { replace: true });
  const location = useLocation();
  const { user } = useAuth();
  // Read once: each wizard step below gets its own history entry, and the
  // router hands back a fresh copy of this state on every Back — reading it
  // live would make the file and replayScript look new and re-run setup.
  const [entryState] = useState(() => location.state);
  // Issued once by Home.tsx's start-rehearsal call; reused read-only by every
  // parse call (including retries and the bilingual re-parse) — never
  // re-requested here. See api/_entitlement.ts and the auth-subscriptions plan.
  const rehearsalGrant: string | null = entryState?.rehearsalGrant ?? null;
  const replayScript: ReplayScript | null =
    saved ?? entryState?.replayScript ?? null;
  // A reload mid-flow lands back on the step its URL names: the role picked
  // then rides along in history state (see useWizardHistory's goToStepUrl).
  const [resumeStep] = useState(() =>
    replayScript ? stepFromPath(location.pathname) : 0,
  );
  const resumeRole: string | null =
    typeof entryState?.chosenRole === "string" ? entryState.chosenRole : null;
  // Set by MyAccount's "Practice as X" button to jump straight to Rehearsal
  // with a previously-confirmed cast, skipping RolePicker/VoiceCasting.
  // Undefined (not just falsy — "" is a valid role, "listen to the full
  // scene") means "no preset", i.e. the ordinary/Recast flow through both
  // screens.
  const presetRoleRaw: unknown = entryState?.selectedRole;
  const hasPresetRole = typeof presetRoleRaw === "string";
  const presetRole = typeof presetRoleRaw === "string" ? presetRoleRaw : "";

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
  const [characterEmotions, setCharacterEmotions] = useState<
    Record<string, number>
  >({});
  const [characterPaces, setCharacterPaces] = useState<
    Record<string, number>
  >({});
  // Step index → the actor's coached take of that scene partner line
  // (CoachScenePartners.tsx), played in place of its AI read.
  const [coachTakes, setCoachTakes] = useState<Record<number, string>>({});
  // The coaching screen is open, over step 3.
  const [coaching, setCoaching] = useState(false);
  // This script's id from the moment it's uploaded (a replay's own), so
  // everything kept on-device for it — reader audio included — is filed
  // under it from the start. The saved row with this id only exists once
  // scriptSaved: signed in, and the parse has been written.
  const [scriptId] = useState(() => replayScript?.id ?? crypto.randomUUID());
  const [voicesConfirmed, setVoicesConfirmed] = useState(false);
  // Characters the user has confirmed a full cast for and rehearsed as, this
  // script's saved row plus anything newly confirmed this session.
  const [rolesRead, setRolesRead] = useState<string[]>([]);
  const [scriptLanguage, setScriptLanguage] = useState({
    code: "en",
    name: "English",
  });

  const { scriptSaved, scriptTitle, setScriptTitle, cacheParse } =
    useScriptPersistence({
      user,
      file,
      scriptId,
      existingId: replayScript?.id,
      uploadContentHash: entryState?.contentHash ?? null,
    });
  const {
    loading,
    processingPhase,
    error,
    notScript,
    tooLarge,
    retry: retryParse,
    languageChoice,
    setLanguageChoice,
    pendingParse,
    parseSource,
    setPendingParse,
    rehearseOriginalLanguage,
  } = useScriptParse({
    file,
    rehearsalGrant,
    skip: Boolean(replayScript),
    cacheParse,
  });
  const [deliveryTags, setDeliveryTags] = useDirectorTags({
    steps,
    canSave: Boolean(user) && scriptSaved,
    scriptId,
    replayScript,
  });

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

  const finalizeParse = (data: ParseData) => {
    applyParseResult(data);
    cacheParse(data, false);
  };

  const voiceableSpeakers = characters.filter((s) => s !== selectedRole);
  // The role last picked, so Forward can re-pick it ("" — listen to the
  // whole scene — is a real choice, unlike roleDraft's null).
  const chosenRoleRef = useRef<string | null>(null);

  // Replay path: launch straight from a previously saved parse, no AI call.
  // Saved casting and delivery tags seed state so the auto-cast and director
  // hooks can skip their model calls.
  useEffect(() => {
    if (!replayScript) return;
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
    if (
      replayScript.characterVoices &&
      Object.keys(replayScript.characterVoices).length
    ) {
      setCharacterVoices(replayScript.characterVoices);
    }
    if (replayScript.characterVolumes) {
      setCharacterVolumes(replayScript.characterVolumes);
    }
    if (replayScript.characterEmotions) {
      setCharacterEmotions(replayScript.characterEmotions);
    }
    if (replayScript.characterPaces) {
      setCharacterPaces(replayScript.characterPaces);
    }
    // Tags from an older director prompt are dropped rather than seeded, so
    // the director pass re-runs with the current prompt (and overwrites the
    // row). The scene reads unadorned until the new tags land, exactly as on
    // a fresh parse.
    if (
      replayScript.deliveryTags &&
      replayScript.directorVersion === DIRECTOR_VERSION
    ) {
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
    } else if (resumeStep >= 2 && resumeRole !== null) {
      chosenRoleRef.current = resumeRole;
      setRoleDraft(resumeRole || null);
      setSelectedRole(resumeRole);
      // Back on step 4 only with the cast that was confirmed for it saved.
      const voices = replayScript.characterVoices ?? {};
      const castSaved = replayScript.characters
        .filter((name) => name !== resumeRole)
        .every((name) => voices[name]);
      if (resumeStep === 3 && castSaved) setVoicesConfirmed(true);
    }
  }, [replayScript, hasPresetRole, presetRole]); // eslint-disable-line react-hooks/exhaustive-deps -- resume is read once

  // Auto-casting has answered (or failed): anyone it left uncast gets a
  // default voice of their own from here on.
  const castingSettled = useAutoCasting({
    steps,
    languageCode: scriptLanguage.code,
    savedVoices: replayScript?.characterVoices,
    setCharacterVoices,
  });

  // Coached takes kept on-device from earlier sessions. Only those whose
  // line still reads as recorded apply (a re-parse can change the lines).
  useEffect(() => {
    if (!steps.length) return;
    let active = true;
    void loadCoachTakes(scriptId)
      .then((records) => {
        if (active) setCoachTakes(coachTakeMap(records, steps));
      })
      .catch((err) => console.warn("Couldn't load coached takes:", err));
    return () => {
      active = false;
    };
  }, [scriptId, steps]);

  const voices = useVoiceCatalog();

  // Fills anyone still uncast — each with a different voice in the script's
  // language, so a failed auto-cast never leaves the whole scene sounding
  // like one person.
  const withDefaultVoices = (base = characterVoices) => {
    const next = { ...base };
    const inLanguage = voices.filter((voice) => voice.language === scriptLanguage.code);
    const pool = inLanguage.length ? inLanguage : voices;
    const used = new Set(Object.values(next));
    voiceableSpeakers.forEach((speaker) => {
      if (next[speaker]) return;
      const voice = pool.find((candidate) => !used.has(candidate.id)) ?? pool[0];
      if (!voice) return;
      next[speaker] = voice.id;
      used.add(voice.id);
    });
    return next;
  };
  const withDefaultVoicesRef = useRef(withDefaultVoices);
  withDefaultVoicesRef.current = withDefaultVoices;
  useEffect(() => {
    if (!castingSettled || !voices.length) return;
    setCharacterVoices((current) => {
      const next = withDefaultVoicesRef.current(current);
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [castingSettled, voices, selectedRole]);

  // VoiceCasting's Next, on to step 4: fill any uncast speaker so the voices
  // pre-generated there are exactly the ones Rehearsal will play.
  const startReading = () => {
    const next = withDefaultVoices();
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
    if (user && scriptSaved) {
      void updateScript(scriptId, {
        characterVoices: next,
        characterVolumes,
        characterEmotions,
        characterPaces,
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
    if (user && scriptSaved) {
      void updateScript(scriptId, { rolesRead: next }).catch((err) =>
        console.error("Failed to save role history:", err),
      );
    }
  };

  // Pre-generate the scene partner's lines from step 4 on (never while just
  // browsing voices on step 3 — every line costs credits), and keep going
  // through the take so it makes no ElevenLabs round trips. The cast is
  // fixed by then; backing out stops it, and coming back restarts with only
  // the changed lines.
  const rehearsalShowing =
    !loading &&
    !pendingParse &&
    !error &&
    !languageChoice &&
    steps.length > 0 &&
    selectedRole !== null &&
    (voicesConfirmed || voiceableSpeakers.length === 0);
  const pregen = useReaderAudioPregen({
    enabled: rehearsalShowing,
    steps,
    selectedRole: selectedRole ?? "",
    characterVoices,
    characterEmotions,
    coachTakes,
    deliveryTags,
    // Pinned, as in Rehearsal — part of the cache key.
    intensity: "natural",
    scriptId,
    languageCode: scriptLanguage.code,
  });

  // The name shown for this script everywhere in the flow: a rename, else
  // the saved title, else the uploaded file's name.
  const scriptName =
    scriptTitle ?? replayScript?.title ?? file?.name ?? "Rehearsal";

  // Step 1 (upload) revisited: the parse is already applied, so this only
  // shows the finished upload screen again until Continue (or Forward).
  // A script parsed before (re-uploaded, or reopened from My Auditions)
  // opens here too, already complete — every rehearsal starts at step 1.
  const [reviewingUpload, setReviewingUpload] = useState(
    () =>
      !!replayScript &&
      !hasPresetRole &&
      !replayScript.needsLanguageChoice &&
      resumeStep === 0,
  );

  const chooseRole = (role: string) => {
    setCoaching(false);
    chosenRoleRef.current = role;
    setRoleDraft(role || null);
    setSelectedRole(role);
    setVoicesConfirmed(false);
    if (role && characters.filter((s) => s !== role).length === 0) {
      recordRoleReadWithNoCasting(role);
    }
  };

  // Wizard step on screen, mirroring the render order below: 0 upload
  // (parsing, its finished preview, or anything before a role can be
  // picked), 1 RolePicker, 2 VoiceCasting, 3 Rehearsal (step 4, then the
  // take).
  const wizardStep =
    loading ||
    pendingParse ||
    reviewingUpload ||
    error ||
    languageChoice ||
    steps.length === 0
      ? 0
      : selectedRole === null
        ? characters.length > 0
          ? 1
          : 0
        : !voicesConfirmed && voiceableSpeakers.length > 0
          ? 2
          : 3;

  // The tab title names the step, like a page of its own would.
  useSeo({
    title: STEP_NAMES[wizardStep],
    description: "Rehearse your script with every other character read aloud.",
    path: "/practice",
    noindex: true,
  });

  const showEarlierStep = (target: number) => {
    setCoaching(false);
    if (target <= 1) {
      setSelectedRole(null);
      setVoicesConfirmed(false);
      if (target === 0) setReviewingUpload(true);
    } else {
      setVoicesConfirmed(false);
    }
  };

  const continueFromParse = (data: ParseData) => {
    finalizeParse(data);
    setPendingParse(null);
  };

  // A clean first read goes straight on to choosing a role: there's nothing
  // on the finished-upload screen the actor has to do. It's still there
  // behind Back (showEarlierStep(0) → reviewingUpload) to check or rename
  // the script. Held for the cases that do want a look first: the long
  // original-language re-read (the actor may have stepped away), and a
  // parse with no named characters, which would skip past every setup step.
  const autoContinuedRef = useRef(false);
  const continueFromParseRef = useRef(continueFromParse);
  continueFromParseRef.current = continueFromParse;
  useEffect(() => {
    if (!pendingParse || autoContinuedRef.current) return;
    // Only the first parse to land; a later one waits for Continue.
    autoContinuedRef.current = true;
    if (parseSource !== "upload" || !(pendingParse.characters?.length)) return;
    continueFromParseRef.current(pendingParse);
  }, [pendingParse, parseSource]);

  /** Re-makes the choice that leads past the current step; false if
   * there's none to re-make (still parsing, no role picked yet). */
  const advanceStep = (): boolean => {
    if (wizardStep === 0) {
      if (reviewingUpload) {
        setReviewingUpload(false);
        return true;
      }
      if (pendingParse) {
        continueFromParse(pendingParse);
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
      startReading();
      return true;
    }
    return false;
  };

  const { goToStep, stepBack, setRecordingActive } = useWizardHistory({
    wizardStep,
    stepCount: steps.length,
    selectedRole,
    resumeStep,
    // "Practice as" jumps straight into Rehearsal, so it alone has no step 1
    // to go back to.
    hasUploadStep: !hasPresetRole,
    showEarlierStep,
    advanceStep,
  });

  if (loading)
    return (
      <ParsingScreen
        file={file!}
        phase={processingPhase}
        onReplace={replaceScript}
      />
    );
  if (pendingParse) {
    return (
      <ParsingScreen
        file={file!}
        title={scriptName}
        onRename={setScriptTitle}
        phase="done"
        onReplace={replaceScript}
        steps={pendingParse.steps}
        onContinue={() => continueFromParse(pendingParse)}
      />
    );
  }
  if (reviewingUpload) {
    return (
      <ParsingScreen
        file={file}
        title={scriptName}
        onRename={setScriptTitle}
        phase="done"
        onReplace={replaceScript}
        steps={steps}
        onContinue={() => setReviewingUpload(false)}
      />
    );
  }

  if (error) {
    return (
      <ParseErrorScreen
        notScript={notScript}
        tooLarge={tooLarge}
        detail={error}
        onRetry={retryParse}
        onUploadAnother={replaceScript}
      />
    );
  }

  if (languageChoice) {
    return (
      <LanguageChoiceScreen
        translationName={languageChoice.languageName}
        onRehearseTranslation={() => {
          finalizeParse(languageChoice);
          setLanguageChoice(null);
        }}
        onReadOriginal={file ? () => void rehearseOriginalLanguage() : undefined}
      />
    );
  }

  if (steps.length === 0) {
    return (
      <ParseErrorScreen
        notScript
        detail={NOT_A_SCRIPT_MESSAGE}
        onUploadAnother={replaceScript}
      />
    );
  }

  if (selectedRole === null && characters.length > 0) {
    return (
      <RolePicker
        characters={characters}
        steps={steps}
        fileName={scriptName}
        initialSelected={roleDraft}
        onChoose={chooseRole}
        onGoToStep={goToStep}
      />
    );
  }

  if (
    selectedRole !== null &&
    !voicesConfirmed &&
    voiceableSpeakers.length > 0
  ) {
    if (coaching) {
      return (
        <CoachScenePartners
          scriptName={scriptName}
          steps={steps}
          selectedRole={selectedRole}
          scriptId={scriptId}
          characterVoices={characterVoices}
          characterVolumes={characterVolumes}
          characterPaces={characterPaces}
          coachTakes={coachTakes}
          onTakeChange={(stepIndex, takeId) =>
            setCoachTakes((prev) => {
              const next = { ...prev };
              if (takeId) next[stepIndex] = takeId;
              else delete next[stepIndex];
              return next;
            })
          }
          onDone={() => setCoaching(false)}
          onGoToStep={goToStep}
        />
      );
    }
    return (
      <VoiceCasting
        scriptName={scriptName}
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
        characterEmotions={characterEmotions}
        onEmotionChange={(speaker, emotion) =>
          setCharacterEmotions((prev) => ({ ...prev, [speaker]: emotion }))
        }
        characterPaces={characterPaces}
        onPaceChange={(speaker, pace) =>
          setCharacterPaces((prev) => ({ ...prev, [speaker]: pace }))
        }
        onStart={startReading}
        onCoach={() => setCoaching(true)}
        coachedCount={
          readerLineIndices(steps, selectedRole).filter((index) => coachTakes[index]).length
        }
        languageCode={scriptLanguage.code}
        onGoToStep={goToStep}
      />
    );
  }

  return (
    <Rehearsal
      steps={steps}
      selectedRole={selectedRole ?? ""}
      characterVoices={characterVoices}
      characterVolumes={characterVolumes}
      characterEmotions={characterEmotions}
      characterPaces={characterPaces}
      coachTakes={coachTakes}
      // Pre-generation's view of the tags, so a line it rendered before a
      // late director answer plays that read instead of paying for another.
      deliveryTags={pregen.deliveryTags ?? []}
      onBack={() =>
        stepBack(() => {
          if (voiceableSpeakers.length > 0) {
            setVoicesConfirmed(false);
          } else {
            setSelectedRole(null);
          }
        })
      }
      onGoToStep={goToStep}
      languageCode={scriptLanguage.code}
      fileName={scriptName}
      scriptId={scriptId}
      scriptSaved={scriptSaved}
      pregen={pregen}
      onRecordingActiveChange={setRecordingActive}
    />
  );
}
