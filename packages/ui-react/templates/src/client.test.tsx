// @vitest-environment happy-dom

import { act } from "react";
import { expect, test, vi } from "vitest";

/**
 * **The app mounts into a node it creates, so nothing in `index.html` can rename it out from under it.**
 *
 * This file used to find its mount point with `document.getElementById("root")` and render inside
 * `if (container) { … }`, against a `<div id="root">` declared in `index.html`. Two strings, nothing
 * comparing them. Renaming the div — an ordinary edit to your own HTML — produced an empty document
 * with a 200: no throw, no log, a clean build and a green suite. The failure mode hardest to attribute,
 * because the first three things anyone suspects are their own code, their build and their Worker, and
 * none of them is wrong (#394).
 *
 * ## What this proves, and how it goes red
 *
 * The document is given a mount node with a **deliberately wrong id** before `client.tsx` is imported —
 * exactly the document an adopter who renamed the div would have. Code that looks an id up finds
 * nothing and renders nothing, and this goes red; only code that creates its own node can pass. The id
 * is invented here and reachable from nowhere else, which is what a canary is for: asserting `"root"`
 * would have passed against the very edit this catches.
 *
 * `./router` is stubbed for the same reason `src/turnstile.test.tsx` stubs `./pithy-config` — the real
 * one resolves every screen, and those read `virtual:pithy/*` modules that only a Vite build serves.
 * Mounting is what is under test here, not routing.
 */

/** The id the document's mount node carries. Not the one anything renders into, on purpose. */
const CANARY_ID = "pithy-gate-canary-not-the-mount-id";

/** What the stubbed router draws. Finding it in the document is the whole assertion. */
const MOUNTED = "pithy-gate-canary-mounted";

vi.mock("./router", () => ({ Router: () => MOUNTED }));

// React refuses to run `act` unless the environment says it is a test one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("the app mounts even though no node in the document carries the id it once looked for", async () => {
  // The canary must not have drifted onto the real value: an id of "root" would pass against the bug.
  expect(CANARY_ID).not.toBe("root");

  document.body.innerHTML = `<div id="${CANARY_ID}"></div>`;

  // Imported inside the case, because importing it is what mounts.
  await act(async () => {
    await import("./client");
  });

  expect(document.body.textContent, "nothing rendered — client.tsx did not mount into a node of its own").toContain(
    MOUNTED,
  );
  // And it did not mount into the adopter's element. The node it renders into is its own.
  expect(document.getElementById(CANARY_ID)?.textContent).toBe("");
});
