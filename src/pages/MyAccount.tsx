import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import SiteNav from "../components/SiteNav";
import DocumentPreview from "../components/DocumentPreview";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../lib/supabase";
import { useToast } from "../lib/toast";
import type { SavedScript } from "../types";

export default function MyAccount() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [scripts, setScripts] = useState<SavedScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const fetchedPreviewIds = useRef(new Set<string>());

  useEffect(() => {
    if (!user) return;
    let active = true;
    setLoading(true);
    supabase
      .from("scripts")
      .select("id,title,language_code,language_name,characters,steps,pdf_path,created_at")
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
    const pending = scripts.filter(
      (script) => script.pdf_path && !fetchedPreviewIds.current.has(script.id)
    );
    if (pending.length === 0) return;
    pending.forEach((script) => fetchedPreviewIds.current.add(script.id));

    let active = true;
    Promise.all(
      pending.map(async (script) => {
        const { data } = await supabase.storage
          .from("scripts")
          .createSignedUrl(script.pdf_path as string, 3600);
        return [script.id, data?.signedUrl ?? null] as const;
      })
    ).then((entries) => {
      if (!active) return;
      setPreviewUrls((prev) => {
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
  }, [scripts]);

  const practice = (script: SavedScript) => {
    navigate("/practice", {
      state: {
        replayScript: {
          title: script.title,
          steps: script.steps,
          characters: script.characters,
          languageCode: script.language_code,
          languageName: script.language_name,
        },
      },
    });
  };

  const viewPdf = async (script: SavedScript) => {
    if (!script.pdf_path) return;
    setOpeningId(script.id);
    const { data, error } = await supabase.storage
      .from("scripts")
      .createSignedUrl(script.pdf_path, 60);
    setOpeningId(null);
    if (error || !data?.signedUrl) {
      toast("Couldn't open that PDF. Please try again.");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
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
            {scripts.map((script) => (
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
                {script.pdf_path && (
                  <div className="account-script-preview">
                    {previewUrls[script.id] && (
                      <DocumentPreview src={previewUrls[script.id]} fileName={script.title} />
                    )}
                  </div>
                )}
                <div className="account-script-actions">
                  {script.pdf_path && (
                    <button
                      type="button"
                      className="account-script-secondary"
                      onClick={() => viewPdf(script)}
                      disabled={openingId === script.id}
                    >
                      {openingId === script.id ? "Opening…" : "View PDF"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="account-script-practice"
                    onClick={() => practice(script)}
                  >
                    Practice <span>→</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
