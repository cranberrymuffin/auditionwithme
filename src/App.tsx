import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import Home from "./pages/Home";
import Practice from "./pages/Practice";
import About from "./pages/About";
import Pricing from "./pages/Pricing";
import Billing from "./pages/Billing";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import MyAccount from "./pages/MyAccount";
import RequireAuth from "./components/RequireAuth";
import ToastProvider from "./components/ToastProvider";
import FeedbackGate from "./components/FeedbackGate";
import { AuthProvider } from "./contexts/AuthContext";
import { IS_BETA_TESTING } from "./lib/beta";

function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route
              path="/practice"
              element={
                <RequireAuth>
                  <Practice />
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
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/how-it-works" element={<About />} />
            <Route
              path="/about"
              element={<Navigate to="/how-it-works" replace />}
            />
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
          </Routes>
          {IS_BETA_TESTING && <FeedbackGate />}
        </AuthProvider>
      </ToastProvider>
      <Analytics />
    </BrowserRouter>
  );
}

export default App;
