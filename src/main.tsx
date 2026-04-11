/**
 * @file main.tsx
 * @description React application entry point.
 *
 * Initializes i18n before mounting the React tree to ensure
 * translations are available on first render.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import "./index.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
