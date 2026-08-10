import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "./router";
// Yours, and Pithy's. `styles.css` is written once and then belongs to you; `pithy-screens.css` carries
// the classes Pithy's own screens render, in a cascade layer, so anything you write here wins over it.
// Pithy's screens import it themselves as well — that is what keeps them styled when they are added to
// a project whose `client.tsx` was written before they were.
import "./styles.css";
import "./pithy-screens.css";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Router />
    </StrictMode>,
  );
}
