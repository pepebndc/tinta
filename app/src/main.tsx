import React from "react";
import ReactDOM from "react-dom/client";
import "./theme";
import { App } from "./App";
import { Overview } from "./Overview";
import { Bubble } from "./Bubble";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";

// The bubble window loads the same page. The design preview shows the bubble at "#bubble" and "#bubble-open".
const bubble = import.meta.env.MODE === "mock" ? window.location.hash.startsWith("#bubble") : getCurrentWindow().label === "bubble";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {bubble ? (
      <Bubble />
    ) : (
      <>
        <App />
        <Overview />
      </>
    )}
  </React.StrictMode>,
);
