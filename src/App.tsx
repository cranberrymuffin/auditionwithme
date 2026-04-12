import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./App.css";
import Home from "./pages/Home";
import Viewer from "./pages/Viewer";

function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <header className="app-header">
          <h1>AuditionWithMe</h1>
          <p>Upload your sides and get a clean, analysis-ready script</p>
        </header>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/viewer" element={<Viewer />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
