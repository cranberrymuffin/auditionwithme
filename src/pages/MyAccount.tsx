import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import SiteNav from "../components/SiteNav";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../lib/supabase";
import { useToast } from "../lib/toast";
import type { SavedScript, SelfTape } from "../types";

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

  useEffect(() => {
    const pending = selfTapes.filter(
      (tape) => !fetchedTapeIds.current.has(tape.id),
    );
    if (pending.length === 0) return;
    pending.forEach((tape) => fetchedTapeIds.current.add(tape.id));

    let active = true;
    Promise.all(
      pending.map(async (tape) => {
        const { data } = await supabase.storage
          .from("self-tapes")
          .createSignedUrl(tape.storage_path, 3600);
        return [tape.id, data?.signedUrl ?? null] as const;
      }),
    ).then((entries) => {
      if (!active) return;
      setTapeUrls((prev) => {
        const next = { ...prev };
        for (const [id, url] of entries) {
          if (url) next[id] = url;
        }
        return next;
      });
    });
    return () => {
      active = false;
    };
  }, [selfTapes]);

  // Arriving straight from a just-finished audition (Rehearsal navigates
  // here with the new tape's id) opens that tape's review view immediately.
  useEffect(() => {
    const openTapeId = (location.state as { openTapeId?: string } | null)
      ?.openTapeId;
    if (!openTapeId || consumedOpenRequestRef.current) return;
    if (!selfTapes.some((tape) => tape.id === openTapeId)) return;
    consumedOpenRequestRef.current = true;
    setExpandedTapeId(openTapeId);
  }, [location.state, selfTapes]);

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
    setExpandedTapeId(null);
    if (tape) scrollToScript(tape.script_id);
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
    setScripts((prev) => prev.filter((item) => item.id !== script.id));
    setSelfTapes((prev) => prev.filter((tape) => tape.script_id !== script.id));
    if (
      selfTapes.find((tape) => tape.id === expandedTapeId)?.script_id ===
      script.id
    ) {
      setExpandedTapeId(null);
    }
  };

  const downloadTape = async (tape: SelfTape) => {
    const url = tapeUrls[tape.id];
    if (!url) return;
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `self-tape-${tape.created_at.slice(0, 10)}.webm`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      console.error("Failed to download self-tape:", err);
      toast("Couldn't download that self-tape. Please try again.");
    }
  };

  const expandedTape =
    selfTapes.find((tape) => tape.id === expandedTapeId) ?? null;

  return (
    <main className="account-page">
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
                  {tapes.length > 0 && (
                    <ul className="account-self-tapes">
                      {tapes.map((tape) => (
                        <li key={tape.id}>
                          <button
                            type="button"
                            className="account-tape-tile"
                            onClick={() => setExpandedTapeId(tape.id)}
                            aria-label="Open self-tape"
                          >
                            <span className="account-tape-tile-frame">
                              {tapeUrls[tape.id] ? (
                                <video
                                  src={tapeUrls[tape.id]}
                                  preload="metadata"
                                  muted
                                  playsInline
                                  onLoadedMetadata={(event) => {
                                    // preload="metadata" alone leaves the canvas
                                    // blank in some browsers; seeking forces a
                                    // frame to actually decode and paint.
                                    const video = event.currentTarget;
                                    video.currentTime = Math.min(
                                      0.5,
                                      video.duration || 0.5,
                                    );
                                  }}
                                />
                              ) : (
                                <span className="account-tape-tile-loading" />
                              )}
                              <span
                                className="account-tape-tile-play"
                                aria-hidden="true"
                              >
                                ▶
                              </span>
                            </span>
                            <span className="account-tape-tile-date">
                              {new Date(tape.created_at).toLocaleString(
                                undefined,
                                {
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                },
                              )}
                            </span>
                          </button>
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
            {tapeUrls[expandedTape.id] ? (
              <video src={tapeUrls[expandedTape.id]} controls autoPlay />
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
