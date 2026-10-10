import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import Modal from "../components/Modal";
import PasswordField from "../components/PasswordField";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../lib/supabase";
import { apiFetch } from "../lib/api";
import { friendlyAuthError } from "../lib/authErrors";
import { useToast } from "../lib/toast";
import { deleteScript, listScripts } from "../lib/scriptStore";
import { deleteTape, listTapes } from "../lib/selfTapeStore";
import { forgetSelfTapeUrl } from "../lib/selfTapeUrl";

// Changing the email or password re-checks the current password first, the
// same way the login form does, so a session someone left open on a shared
// device can't be used to take the account over.
async function verifyPassword(email: string, password: string): Promise<string | null> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (!error) return null;
  return error.code === "invalid_credentials"
    ? "That’s not your current password."
    : friendlyAuthError(error, "log in");
}

/** Clears everything this user saved on this device (IndexedDB), leaving any
 * other account's scripts on the same browser alone. deleteScript also takes
 * each script's stored reader audio and PDF with it. */
async function deleteLocalData(userId: string) {
  const [scripts, tapes] = await Promise.all([listScripts(userId), listTapes(userId)]);
  await Promise.all(
    tapes.map(async (tape) => {
      await deleteTape(tape.id);
      forgetSelfTapeUrl(tape.id);
    }),
  );
  await Promise.all(scripts.map((script) => deleteScript(script.id)));
}

export default function AccountSettings() {
  const { user } = useAuth();
  const email = user?.email ?? "";
  // Set while an email change waits on its confirmation link(s).
  const pendingEmail = user?.new_email ?? null;

  return (
    <main className="account-page">
      <Seo
        title="Account Settings"
        description="Change your email or password, or delete your account."
        path="/account/settings"
        noindex
      />
      <SiteNav />

      <section className="account-main">
        <header className="account-header">
          <h1>Account settings</h1>
          {email && <p className="account-email">{email}</p>}
        </header>

        <div className="settings-sections">
          <ChangeEmail email={email} pendingEmail={pendingEmail} />
          <ChangePassword email={email} />
          <DeleteAccount email={email} userId={user?.id ?? ""} />
        </div>
      </section>
    </main>
  );
}

function ChangeEmail({ email, pendingEmail }: { email: string; pendingEmail: string | null }) {
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The confirmation links land back here. Supabase reports a half-finished
  // change (one of two links clicked) or a bad link in the URL hash.
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const message = params.get("message");
    const linkError = params.get("error_description");
    if (!message && !linkError) return;
    if (message) setNotice(message);
    if (linkError) setError(linkError);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const target = newEmail.trim();
    if (target.toLowerCase() === email.toLowerCase()) {
      setError("That’s already your email.");
      return;
    }
    setSubmitting(true);
    const passwordError = await verifyPassword(email, password);
    if (passwordError) {
      setSubmitting(false);
      setError(passwordError);
      return;
    }
    const { error: updateError } = await supabase.auth.updateUser(
      { email: target },
      { emailRedirectTo: `${window.location.origin}/account/settings` },
    );
    setSubmitting(false);
    if (updateError) {
      setError(friendlyAuthError(updateError, "change email"));
      return;
    }
    setNewEmail("");
    setPassword("");
    setNotice(
      `Check ${target} for a confirmation link. Your email stays ${email} until you open it — we may also send a link to ${email} to confirm the change from there.`,
    );
  }

  return (
    <form className="auth-card settings-card" onSubmit={handleSubmit}>
      <header>
        <h2>Email</h2>
        <p className="settings-copy">
          You log in with <strong>{email}</strong>.
        </p>
        {pendingEmail && (
          <p className="settings-copy">
            Waiting on confirmation to switch to <strong>{pendingEmail}</strong>.
          </p>
        )}
      </header>
      <label htmlFor="settings-new-email">New email</label>
      <input
        id="settings-new-email"
        type="email"
        value={newEmail}
        autoComplete="email"
        required
        onChange={(event) => setNewEmail(event.target.value)}
      />
      <PasswordField
        id="settings-email-password"
        label="Current password"
        value={password}
        autoComplete="current-password"
        onChange={setPassword}
      />
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="settings-notice" role="status">
          {notice}
        </p>
      )}
      <button type="submit" disabled={submitting}>
        {submitting ? "Sending…" : "Change email"}
      </button>
    </form>
  );
}

function ChangePassword({ email }: { email: string }) {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resetState, setResetState] = useState<"idle" | "sending" | "sent">("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const passwordError = await verifyPassword(email, currentPassword);
    if (passwordError) {
      setSubmitting(false);
      setError(passwordError);
      return;
    }
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    setSubmitting(false);
    if (updateError) {
      setError(friendlyAuthError(updateError, "change password"));
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    toast("Your password is updated.", "success");
  }

  // For someone signed in who no longer remembers their password: the same
  // emailed link as /forgot-password, sent to the address on file.
  async function sendResetLink() {
    setError(null);
    setResetState("sending");
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (resetError) {
      setResetState("idle");
      setError(friendlyAuthError(resetError, "reset"));
      return;
    }
    setResetState("sent");
  }

  return (
    <form className="auth-card settings-card" onSubmit={handleSubmit}>
      <header>
        <h2>Password</h2>
      </header>
      <PasswordField
        id="settings-current-password"
        label="Current password"
        value={currentPassword}
        autoComplete="current-password"
        onChange={setCurrentPassword}
      />
      <PasswordField
        id="settings-new-password"
        label="New password"
        value={newPassword}
        autoComplete="new-password"
        minLength={6}
        hint="At least 6 characters."
        onChange={setNewPassword}
      />
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Change password"}
      </button>
      <p className="settings-reset">
        {resetState === "sent" ? (
          <span role="status">
            Reset link sent to <strong>{email}</strong>. It can take a minute — check spam too.
          </span>
        ) : (
          <>
            Forgot your current password?{" "}
            <button
              type="button"
              className="settings-text-button"
              disabled={resetState === "sending"}
              onClick={() => void sendResetLink()}
            >
              {resetState === "sending" ? "Sending…" : "Email me a reset link"}
            </button>
          </>
        )}
      </p>
    </form>
  );
}

function DeleteAccount({ email, userId }: { email: string; userId: string }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete() {
    setError(null);
    setDeleting(true);
    let message: string | null = null;
    try {
      const response = await apiFetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        message = body?.error ?? "Couldn’t delete your account. Please try again.";
      }
    } catch {
      message = "We couldn’t reach the server. Check your connection and try again.";
    }
    if (message) {
      setDeleting(false);
      setConfirming(false);
      setError(message);
      return;
    }

    // The account is gone server-side; what's left is this device's copy.
    try {
      await deleteLocalData(userId);
    } catch (err) {
      console.error("Couldn't clear local data after deleting the account:", err);
    }
    // The session's tokens are already invalid; signing out clears them
    // locally without waiting on a server that no longer knows this user.
    await supabase.auth.signOut({ scope: "local" });
    toast("Your account has been deleted.", "success");
    navigate("/", { replace: true });
  }

  return (
    <>
      <form
        className="auth-card settings-card settings-card--danger"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setConfirming(true);
        }}
      >
        <header>
          <h2>Delete account</h2>
          <p className="settings-copy">
            Permanently deletes your account and signs you out. Scripts and
            self-tapes saved on this device are erased too — download any take
            you want to keep first. This can’t be undone.
          </p>
        </header>
        <PasswordField
          id="settings-delete-password"
          label="Current password"
          value={password}
          autoComplete="current-password"
          onChange={setPassword}
        />
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="settings-danger-button" disabled={deleting}>
          Delete my account
        </button>
      </form>

      {confirming && (
        <Modal
          labelledBy="delete-account-title"
          onClose={() => {
            if (!deleting) setConfirming(false);
          }}
        >
          <h2 id="delete-account-title" className="modal-title">
            Delete your account?
          </h2>
          <p className="modal-copy">
            <strong>{email}</strong> and everything saved under it will be gone
            for good, including any subscription.
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="modal-secondary"
              data-autofocus
              disabled={deleting}
              onClick={() => setConfirming(false)}
            >
              Keep my account
            </button>
            <button
              type="button"
              className="modal-danger"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? "Deleting…" : "Delete forever"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
