import React from "react";
import ReactDOM from "react-dom/client";
import "./theme";
import { App } from "./App";
import { Overview } from "./Overview";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <Overview />
  </React.StrictMode>,
);
