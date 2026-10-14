import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startPwa } from "./lib/pwa";
import "./fonts.css";
import "./styles.css";

// ?pc: shown inside the VBuddy window on the PC, which has its own sidebar.
if (new URLSearchParams(window.location.search).has("pc")) document.documentElement.classList.add("pc");

startPwa();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
