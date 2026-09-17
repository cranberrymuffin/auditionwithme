import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../lib/supabase";
import { forgetSelfTapeUrl, getSelfTapeUrl } from "../lib/selfTapeUrl";
import {
  getPendingTapeBlob,
  listPendingTapes,
  removePendingTape,
  type PendingSelfTape,
} from "../lib/selfTapeStore";
import { onTapeUploadSettled, retryPendingTapes } from "../lib/selfTapeUpload";
import { useToast } from "../lib/toast";
import type { SavedScript, SelfTape } from "../types";

type StagedTape = PendingSelfTape & { blobUrl: string };

export default function MyAccount() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [scripts, setScripts] = useState<SavedScript[]>([]);
  const [selfTapes, setSelfTapes] = useState<SelfTape[]>([]);
  const [pendingTapes, setPendingTapes] = useState<StagedTape[]>([]);
  const [loading, setLoading] = useState(true);
  const [tapeUrls, setTapeUrls] = useState<Record<string, string>>({});
  const [expandedTapeId, setExpandedTapeId] = useState<string | null>(null);
  const fetchedTapeIds = useRef(new Set<string>());
  const scriptRowRefs = useRef(new Map<string, HTMLLIElement>());
  const consumedOpenRequestRef = useRef(false);

  useEffect(() => {
    if (!user) return;
    let active = true;
    setLoading(true);
    supabase
      .from("scripts")
      .select(
        "id,title,language_code,language_name,characters,steps,character_voices,delivery_tags,created_at",
      )
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (!active) return;
        if (error) console.error("Failed to load scripts:", error.message);
        setScripts(error ? [] : (data as SavedScript[]));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    supabase
      .from("self_tapes")
      .select("id,script_id,storage_path,created_at")
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (!active) return;
        if (error) console.error("Failed to load self-tapes:", error.message);
        setSelfTapes(error ? [] : (data as SelfTape[]));
      });
    return () => {
      active = false;
    };
  }, [user]);

  // Takes that finished recording but hadn't confirmed their account upload
  // yet (still local-only, or the tab closed mid-upload last time) — staged
  // in IndexedDB by useSelfTapeSession so Rehearsal never has to block on
  // the network. Shown as "Uploading…" tiles below, playable straight from
  // the local blob in the meantime.
  useEffect(() => {
    if (!user) return;
    let active = true;
    void retryPendingTapes(user.id);
    listPendingTapes(user.id)
      .then(async (metas) => {
        if (!active) return;
        const staged = await Promise.all(
          metas.map(async (meta) => {
            const blob = await getPendingTapeBlob(meta.id);
            return blob ? { ...meta, blobUrl: URL.createObjectURL(blob) } : null;
          }),
        );
        if (active) setPendingTapes(staged.filter((tape): tape is StagedTape => tape !== null));
      })
      .catch((err) => console.error("Failed to load staged self-tapes:", err));
    return () => {
      active = false;
    };
  }, [user]);

  // A background upload settling (from this tab's own session, or a retry
  // pass) drops the tile from "Uploading…" into the real, saved list — or
  // leaves it staged for the next retry on failure.
  useEffect(() => {
    if (!user) return;
    return onTapeUploadSettled((id, outcome) => {
      setPendingTapes((prev) => {
        const tape = prev.find((item) => item.id === id);
        if (tape) URL.revokeObjectURL(tape.blobUrl);
        return prev.filter((item) => item.id !== id);
      });
      if (outcome === "uploaded") {
        supabase
          .from("self_tapes")
          .select("id,script_id,storage_path,created_at")
          .eq("id", id)
          .single()
          .then(({ data, error }) => {
            if (error || !data) return;
            setSelfTapes((prev) => [data as SelfTape, ...prev]);
          });
      }
    });
  }, [user]);

  // Retry any takes still staged (failed upload, or offline) once the
  // connection comes back, instead of waiting for the next full page load.
  useEffect(() => {
    if (!user) return;
    const onOnline = () => void retryPendingTapes(user.id);
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [user]);

  // Revoke any still-staged blob URLs on unmount — one created per pending
  // tile above, otherwise leaked for the life of the tab.
  useEffect(() => {
    return () => {
      setPendingTapes((prev) => {
        prev.forEach((tape) => URL.revokeObjectURL(tape.blobUrl));
        return prev;
      });
    };
  }, []);

  // Signed URLs (and the video bytes a tile's preview then pulls) are only
  // fetched for a tape once something actually needs it — a visible tile
  // (IntersectionObserver, see SelfTapeTile) or the expanded modal below.
  // Fetching every tape's URL/video up front here used to run on every
  // /account visit regardless of how many tapes were on screen, which is
  // what blew through Supabase's storage egress quota.
  //
  // getSelfTapeUrl caches the signed URL itself (module-level, outside this
  // component), so leaving /account and coming back reuses the same URL —
  // and the browser serves the video from its own HTTP cache — instead of
  // minting a new token and downloading the file again.
  const ensureTapeUrl = useCallback((tape: SelfTape) => {
    if (fetchedTapeIds.current.has(tape.id)) return;
    fetchedTapeIds.current.add(tape.id);
    getSelfTapeUrl(tape.storage_path).then((url) => {
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
    const exists =
      selfTapes.some((tape) => tape.id === openTapeId) ||
      pendingTapes.some((tape) => tape.id === openTapeId);
    if (!exists) return;
    consumedOpenRequestRef.current = true;
    setExpandedTapeId(openTapeId);
  }, [location.state, selfTapes, pendingTapes]);

  const practice = (script: SavedScript) => {
    navigate("/practice", {
      state: {
        replayScript: {
          id: script.id,
          title: script.title,
          steps: script.steps,
          characters: script.characters,
          languageCode: script.language_code,
          languageName: script.language_name,
          characterVoices: script.character_voices,
          deliveryTags: script.delivery_tags,
        },
      },
    });
  };

  const scrollToScript = (scriptId: string) => {
    scriptRowRefs.current
      .get(scriptId)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const closeExpanded = () => {
    const tape = selfTapes.find((item) => item.id === expandedTapeId);
    const pendingTape = pendingTapes.find((item) => item.id === expandedTapeId);
    setExpandedTapeId(null);
    if (tape) scrollToScript(tape.script_id);
    else if (pendingTape) scrollToScript(pendingTape.scriptId);
  };

  const deleteTape = async (tape: SelfTape) => {
    const { error: storageError } = await supabase.storage
      .from("self-tapes")
      .remove([tape.storage_path]);
    if (storageError) {
      console.error("Failed to delete self-tape file:", storageError.message);
      toast("Couldn't delete that self-tape. Please try again.");
      return;
    }
    const { error } = await supabase
      .from("self_tapes")
      .delete()
      .eq("id", tape.id);
    if (error) {
      console.error("Failed to delete self-tape:", error.message);
      toast("Couldn't delete that self-tape. Please try again.");
      return;
    }
    forgetSelfTapeUrl(tape.storage_path);
    setSelfTapes((prev) => prev.filter((item) => item.id !== tape.id));
    if (expandedTapeId === tape.id) {
      setExpandedTapeId(null);
      scrollToScript(tape.script_id);
    }
  };

  const deletePendingTape = async (tape: StagedTape) => {
    try {
      await removePendingTape(tape.id);
    } catch (err) {
      console.error("Failed to delete staged self-tape:", err);
      toast("Couldn't delete that self-tape. Please try again.");
      return;
    }
    URL.revokeObjectURL(tape.blobUrl);
    setPendingTapes((prev) => prev.filter((item) => item.id !== tape.id));
    if (expandedTapeId === tape.id) {
      setExpandedTapeId(null);
      scrollToScript(tape.scriptId);
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
    const paths = selfTapes
      .filter((tape) => tape.script_id === script.id)
      .map((tape) => tape.storage_path);
    if (paths.length > 0) {
      const { error: storageError } = await supabase.storage
        .from("self-tapes")
        .remove(paths);
      if (storageError) {
        console.error(
          "Failed to delete self-tape files:",
          storageError.message,
        );
        toast("Couldn't delete that audition. Please try again.");
        return;
      }
    }
    // Cascades to the script's self_tapes rows in the database automatically.
    const { error } = await supabase
      .from("scripts")
      .delete()
      .eq("id", script.id);
    if (error) {
      console.error("Failed to delete script:", error.message);
      toast("Couldn't delete that audition. Please try again.");
      return;
    }
    paths.forEach(forgetSelfTapeUrl);
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
  // from a download action. Desktop browsers (Chrome/Edge on Windows/macOS)
  // also implement navigator.share, but a share sheet there is unexpected —
  // desktop users just want the file saved directly.
  const shareOrDownloadBlob = async (blob: Blob, filename: string) => {
    const file = new File([blob], filename, { type: blob.type });
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile && navigator.canShare?.({ files: [file] })) {
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
    const url = tapeUrls[tape.id];
    if (!url) return;
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      // Extension must match what was actually recorded (mp4 on Safari,
      // webm elsewhere) — storage_path already carries the right one.
      const extension = tape.storage_path.split(".").pop() ?? "webm";
      const filename = `self-tape-${tape.created_at.slice(0, 10)}.${extension}`;
      await shareOrDownloadBlob(blob, filename);
    } catch (err) {
      console.error("Failed to download self-tape:", err);
      toast("Couldn't download that self-tape. Please try again.");
    }
  };

  const downloadPendingTape = async (tape: StagedTape) => {
    try {
      const blob = await getPendingTapeBlob(tape.id);
      if (!blob) return;
      const filename = `self-tape-${tape.createdAt.slice(0, 10)}.${tape.extension}`;
      await shareOrDownloadBlob(blob, filename);
    } catch (err) {
      console.error("Failed to download self-tape:", err);
      toast("Couldn't download that self-tape. Please try again.");
    }
  };

  const expandedTape =
    selfTapes.find((tape) => tape.id === expandedTapeId) ?? null;
  const expandedPendingTape =
    pendingTapes.find((tape) => tape.id === expandedTapeId) ?? null;

  // The modal can be opened directly (e.g. via location.state above) before
  // its tile has ever scrolled into view, so make sure it always has a URL.
  // Pending tapes already have their blob URL — nothing to fetch.
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
            Scripts you've uploaded before. Jump back into practice without
            re-processing the script.
          </p>
        </header>

        {loading ? (
          <p className="account-empty">Loading your scripts…</p>
        ) : scripts.length === 0 ? (
          <div className="account-empty">
            <p>You haven't uploaded a script yet.</p>
            <button type="button" onClick={() => navigate("/")}>
              Upload a script <span>→</span>
            </button>
          </div>
        ) : (
          <ul className="account-scripts">
            {scripts.map((script) => {
              const tapes = selfTapes.filter(
                (tape) => tape.script_id === script.id,
              );
              const pendingForScript = pendingTapes.filter(
                (tape) => tape.scriptId === script.id,
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
                  <div className="account-script-info">
                    <strong>{script.title}</strong>
                    <span>
                      {script.characters.length}{" "}
                      {script.characters.length === 1
                        ? "character"
                        : "characters"}
                      {" · "}
                      {new Date(script.created_at).toLocaleDateString(
                        undefined,
                        {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        },
                      )}
                    </span>
                  </div>
                  {(tapes.length > 0 || pendingForScript.length > 0) && (
                    <ul className="account-self-tapes">
                      {pendingForScript.map((tape) => (
                        <li key={tape.id}>
                          <PendingSelfTapeTile
                            tape={tape}
                            onOpen={() => setExpandedTapeId(tape.id)}
                          />
                        </li>
                      ))}
                      {tapes.map((tape) => (
                        <li key={tape.id}>
                          <SelfTapeTile
                            tape={tape}
                            url={tapeUrls[tape.id]}
                            ensureUrl={ensureTapeUrl}
                            onOpen={() => setExpandedTapeId(tape.id)}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="account-script-actions">
                    <button
                      type="button"
                      className="account-script-secondary"
                      onClick={() => void deleteScript(script)}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      className="account-script-practice"
                      onClick={() => practice(script)}
                    >
                      Practice <span>→</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {(expandedTape || expandedPendingTape) && (
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
            {expandedPendingTape ? (
              <video src={expandedPendingTape.blobUrl} controls autoPlay playsInline />
            ) : tapeUrls[expandedTape!.id] ? (
              <video
                src={tapeUrls[expandedTape!.id]}
                controls
                autoPlay
                playsInline
              />
            ) : (
              <div className="tape-modal-loading">Loading video…</div>
            )}
            {expandedPendingTape && (
              <p className="tape-modal-pending-note">Saving to your account…</p>
            )}
            <div className="tape-modal-actions">
              <button
                type="button"
                onClick={() =>
                  expandedPendingTape
                    ? void downloadPendingTape(expandedPendingTape)
                    : void downloadTape(expandedTape!)
                }
              >
                Download
              </button>
              <button
                type="button"
                className="tape-modal-delete"
                onClick={() =>
                  expandedPendingTape
                    ? void deletePendingTape(expandedPendingTape)
                    : void deleteTape(expandedTape!)
                }
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

/** A self-tape thumbnail that only requests its signed URL — and the video
 * bytes the browser then pulls to paint a preview frame — once it actually
 * scrolls into view, instead of every tape on the account loading at once. */
function SelfTapeTile({
  tape,
  url,
  ensureUrl,
  onOpen,
}: {
  tape: SelfTape;
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

/** A self-tape that's finished recording and is staged locally (IndexedDB)
 * but hasn't confirmed its account upload yet — played back straight from
 * that local blob, no network round trip needed. */
function PendingSelfTapeTile({
  tape,
  onOpen,
}: {
  tape: StagedTape;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="account-tape-tile account-tape-tile-pending"
      onClick={onOpen}
      aria-label="Self-tape uploading"
    >
      <span className="account-tape-tile-frame">
        <video
          src={tape.blobUrl}
          preload="metadata"
          muted
          playsInline
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            video.currentTime = Math.min(0.5, video.duration || 0.5);
          }}
        />
        <span className="account-tape-tile-play" aria-hidden="true">
          ⏳
        </span>
      </span>
      <span className="account-tape-tile-date">Uploading…</span>
    </button>
  );
}
