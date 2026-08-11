import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./monaco-setup.ts"; // has to run before any editor mounts
import { App } from "./App.tsx";
import "./styles.css";

// keeping StrictMode on -- it caught the websocket leak in sync.ts
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
