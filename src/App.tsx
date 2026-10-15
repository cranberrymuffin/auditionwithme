import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import Home from "./pages/Home";
import Practice from "./pages/Practice";
import About from "./pages/About";
import Faq from "./pages/Faq";
import Pricing from "./pages/Pricing";
import Billing from "./pages/Billing";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import MyAccount from "./pages/MyAccount";
import AccountSettings from "./pages/AccountSettings";
import Admin from "./pages/Admin";
import NotFound from "./pages/NotFound";
import ResetPassword, { ForgotPassword } from "./pages/ResetPassword";
import RequireAuth from "./components/RequireAuth";
import RequireAdmin from "./components/RequireAdmin";
import RequirePlan from "./components/RequirePlan";
import ToastProvider from "./components/ToastProvider";
import FeedbackGate from "./components/FeedbackGate";
import { AuthProvider } from "./contexts/AuthContext";
import NavigationFocus, { SkipLink } from "./components/NavigationFocus";
import { IS_BETA_TESTING } from "./lib/beta";

function App() {
  return (
    <BrowserRouter>
      <SkipLink />
      <NavigationFocus />
      <ToastProvider>
        <AuthProvider>
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
          {IS_BETA_TESTING && <FeedbackGate />}
        </AuthProvider>
      </ToastProvider>
      <Analytics />
    </BrowserRouter>
  );
}

export default App;
