import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import SiteNav from "../components/SiteNav";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../lib/supabase";
import { useToast } from "../lib/toast";
import type { SavedScript, SelfTape } from "../types";

export default function MyAccount() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [scripts, setScripts] = useState<SavedScript[]>([]);
  const [selfTapes, setSelfTapes] = useState<SelfTape[]>([]);
  const [loading, setLoading] = useState(true);
  const [tapeUrls, setTapeUrls] = useState<Record<string, string>>({});
  const fetchedTapeIds = useRef(new Set<string>());

  useEffect(() => {
    if (!user) return;
    let active = true;
    setLoading(true);
    supabase
      .from("scripts")
      .select("id,title,language_code,language_name,characters,steps,character_voices,delivery_tags,created_at")
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
    const pending = selfTapes.filter((tape) => !fetchedTapeIds.current.has(tape.id));
    if (pending.length === 0) return;
    pending.forEach((tape) => fetchedTapeIds.current.add(tape.id));

    let active = true;
    Promise.all(
      pending.map(async (tape) => {
        const { data } = await supabase.storage
          .from("self-tapes")
          .createSignedUrl(tape.storage_path, 3600);
        return [tape.id, data?.signedUrl ?? null] as const;
      })
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

  const deleteTape = async (tape: SelfTape) => {
    const { error: storageError } = await supabase.storage
      .from("self-tapes")
      .remove([tape.storage_path]);
    if (storageError) {
      console.error("Failed to delete self-tape file:", storageError.message);
      toast("Couldn't delete that self-tape. Please try again.");
      return;
    }
    const { error } = await supabase.from("self_tapes").delete().eq("id", tape.id);
    if (error) {
      console.error("Failed to delete self-tape:", error.message);
      toast("Couldn't delete that self-tape. Please try again.");
      return;
    }
    setSelfTapes((prev) => prev.filter((item) => item.id !== tape.id));
  };

  return (
    <main className="account-page">
      <SiteNav />

      <section className="account-main">
        <header className="account-header">
          <p className="eyebrow">My account</p>
          <h1>Your scripts</h1>
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
              const tapes = selfTapes.filter((tape) => tape.script_id === script.id);
              return (
                <li key={script.id} className="account-script-row">
                  <div className="account-script-info">
                    <strong>{script.title}</strong>
                    <span>
                      {script.characters.length} {script.characters.length === 1 ? "character" : "characters"}
                      {" · "}
                      {new Date(script.created_at).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                  {tapes.length > 0 && (
                    <ul className="account-self-tapes">
                      {tapes.map((tape) => (
                        <li key={tape.id}>
                          {tapeUrls[tape.id] && (
                            <video controls src={tapeUrls[tape.id]} />
                          )}
                          <div>
                            <span>
                              {new Date(tape.created_at).toLocaleString(undefined, {
                                month: "short",
                                day: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                              })}
                            </span>
                            <button
                              type="button"
                              className="account-script-secondary"
                              onClick={() => deleteTape(tape)}
                            >
                              Delete
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="account-script-actions">
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
    </main>
  );
}
