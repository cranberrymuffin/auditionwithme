import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { App as CapacitorApp } from "@capacitor/app";
import { supabase } from "../lib/supabase";
import { IS_NATIVE } from "../lib/platform";

/** In the iOS app, routes Universal Links (auth emails, shared links to the
 * site) to the matching screen. supabase-js only reads tokens from the URL
 * the page loaded with, so a confirmation or reset link's session is set
 * here before navigating. */
export default function NativeLinkHandler() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!IS_NATIVE) return;
    const listener = CapacitorApp.addListener("appUrlOpen", async ({ url }) => {
      const link = new URL(url);
      const params = new URLSearchParams(link.hash.slice(1));
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      if (accessToken && refreshToken) {
        await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      }
      navigate(`${link.pathname}${link.search}`);
    });
    return () => {
      void listener.then((handle) => handle.remove());
    };
  }, [navigate]);

  return null;
}
