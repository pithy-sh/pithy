import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "./router";
import "./styles.css";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Router />
    </StrictMode>,
  );
}
