import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Home from "./pages/Home";
import Practice from "./pages/Practice";
import About from "./pages/About";
import Pricing from "./pages/Pricing";
import ToastProvider from "./components/ToastProvider";

function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/practice" element={<Practice />} />
          <Route path="/viewer" element={<Navigate to="/practice" replace />} />
          <Route path="/about" element={<About />} />
          <Route path="/pricing" element={<Pricing />} />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}

export default App;
