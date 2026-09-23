import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { StaticSite } from "./StaticSite";
import { STATIC_SITE } from "./site";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");

createRoot(root).render(
  <StrictMode>
    {STATIC_SITE ? <StaticSite /> : <App />}
  </StrictMode>,
);
