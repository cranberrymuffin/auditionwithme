import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import "./App.css";
import Home from "./pages/Home";
import Viewer from "./pages/Viewer";

function Layout() {
  const location = useLocation();
  const isHome = location.pathname === "/";

  return (
    <div className={`app${isHome ? " home-route" : ""}`}>
      {!isHome && (
        <header className="app-header">
          <h1>AuditionWithMe</h1>
          <p>Upload your sides and get a clean, analysis-ready script</p>
        </header>
      )}
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/viewer" element={<Viewer />} />
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
