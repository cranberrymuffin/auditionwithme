import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import "./App.css";
import Home from "./pages/Home";
import Viewer from "./pages/Viewer";
import About from "./pages/About";

function Layout() {
  const location = useLocation();
  const isFullPage =
    location.pathname === "/" ||
    location.pathname === "/viewer" ||
    location.pathname === "/about";

  return (
    <div className={`app${isFullPage ? " home-route" : ""}`}>
      {!isFullPage && (
        <header className="app-header">
          <h1>AuditionWithMe</h1>
          <p>Upload your sides and get a clean, analysis-ready script</p>
        </header>
      )}
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/viewer" element={<Viewer />} />
          <Route path="/about" element={<About />} />
        </Routes>
      </main>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  );
}

export default App;
