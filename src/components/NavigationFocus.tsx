import { useEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/**
 * What a full page load does for free and a client-side route change
 * doesn't: start a new page at the top, and move focus to it. Without this,
 * keyboard focus stays on a link that may no longer exist and a screen
 * reader announces nothing. Focus goes to the new page's <h1> (else its
 * <main>), which also reads the page's name out. Back/Forward (POP) keep
 * the browser's own scroll restoration.
 */
export default function NavigationFocus() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const firstRender = useRef(true);

  useEffect(() => {
    // The initial load already starts at the top with focus on the document.
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (navigationType !== "POP") window.scrollTo(0, 0);
    // A frame later, so the new page has rendered its heading.
    const frame = requestAnimationFrame(() => {
      const target =
        document.querySelector<HTMLElement>("main h1") ?? document.querySelector<HTMLElement>("main");
      if (!target) return;
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname, navigationType]);

  return null;
}

/** First thing a keyboard user tabs to: jumps past the site nav. */
export function SkipLink() {
  return (
    <a
      href="#main"
      className="skip-link"
      onClick={(event) => {
        const main = document.querySelector<HTMLElement>("main");
        if (!main) return;
        event.preventDefault();
        if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
        main.focus();
      }}
    >
      Skip to main content
    </a>
  );
}
