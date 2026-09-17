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
  return (
    <Modal onClose={onCancel} labelledBy="nda-modal-title">
      <h2 id="nda-modal-title" className="modal-title">
        {NDA_TITLE}
      </h2>
      <div className="nda-modal-body">
        {NDA_PARAGRAPHS.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
      <div className="nda-modal-actions">
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="button" onClick={onAccept} disabled={submitting}>
          {submitting ? "Creating account…" : "Accept and create account"}
        </button>
      </div>
    </Modal>
  );
}
