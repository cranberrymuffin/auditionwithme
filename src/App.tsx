import { lazy, Suspense, type ComponentType } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import Home from "./pages/Home";
import About from "./pages/About";
import Faq from "./pages/Faq";
import Terms from "./pages/Terms";
import Pricing from "./pages/Pricing";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import NotFound from "./pages/NotFound";
import RequireAuth from "./components/RequireAuth";
import RequireAdmin from "./components/RequireAdmin";
import RequirePlan from "./components/RequirePlan";
import ToastProvider from "./components/ToastProvider";
import FeedbackGate from "./components/FeedbackGate";
import { AuthProvider } from "./contexts/AuthProvider";
import NavigationFocus, { SkipLink } from "./components/NavigationFocus";
import NativeLinkHandler from "./components/NativeLinkHandler";
import { IS_BETA_TESTING } from "./lib/beta";

const CHUNK_RELOAD_KEY = "awm:chunk-reload";

/** A page loaded on demand, in a chunk of its own. A deploy replaces the
 * hashed chunk files, so a tab opened before it can ask for one that's gone:
 * one reload picks up the new build (once, so a real outage can't loop). */
function lazyPage(load: () => Promise<{ default: ComponentType }>) {
  return lazy(async () => {
    try {
      const page = await load();
      try {
        sessionStorage.removeItem(CHUNK_RELOAD_KEY);
      } catch {
        // No session storage (private mode): nothing to clear.
      }
      return page;
    } catch (err) {
      let alreadyReloaded = true;
      try {
        alreadyReloaded = sessionStorage.getItem(CHUNK_RELOAD_KEY) !== null;
        sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
      } catch {
        // No session storage to remember the reload in: don't risk a loop.
      }
      if (alreadyReloaded) throw err;
      window.location.reload();
      // Never settles: the page is on its way out.
      return new Promise<{ default: ComponentType }>(() => {});
    }
  });
}

// The signed-in app loads on demand, so the marketing pages don't carry the
// rehearsal, recorder, billing and admin code. The pages prerendered at
// build time (scripts/prerender.mjs: /, /how-it-works, /faq, /terms and
// /pricing) must stay ordinary imports: renderToString doesn't wait for a
// lazy page, and would write its fallback into the HTML instead.
const Practice = lazyPage(() => import("./pages/Practice"));
const MyAccount = lazyPage(() => import("./pages/MyAccount"));
const AccountSettings = lazyPage(() => import("./pages/AccountSettings"));
const Admin = lazyPage(() => import("./pages/Admin"));
const Billing = lazyPage(() => import("./pages/Billing"));
const Nda = lazyPage(() => import("./pages/Nda"));
const ResetPassword = lazyPage(() => import("./pages/ResetPassword"));
const ForgotPassword = lazyPage(() =>
  import("./pages/ResetPassword").then((module) => ({ default: module.ForgotPassword })),
);

/** Everything inside the router, shared by the browser app and the
 * build-time prerender (src/entry-server.tsx), which uses a StaticRouter. */
export function AppRoutes() {
  return (
    <>
      <SkipLink />
      <NavigationFocus />
      <NativeLinkHandler />
      <ToastProvider>
        <AuthProvider>
          <Suspense fallback={<div className="cinematic-page" aria-busy="true" />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route
                path="/practice/*"
                element={
                  <RequireAuth>
                    <RequirePlan>
                      <Practice />
                    </RequirePlan>
                  </RequireAuth>
                }
              />
              <Route
                path="/viewer"
                element={<Navigate to="/practice" replace />}
              />
              <Route
                path="/account"
                element={
                  <RequireAuth>
                    <MyAccount />
                  </RequireAuth>
                }
              />
              <Route
                path="/account/settings"
                element={
                  <RequireAuth>
                    <AccountSettings />
                  </RequireAuth>
                }
              />
              <Route
                path="/admin"
                element={
                  <RequireAdmin>
                    <Admin />
                  </RequireAdmin>
                }
              />
              <Route path="/login" element={<Login />} />
              <Route path="/signup" element={<Signup />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/how-it-works" element={<About />} />
              <Route
                path="/about"
                element={<Navigate to="/how-it-works" replace />}
              />
              <Route path="/faq" element={<Faq />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/nda" element={<Nda />} />
              {/* Pricing/billing are off for the beta — flip IS_BETA_TESTING
                  in src/lib/beta.ts to bring them back. */}
              <Route
                path="/pricing"
                element={
                  IS_BETA_TESTING ? <Navigate to="/" replace /> : <Pricing />
                }
              />
              <Route
                path="/billing"
                element={
                  IS_BETA_TESTING ? (
                    <Navigate to="/" replace />
                  ) : (
                    <RequireAuth>
                      <Billing />
                    </RequireAuth>
                  )
                }
              />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
          {IS_BETA_TESTING && <FeedbackGate />}
        </AuthProvider>
      </ToastProvider>
    </>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
      <Analytics />
    </BrowserRouter>
  );
}

export default App;
