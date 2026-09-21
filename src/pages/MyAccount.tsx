import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import { useAuth } from "../contexts/AuthContext";
import { forgetSelfTapeUrl, getSelfTapeUrl } from "../lib/selfTapeUrl";
import {
  deleteTape as deleteTapeRecord,
  deleteTapesForScript,
  extensionForMimeType,
  listTapes,
} from "../lib/selfTapeStore";
import {
  deleteScript as deleteScriptRecord,
  listScripts,
} from "../lib/scriptStore";
import { displayCharacterName } from "../lib/script";
import { useToast } from "../lib/toast";
import type { SavedScript, SelfTape } from "../types";

// Tapes recorded before the per-take role field existed have none saved.
// When the script's only ever been read as one character, that's an
// unambiguous stand-in; with more than one, guessing wrong is worse than
// showing nothing.
function roleForTape(tape: SelfTape, script: SavedScript | null | undefined): string {
  if (tape.role) return tape.role;
  return script?.roles_read.length === 1 ? script.roles_read[0] : "";
}

export default function MyAccount() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [scripts, setScripts] = useState<SavedScript[]>([]);
  const [selfTapes, setSelfTapes] = useState<SelfTape[]>([]);
  const [loading, setLoading] = useState(true);
  const [tapeUrls, setTapeUrls] = useState<Record<string, string>>({});
  const [expandedTapeId, setExpandedTapeId] = useState<string | null>(null);
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

  const replayScriptFor = (script: SavedScript) => ({
    id: script.id,
    title: script.title,
    steps: script.steps,
    characters: script.characters,
    languageCode: script.language_code,
    languageName: script.language_name,
    characterVoices: script.character_voices,
    deliveryTags: script.delivery_tags,
    rolesRead: script.roles_read,
  });

  // Jumps straight into Rehearsal as a role already read before, reusing its
  // saved cast — no RolePicker/VoiceCasting detour.
  const practiceAsRole = (script: SavedScript, role: string) => {
    navigate("/practice", {
      state: { replayScript: replayScriptFor(script), selectedRole: role },
    });
  };

  // Recast (or the very first practice on this script): RolePicker, then
  // VoiceCasting if there's anyone else to voice.
  const practice = (script: SavedScript) => {
    navigate("/practice", { state: { replayScript: replayScriptFor(script) } });
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
      // getSelfTapeUrl shares its cache with ensureTapeUrl, which already
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
      const url = await getSelfTapeUrl(tape.id);
      if (!url) return;
      const response = await fetch(url);
      const blob = await response.blob();
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

  return (
    <main className="account-page">
      <Seo
        title="My Account"
        description="Manage your saved scripts and self-tape recordings."
        path="/account"
        noindex
      />
      <SiteNav />

      <section className="account-main">
        <header className="account-header">
          <h1>My Auditions</h1>
          {user?.email && <p className="account-email">{user.email}</p>}
          <p className="account-subtitle">
            Scripts you've uploaded on this device before. Jump back into
            practice now!
          </p>
        </header>

        {loading ? (
          <p className="account-empty">Loading your scripts…</p>
        ) : scripts.length === 0 ? (
          <div className="account-empty">
            <p>You haven't uploaded a script on this device.</p>
            <button type="button" onClick={() => navigate("/")}>
              Upload a script <span>→</span>
            </button>
          </div>
        ) : (
          <ul className="account-scripts">
            {scripts.map((script) => {
              const defaultRole =
                script.roles_read[script.roles_read.length - 1] ?? "";
              const selectedRoleForScript = roleChoice[script.id] ?? defaultRole;
              // Tapes with no recorded role (saved before that field existed)
              // can't be attributed to a specific read, so they stay visible
              // no matter which role is picked rather than silently vanishing.
              const tapes = selfTapes.filter(
                (tape) =>
                  tape.script_id === script.id &&
                  (!tape.role || tape.role === selectedRoleForScript),
              );
              return (
                <li
                  key={script.id}
                  className="account-script-row"
                  ref={(el) => {
                    if (el) scriptRowRefs.current.set(script.id, el);
                    else scriptRowRefs.current.delete(script.id);
                  }}
                >
                  <div className="account-script-header">
                    <strong className="account-script-title">{script.title}</strong>
                    <div className="account-script-corner">
                      <button
                        type="button"
                        className={
                          script.roles_read.length > 0
                            ? "account-script-btn account-script-btn--outline"
                            : "account-script-btn account-script-btn--solid"
                        }
                        onClick={() => practice(script)}
                      >
                        {script.roles_read.length > 0 ? "Recast" : "Practice →"}
                      </button>
                      <button
                        type="button"
                        className="account-script-btn account-script-btn--danger"
                        onClick={() => void deleteScript(script)}
                        aria-label={`Delete "${script.title}"`}
                        title="Delete"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <span className="account-script-subtitle">
                    {script.characters.length}{" "}
                    {script.characters.length === 1 ? "character" : "characters"}
                  </span>
                  {script.roles_read.length > 0 && (
                    <div className="account-script-actions">
                      <label className="account-script-role-picker">
                        <span>Read as</span>
                        <select
                          aria-label="Choose which role to practice as"
                          value={selectedRoleForScript}
                          onChange={(event) =>
                            setRoleChoice((prev) => ({
                              ...prev,
                              [script.id]: event.target.value,
                            }))
                          }
                        >
                          {script.roles_read.map((role) => (
                            <option key={role} value={role}>
                              {displayCharacterName(role)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="account-script-btn account-script-btn--solid"
                        onClick={() => practiceAsRole(script, selectedRoleForScript)}
                      >
                        Go →
                      </button>
                    </div>
                  )}
                  {tapes.length > 0 && (
                    <ul className="account-self-tapes">
                      {tapes.map((tape) => (
                        <li key={tape.id}>
                          <SelfTapeTile
                            tape={tape}
                            role={roleForTape(tape, script)}
                            url={tapeUrls[tape.id]}
                            ensureUrl={ensureTapeUrl}
                            onOpen={() => setExpandedTapeId(tape.id)}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {expandedTape && (
        <div className="tape-modal-overlay" onClick={closeExpanded}>
          <div
            className="tape-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="tape-modal-close"
              onClick={closeExpanded}
              aria-label="Close"
            >
              ✕
            </button>
            <div className="tape-modal-detail">
              {expandedScript && <strong>{expandedScript.title}</strong>}
              <span>
                {expandedRole && `Reading as ${displayCharacterName(expandedRole)} · `}
                {new Date(expandedTape.created_at).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </div>
            {tapeUrls[expandedTape.id] ? (
              <video
                src={tapeUrls[expandedTape.id]}
                controls
                // A tape that still owes feedback gets its review video
                // playing inside FeedbackGate instead (mounted above this
                // modal, z-index 200 vs. 60) — autoplaying it here too would
                // just run silently/behind that overlay.
                autoPlay={!(expandedTape.feedback_required && !expandedTape.feedback_submitted_at)}
                playsInline
              />
            ) : (
              <div className="tape-modal-loading">Loading video…</div>
            )}
            <div className="tape-modal-actions">
              <button
                type="button"
                onClick={() => void downloadTape(expandedTape)}
              >
                Download
              </button>
              <button
                type="button"
                className="tape-modal-delete"
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

/** A self-tape thumbnail that only reads its blob out of IndexedDB — and
 * mints the object URL the browser then decodes a preview frame from — once
 * it actually scrolls into view, instead of every tape on the account
 * loading at once. */
function SelfTapeTile({
  tape,
  role,
  url,
  ensureUrl,
  onOpen,
}: {
  tape: SelfTape;
  role: string;
  url: string | undefined;
  ensureUrl: (tape: SelfTape) => void;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);

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
      className="account-tape-tile"
      onClick={onOpen}
      aria-label="Open self-tape"
    >
      <span className="account-tape-tile-frame">
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
              video.currentTime = Math.min(0.5, video.duration || 0.5);
            }}
          />
        ) : (
          <span className="account-tape-tile-loading" />
        )}
        <span className="account-tape-tile-play" aria-hidden="true">
          ▶
        </span>
        {role && (
          <span className="account-tape-tile-role">
            <span className="account-tape-tile-role-dot" aria-hidden="true" />
            {displayCharacterName(role)}
          </span>
        )}
      </span>
      <span className="account-tape-tile-date">
        {new Date(tape.created_at).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </span>
    </button>
  );
}
