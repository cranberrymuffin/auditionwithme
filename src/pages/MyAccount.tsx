import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Seo from "../components/Seo";
import ScriptName from "../components/ScriptName";
import SiteNav from "../components/SiteNav";
import StorageMeter from "../components/StorageMeter";
import { useAuth } from "../contexts/AuthContext";
import { Share } from "@capacitor/share";
import { forgetSelfTapeUrl, getSelfTapeBlob, getSelfTapeUrl } from "../lib/selfTapeUrl";
import { IS_NATIVE } from "../lib/platform";
import {
  deleteTape as deleteTapeRecord,
  deleteTapesForScript,
  extensionForMimeType,
  getTapeFile,
  listTapes,
} from "../lib/selfTapeStore";
import {
  deleteScript as deleteScriptRecord,
  listScripts,
} from "../lib/scriptStore";
import { displayCharacterName, spokenLines } from "../lib/script";
import { useToast } from "../lib/toast";
import { useStartRehearsal } from "../hooks/useStartRehearsal";
import type { SavedScript, SelfTape } from "../types";
import { isStorageNoticeDismissed, rememberStorageNoticeDismissed } from "../lib/storageNotice";

// Tapes recorded before the per-take role field existed have none saved.
// When the script's only ever been read as one character, that's an
// unambiguous stand-in; with more than one, guessing wrong is worse than
// showing nothing.
function roleForTape(tape: SelfTape, script: SavedScript | null | undefined): string {
  if (tape.role) return tape.role;
  return script?.rolesRead.length === 1 ? script.rolesRead[0] : "";
}

export default function MyAccount() {
  const { user } = useAuth();
  const navigate = useNavigate();
  // Upload a script: the same start as Home's, straight to step 1.
  const startRehearsal = useStartRehearsal();
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const location = useLocation();
  const toast = useToast();
  const [scripts, setScripts] = useState<SavedScript[]>([]);
  const [selfTapes, setSelfTapes] = useState<SelfTape[]>([]);
  const [loading, setLoading] = useState(true);
  const [tapeUrls, setTapeUrls] = useState<Record<string, string>>({});
  const [expandedTapeId, setExpandedTapeId] = useState<string | null>(null);
  const [storageNoticeDismissed, setStorageNoticeDismissed] = useState(isStorageNoticeDismissed);
  // Which previously-read role is picked in each script's "Practice as"
  // dropdown, keyed by script id — falls back to the most recent role read.
  const [roleChoice, setRoleChoice] = useState<Record<string, string>>({});
  const fetchedTapeIds = useRef(new Set<string>());
  const scriptRowRefs = useRef(new Map<string, HTMLLIElement>());
  const consumedOpenRequestRef = useRef(false);
  // navigator.share() throws InvalidStateError if called again before an
  // earlier call resolves — a real risk here since the share sheet can take
  // a moment to animate in, inviting an impatient second tap.
  const downloadingRef = useRef(false);

  useEffect(() => {
    if (!user) return;
    let active = true;
    setLoading(true);
    listScripts(user.id)
      .then((data) => {
        if (!active) return;
        setScripts(data);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        console.error("Failed to load scripts:", err);
        setScripts([]);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    listTapes(user.id)
      .then((data) => {
        if (active) setSelfTapes(data);
      })
      .catch((err) => {
        if (!active) return;
        console.error("Failed to load self-tapes:", err);
        setSelfTapes([]);
      });
    return () => {
      active = false;
    };
  }, [user]);

  // A tape's blob (and the object URL it's read into) is only pulled out of
  // IndexedDB once something actually needs it — a visible tile
  // (IntersectionObserver, see SelfTapeTile) or the expanded modal below —
  // rather than every tape on the account loading at once.
  //
  // getSelfTapeUrl caches the object URL itself (module-level, outside this
  // component), so leaving /account and coming back reuses the same URL
  // instead of re-reading the blob and minting a new one.
  const ensureTapeUrl = useCallback((tape: SelfTape) => {
    if (fetchedTapeIds.current.has(tape.id)) return;
    fetchedTapeIds.current.add(tape.id);
    getSelfTapeUrl(tape.id).then((url) => {
      if (!url) return;
      setTapeUrls((prev) => ({ ...prev, [tape.id]: url }));
    });
  }, []);

  // Arriving straight from a just-finished audition (Rehearsal navigates
  // here with the new tape's id) opens that tape's review view immediately.
  useEffect(() => {
    const openTapeId = (location.state as { openTapeId?: string } | null)
      ?.openTapeId;
    if (!openTapeId || consumedOpenRequestRef.current) return;
    const exists = selfTapes.some((tape) => tape.id === openTapeId);
    if (!exists) return;
    consumedOpenRequestRef.current = true;
    setExpandedTapeId(openTapeId);
  }, [location.state, selfTapes]);

  // Jumps straight into Rehearsal as a role already read before, reusing its
  // saved cast — no RolePicker/VoiceCasting detour.
  const practiceAsRole = (script: SavedScript, role: string) => {
    navigate("/practice", {
      state: { replayScript: script, selectedRole: role },
    });
  };

  // Recast (or the very first practice on this script): RolePicker, then
  // VoiceCasting if there's anyone else to voice.
  const practice = (script: SavedScript) => {
    navigate("/practice", { state: { replayScript: script } });
  };

  const scrollToScript = (scriptId: string) => {
    scriptRowRefs.current
      .get(scriptId)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const closeExpanded = () => {
    const tape = selfTapes.find((item) => item.id === expandedTapeId);
    setExpandedTapeId(null);
    if (tape) scrollToScript(tape.script_id);
  };

  const deleteTape = async (tape: SelfTape) => {
    if (!window.confirm("Delete this self-tape? This can't be undone.")) return;
    try {
      await deleteTapeRecord(tape.id);
    } catch (err) {
      console.error("Failed to delete self-tape:", err);
      toast("Couldn't delete that self-tape. Please try again.");
      return;
    }
    forgetSelfTapeUrl(tape.id);
    setSelfTapes((prev) => prev.filter((item) => item.id !== tape.id));
    if (expandedTapeId === tape.id) {
      setExpandedTapeId(null);
      scrollToScript(tape.script_id);
    }
  };

  const deleteScript = async (script: SavedScript) => {
    if (
      !window.confirm(
        `Delete "${script.title}" and all its self-tapes? This can't be undone.`,
      )
    ) {
      return;
    }
    let deletedTapeIds: string[];
    try {
      deletedTapeIds = await deleteTapesForScript(script.id);
      await deleteScriptRecord(script.id);
    } catch (err) {
      console.error("Failed to delete script:", err);
      toast("Couldn't delete that audition. Please try again.");
      return;
    }
    deletedTapeIds.forEach(forgetSelfTapeUrl);
    setScripts((prev) => prev.filter((item) => item.id !== script.id));
    setSelfTapes((prev) => prev.filter((tape) => tape.script_id !== script.id));
    if (
      selfTapes.find((tape) => tape.id === expandedTapeId)?.script_id ===
      script.id
    ) {
      setExpandedTapeId(null);
    }
  };

  // iOS Safari ignores <a download> on a blob URL and instead opens its Quick
  // Look preview page, which is a confusing dead end for saving a video from
  // a PWA. The Web Share API triggers the native share sheet ("Save Video" /
  // "Save to Files") directly, which is what mobile users actually expect
  // from a download action. Gated on actual device type, not just
  // canShare() — desktop Chrome/Edge can report canShare: true for files
  // without the share actually completing, so feature detection alone
  // isn't reliable enough to trust; desktop always gets the plain download
  // regardless of what canShare() claims.
  const isMobileDevice = () =>
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  const shareOrDownloadBlob = async (blob: Blob, filename: string) => {
    const file = new File([blob], filename, { type: blob.type });
    if (isMobileDevice() && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch (shareErr) {
        if ((shareErr as Error).name !== "AbortError") throw shareErr;
      }
      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  };

  const downloadTape = async (tape: SelfTape) => {
    if (downloadingRef.current) return;
    downloadingRef.current = true;
    try {
      // The iOS app keeps a natively recorded take as a real .mp4 on the
      // phone: hand that file to the share sheet (Save Video, Save to
      // Files, AirDrop). The web view can't download at all, and reading
      // the video back into a Blob first outlasts the tap the share sheet
      // needs.
      const file = IS_NATIVE ? await getTapeFile(tape.id) : null;
      if (file) {
        try {
          await Share.share({ files: [`file://${file.path}`] });
        } catch (shareErr) {
          // Closing the sheet without picking anything isn't a failure.
          if (!/cancel/i.test((shareErr as Error).message ?? "")) throw shareErr;
        }
        return;
      }
      // getSelfTapeBlob shares its cache with ensureTapeUrl, which already
      // kicked off (and by click time, almost always finished) this same
      // lookup when the tile/modal opened — so this resolves as an
      // already-settled promise rather than a fresh IndexedDB read. That
      // matters because a fresh read is slow enough to cross into the next
      // event-loop turn, and on mobile that's long enough to burn through
      // the "recent user gesture" window navigator.share() below requires —
      // it then rejects with NotAllowedError instead of opening the share
      // sheet. Reading tapeUrls state directly isn't enough on its own: it
      // can still be unset the instant the modal opens, which silently
      // no-ops the whole thing instead of erroring.
      // The cached Blob itself, not fetch(url): re-reading a long take back
      // out of its object URL can outlast that gesture window by itself.
      const blob = await getSelfTapeBlob(tape.id);
      if (!blob) return;
      const extension = extensionForMimeType(blob.type);
      const filename = `self-tape-${tape.created_at.slice(0, 10)}.${extension}`;
      await shareOrDownloadBlob(blob, filename);
    } catch (err) {
      console.error("Failed to download self-tape:", err);
      toast("Couldn't download that self-tape. Please try again.");
    } finally {
      downloadingRef.current = false;
    }
  };

  const expandedTape =
    selfTapes.find((tape) => tape.id === expandedTapeId) ?? null;
  const expandedScript = expandedTape
    ? (scripts.find((script) => script.id === expandedTape.script_id) ?? null)
    : null;
  const expandedRole = expandedTape ? roleForTape(expandedTape, expandedScript) : "";

  // The modal can be opened directly (e.g. via location.state above) before
  // its tile has ever scrolled into view, so make sure it always has a URL.
  useEffect(() => {
    if (expandedTape) ensureTapeUrl(expandedTape);
  }, [expandedTape, ensureTapeUrl]);

  // Escape closes the take viewer — unless the feedback form is up over it,
  // which owns the keyboard until it's answered.
  const tapeCloseRef = useRef<HTMLButtonElement | null>(null);
  const closeExpandedRef = useRef(closeExpanded);
  closeExpandedRef.current = closeExpanded;
  useEffect(() => {
    if (!expandedTapeId) return;
    // Don't pull focus out of the feedback form if it's already up.
    if (!document.getElementById("feedback-gate-title")) tapeCloseRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.getElementById("feedback-gate-title")) return;
      closeExpandedRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expandedTapeId]);

  return (
    <main className="page account-page">
      <Seo
        title="My Account"
        description="Manage your saved scripts and self-tape recordings."
        path="/account"
        noindex
      />
      <SiteNav />

      <div className="wrap grid doc-layout account-layout">
        <header className="page-head doc-head account-head span-4">
          <p className="slug">On this device</p>
          <h1 className="title">My auditions</h1>
          <p className="lead">
            Your scripts and self-tapes. They’re saved on this device only,
            so download any take you want to keep.
          </p>
          {user?.email && <p className="account-email meta">{user.email}</p>}
          {scripts.length > 0 && (
            <button
              type="button"
              className="btn-primary account-upload"
              onClick={() => uploadInputRef.current?.click()}
            >
              Upload a script
            </button>
          )}
          {user && !loading && (
            <StorageMeter
              userId={user.id}
              refreshKey={`${scripts.length}:${selfTapes.length}`}
            />
          )}
        </header>
        <input
          ref={uploadInputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so picking the same file again still fires.
            event.target.value = "";
            if (file) void startRehearsal(file);
          }}
        />

        <section className="account-body span-8 at-5" aria-label="Saved scripts">
          {loading ? (
            <p className="account-loading meta">Loading your scripts…</p>
          ) : scripts.length === 0 ? (
            <div className="account-empty">
              <p className="slug">No scripts yet</p>
              <p className="account-empty-title">
                You haven’t uploaded a script on this device.
              </p>
              <p className="meta">
                Upload your sides as a PDF, pick your role, and the script and
                every take you record will be listed here.
              </p>
              <button
                type="button"
                className="btn-primary btn-lg"
                onClick={() => uploadInputRef.current?.click()}
              >
                Upload a script <span className="btn-arrow" aria-hidden="true">→</span>
              </button>
            </div>
          ) : (
            <ul className="account-scripts">
              {scripts.map((script) => {
                const defaultRole =
                  script.rolesRead[script.rolesRead.length - 1] ?? "";
                const selectedRoleForScript = roleChoice[script.id] ?? defaultRole;
                // Newest first, as listTapes returns them: a take's number
                // is its place in the order they were recorded.
                const scriptTapes = selfTapes.filter((tape) => tape.script_id === script.id);
                // Tapes with no recorded role (saved before that field existed)
                // can't be attributed to a specific read, so they stay visible
                // no matter which role is picked rather than silently vanishing.
                const tapes = scriptTapes.filter(
                  (tape) => !tape.role || tape.role === selectedRoleForScript,
                );
                const hasRole = script.rolesRead.length > 0;
                const yourLines = hasRole
                  ? spokenLines(script.steps, selectedRoleForScript).length
                  : 0;
                return (
                  <li
                    key={script.id}
                    className="script-row"
                    ref={(el) => {
                      if (el) scriptRowRefs.current.set(script.id, el);
                      else scriptRowRefs.current.delete(script.id);
                    }}
                  >
                    <div className="script-row-head">
                      <div className="script-row-id">
                        <h2 className="script-row-title">
                          <ScriptName name={script.title} />
                        </h2>
                        <p className="script-row-meta">
                          {hasRole && (
                            <span className="script-row-role">
                              {displayCharacterName(selectedRoleForScript)}
                            </span>
                          )}
                          <span>
                            {script.characters.length}{" "}
                            {script.characters.length === 1 ? "character" : "characters"}
                          </span>
                          <span>
                            {hasRole && yourLines > 0 ? `${yourLines} of ` : ""}
                            {script.steps.length} {script.steps.length === 1 ? "line" : "lines"}
                          </span>
                          <span>Added {formatDay(script.createdAt)}</span>
                        </p>
                      </div>
                    </div>
                    <div className="script-row-bar">
                      {hasRole ? (
                        <div className="script-row-rehearse">
                          <label className="script-row-role-picker">
                            <span>Rehearse as</span>
                            <select
                              className="select"
                              aria-label="Choose which role to practice as"
                              value={selectedRoleForScript}
                              onChange={(event) =>
                                setRoleChoice((prev) => ({
                                  ...prev,
                                  [script.id]: event.target.value,
                                }))
                              }
                            >
                              {script.rolesRead.map((role) => (
                                <option key={role} value={role}>
                                  {displayCharacterName(role)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => practiceAsRole(script, selectedRoleForScript)}
                          >
                            Rehearse <span className="btn-arrow" aria-hidden="true">→</span>
                          </button>
                        </div>
                      ) : (
                        <div className="script-row-rehearse">
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => practice(script)}
                          >
                            Practice <span className="btn-arrow" aria-hidden="true">→</span>
                          </button>
                        </div>
                      )}
                      <div className="script-row-manage">
                        {hasRole && (
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => practice(script)}
                          >
                            Change role or voices
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn-ghost script-row-delete"
                          onClick={() => void deleteScript(script)}
                          aria-label={`Delete "${script.title}"`}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {tapes.length > 0 && (
                      <div className="script-row-takes">
                        <p className="slug">
                          {tapes.length} {tapes.length === 1 ? "take" : "takes"}
                        </p>
                        <ul className="take-list">
                          {tapes.map((tape) => (
                            <li key={tape.id}>
                              <SelfTapeTile
                                tape={tape}
                                number={scriptTapes.length - scriptTapes.indexOf(tape)}
                                role={roleForTape(tape, script)}
                                url={tapeUrls[tape.id]}
                                ensureUrl={ensureTapeUrl}
                                onOpen={() => setExpandedTapeId(tape.id)}
                              />
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {expandedTape && (
        <div className="tape-modal-overlay" onClick={closeExpanded}>
          <div
            className="tape-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Self-tape"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="tape-modal-head">
              <div className="tape-modal-detail">
                {expandedScript && <strong>{expandedScript.title}</strong>}
                <span>
                  {expandedRole && `Reading as ${displayCharacterName(expandedRole)} · `}
                  {formatMoment(expandedTape.created_at)}
                </span>
              </div>
              <button
                ref={tapeCloseRef}
                type="button"
                className="btn-ghost tape-modal-close"
                onClick={closeExpanded}
                aria-label="Close"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
            {tapeUrls[expandedTape.id] ? (
              <video
                src={tapeUrls[expandedTape.id]}
                controls
                // A tape that still owes feedback gets its review video
                // playing inside FeedbackGate instead (mounted above this
                // modal in the stacking order) — autoplaying it here too
                // would just run silently/behind that overlay.
                autoPlay={!(expandedTape.feedback_required && !expandedTape.feedback_submitted_at)}
                playsInline
              />
            ) : (
              <div className="tape-modal-loading">Loading video…</div>
            )}
            {!storageNoticeDismissed && (
              <p className="notice notice-accent tape-modal-keep-note">
                This take is saved on this device only. Download it to keep a
                copy you can send.
              </p>
            )}
            <div className="tape-modal-actions">
              <button
                type="button"
                className="btn-primary tape-modal-download"
                onClick={() => {
                  // They know how to keep a take now: no need to say it again.
                  rememberStorageNoticeDismissed();
                  setStorageNoticeDismissed(true);
                  void downloadTape(expandedTape);
                }}
              >
                Download
              </button>
              <button
                type="button"
                className="btn-danger tape-modal-delete"
                onClick={() => void deleteTape(expandedTape)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** One take in a script's list: a still, its number, and when it was
 * recorded. It only reads its blob out of IndexedDB — and mints the object
 * URL the browser then decodes a preview frame from — once it actually
 * scrolls into view, instead of every tape on the account loading at once. */
function SelfTapeTile({
  tape,
  number,
  role,
  url,
  ensureUrl,
  onOpen,
}: {
  tape: SelfTape;
  number: number;
  role: string;
  url: string | undefined;
  ensureUrl: (tape: SelfTape) => void;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || visible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setVisible(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (visible) ensureUrl(tape);
  }, [visible, tape, ensureUrl]);

  return (
    <button
      ref={ref}
      type="button"
      className="take-row"
      onClick={onOpen}
      aria-label={`Open self-tape${role ? ` as ${displayCharacterName(role)}` : ""}, recorded ${formatMoment(tape.created_at)}`}
    >
      <span className="take-row-frame">
        {url ? (
          <video
            src={url}
            preload="metadata"
            muted
            playsInline
            onLoadedMetadata={(event) => {
              // preload="metadata" alone leaves the canvas blank in some
              // browsers; seeking forces a frame to actually decode and paint.
              const video = event.currentTarget;
              // MediaRecorder files can report Infinity until fully read.
              if (Number.isFinite(video.duration)) setDuration(video.duration);
              video.currentTime = Math.min(0.5, video.duration || 0.5);
            }}
          />
        ) : (
          <span className="take-row-loading" />
        )}
      </span>
      <span className="take-row-number">Take {String(number).padStart(2, "0")}</span>
      <span className="take-row-role">{role ? displayCharacterName(role) : ""}</span>
      <span className="take-row-date">{formatMoment(tape.created_at)}</span>
      <span className="take-row-duration">
        {duration !== null
          ? `${Math.floor(Math.round(duration) / 60)}:${String(Math.round(duration) % 60).padStart(2, "0")}`
          : ""}
      </span>
    </button>
  );
}
