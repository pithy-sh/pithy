import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "./router";
// Yours, and Pithy's. `styles.css` is written once and then belongs to you; `pithy-screens.css` carries
// the classes Pithy's own screens render, in a cascade layer, so anything you write here wins over it.
// Pithy's screens import it themselves as well — that is what keeps them styled when they are added to
// a project whose `client.tsx` was written before they were.
import "./styles.css";
import "./pithy-screens.css";

/**
 * The mount node, created here rather than found in `index.html`.
 *
 * **This is the whole of the mount contract, and it is one statement.** It used to be two: a
 * `<div id="root">` in `index.html` and a `getElementById("root")` here, with an `if (container)`
 * around the render. Renaming that div — an ordinary thing to do to your own HTML — made the app
 * render nothing, throw nothing and log nothing: an empty document with a 200, a clean build and a
 * green suite (#394). The guard was the defect; deleting it alone would have made the same rename an
 * immediate error, and not having the second string at all means there is no rename to make.
 *
 * The id is still set, so `#root` works as a styling hook. Nothing reads it.
 *
 * Put whatever you like in `index.html`'s `<body>` — a splash, a `<noscript>` — and the app mounts
 * after it. If you need it somewhere else in the document, append it there; this is ordinary DOM code,
 * not a convention. The `<script type="module">` that loads this file is deferred, so `document.body`
 * exists by the time this runs.
 */
const container = document.body.appendChild(document.createElement("div"));
container.id = "root";

createRoot(container).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
