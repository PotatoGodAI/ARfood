import { Routes, Route } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import ARViewer from "./pages/ARViewer";

export default function App() {
  return (
    <div className="min-h-screen bg-neutral-50 font-sans text-neutral-900">
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/ar/:id" element={<ARViewer />} />
      </Routes>
    </div>
  );
}
