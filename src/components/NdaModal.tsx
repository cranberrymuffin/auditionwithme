import { useEffect, useState } from "react";
import Modal from "./Modal";
import { NDA_PARAGRAPHS, NDA_TITLE } from "../lib/ndaText";

type Props = {
  submitting: boolean;
  onCancel: () => void;
  onAccept: () => void;
};

// Shown right before account creation (see Signup.tsx) so acceptance is
// captured in the same step as signup, not as a separate gate after the
// fact. The RLS policies in
// supabase/migrations/20260916120000_nda_acceptance.sql are what actually
// enforce this -- this modal is just the UI path to set it.
export default function NdaModal({ submitting, onCancel, onAccept }: Props) {
  const [agreed, setAgreed] = useState(false);
  // A plain-text copy the tester can keep, built once per open.
  const [copyUrl, setCopyUrl] = useState("");
  useEffect(() => {
    const text = `${NDA_TITLE}\n\n${NDA_PARAGRAPHS.join("\n\n")}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    setCopyUrl(url);
    return () => URL.revokeObjectURL(url);
  }, []);

  return (
    <Modal onClose={onCancel} labelledBy="nda-modal-title" className="nda-modal">
      <h2 id="nda-modal-title" className="modal-title">
        {NDA_TITLE}
      </h2>
      <p className="nda-modal-intro">
        Please read this before creating your account.{" "}
        {copyUrl && (
          <a href={copyUrl} download="AuditionWithMe-Beta-NDA.txt">
            Download a copy
          </a>
        )}
      </p>
      <div className="nda-modal-body" tabIndex={0} aria-label="Agreement text">
        {NDA_PARAGRAPHS.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
      <label className="nda-modal-agree">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
          data-autofocus
        />
        <span>I’ve read the agreement and agree to its terms.</span>
      </label>
      <div className="nda-modal-actions">
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="button" onClick={onAccept} disabled={submitting || !agreed}>
          {submitting ? "Creating account…" : "Accept and create account"}
        </button>
      </div>
    </Modal>
  );
}
