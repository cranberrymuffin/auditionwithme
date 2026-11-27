import { Link } from "react-router-dom";

// Keep this summary consistent with the full material-handling answers in Faq.tsx.
export default function DataLedger() {
  return (
    <div className="ledger">
      <section>
        <h3>Stored on your device</h3>
        <p>
          Your scripts and self-tape videos are saved locally, not in our database.
          {" "}<strong>Your self-tape videos never leave your device.</strong>
        </p>
      </section>
      <section>
        <h3>Processed for your rehearsal</h3>
        <p>
          We use Anthropic and ElevenLabs to read scripts, bring scene partners to
          life and follow your performance. We don’t retain copies of the scripts
          or audio sent for processing. Our providers have their own data retention
          policies.
        </p>
      </section>
      <section>
        <h3>What we keep</h3>
        <p>
          Account information, subscription details and feedback you choose to share.
        </p>
      </section>
      <p className="ledger-more">
        <Link className="link" to="/faq#your-script">
          Learn more about how we handle your material <span aria-hidden="true">↗</span>
        </Link>
      </p>
    </div>
  );
}
