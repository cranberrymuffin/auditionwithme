// Build-time prerender entry (see scripts/prerender.mjs). Renders a public
// route to HTML in Node so crawlers that don't run JavaScript still see the
// page's content and its own canonical/title/description. Effects never run
// here, so pages render in their signed-out, initial state.
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { AppRoutes } from "./App";
import { ssrSeo, type ResolvedSeo } from "./components/Seo";

export function render(url: string): { html: string; seo: ResolvedSeo | null } {
  ssrSeo.current = null;
  const html = renderToString(
    <StrictMode>
      <StaticRouter location={url}>
        <AppRoutes />
      </StaticRouter>
    </StrictMode>,
  );
  return { html, seo: ssrSeo.current };
}
