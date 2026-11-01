import { useState } from "react";
import Modal from "./Modal";
import TermsContent from "./TermsContent";
import { TERMS_TITLE } from "../lib/termsText";

type Props = {
  submitting: boolean;
  acceptLabel: string;
  submittingLabel: string;
  onCancel: () => void;
  onAccept: () => void;
};

// Shown outside beta testing before account creation (Signup.tsx) and
// before checkout (Pricing.tsx) for anyone who hasn't accepted the current
// TERMS_VERSION. The second checkbox is the Terms' "consent to
// auto-renewal" button. api/billing.ts refuses to start a subscription
// until both are recorded, so this modal is only the UI path to them.
export default function TermsModal({
  submitting,
  acceptLabel,
  submittingLabel,
  onCancel,
  onAccept,
}: Props) {
  const [agreed, setAgreed] = useState(false);
  const [autoRenew, setAutoRenew] = useState(false);

  return (
    <Modal onClose={onCancel} labelledBy="terms-modal-title" className="nda-modal">
      <h2 id="terms-modal-title" className="modal-title">
        {TERMS_TITLE}
      </h2>
      <p className="nda-modal-intro">
        Please read these before you continue.{" "}
        <a href="/terms" target="_blank" rel="noopener">
          Open in a new tab
        </a>
      </p>
      <div className="nda-modal-body terms-body" tabIndex={0} aria-label="Terms text">
        <TermsContent />
      </div>
      <label className="nda-modal-agree">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
          data-autofocus
        />
        <span>I’ve read the Terms and Conditions and agree to them.</span>
      </label>
      <label className="nda-modal-agree">
        <input
          type="checkbox"
          checked={autoRenew}
          onChange={(event) => setAutoRenew(event.target.checked)}
        />
        <span>
          I consent to my subscription renewing automatically each month until I
          cancel.
        </span>
      </label>
      <div className="nda-modal-actions">
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          type="button"
          onClick={onAccept}
          disabled={submitting || !agreed || !autoRenew}
        >
          {submitting ? submittingLabel : acceptLabel}
        </button>
      </div>
    </Modal>
  );
}
