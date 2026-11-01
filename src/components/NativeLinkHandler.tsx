import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { App as CapacitorApp } from "@capacitor/app";
import { supabase } from "../lib/supabase";
import { readAuthLink } from "../lib/authLink";
import { IS_NATIVE } from "../lib/platform";

/** In the iOS app, routes Universal Links (auth emails, shared links to the
 * site) to the matching screen. The app doesn't reload for a Universal Link,
 * so supabase-js never sees an auth email's one-time code on its own: it's
 * exchanged here. The exchange only succeeds if this app asked for the email
 * (it holds the PKCE verifier), so a link someone else sent can't sign the
 * app into their account. */
export default function NativeLinkHandler() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!IS_NATIVE) return;
    const listener = CapacitorApp.addListener("appUrlOpen", async ({ url }) => {
      const link = new URL(url);
      const { code } = readAuthLink(url);
      // A failed exchange (another device's link) leaves no session.
      if (code) await supabase.auth.exchangeCodeForSession(code);
      // The link's parameters ride along either way, so each landing page
      // reacts as it does in a browser: code plus session, code alone, or
      // an error or message from Supabase.
      navigate(`${link.pathname}${link.search}${link.hash}`);
    });
    return () => {
      void listener.then((handle) => handle.remove());
    };
  }, [navigate]);

  return null;
}
