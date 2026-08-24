// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
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
 *
 * ## And the app is mounted **under a translator**, which is the second thing this file proves
 *
 * `src/pithy-locale.tsx` has its own gate, and that gate mounts `<PithyLocale>` itself — so it proves
 * the component works and never that anything renders it. Deleting the element and its import from
 * this file left the whole repository green: an app with no translator over it, every screen in
 * English under whatever `lang` was negotiated, and not one test anywhere going red. That is the very
 * defect the seeded-gate convention exists to stop, one level up — the file that was broken is the
 * file with no gate on it.
 *
 * So `./pithy-locale` is stubbed with a wrapper that marks the subtree it draws, and the app has to be
 * found **inside** it. A stub rather than the real component on purpose: with nothing composed the real
 * one renders its children untouched, which is indistinguishable from not being rendered at all — the
 * assertion could not exist. What language it then mounts is `pithy-locale.test.tsx`'s subject, and
 * this file does not restate it.
 *
 * **And `./pithy-config` is stubbed too, which is not a detail.** `src/pithy-locale.tsx` reads the i18n
 * projection through it, so a `client.tsx` that reached the real module would reach a `virtual:pithy/*`
 * one — and a seeded gate that needs one of those runs in this repository, where the kit\'s own Vitest
 * config aliases them, and nowhere else. It would fail in every adopter\'s repository, on the first
 * `vitest run` after scaffolding, over a file they had not touched. The stub above keeps that module
 * out of the graph today; this one is what keeps this file green if it is ever narrowed. The projection
 * is stubbed disabled, which is the shape a project that never composed `i18n` projects.
 */

/** The id the document's mount node carries. Not the one anything renders into, on purpose. */
const CANARY_ID = "pithy-gate-canary-not-the-mount-id";

/** What the stubbed router draws. Finding it in the document is the whole assertion. */
const MOUNTED = "pithy-gate-canary-mounted";

/** The attribute the stubbed provider marks its subtree with. Invented here, like every canary above. */
const WRAPPED = "data-pithy-gate-locale";

vi.mock("./router", () => ({ Router: () => MOUNTED }));

vi.mock("./pithy-locale", () => ({
  PithyLocale: ({ children }: { children: ReactNode }) => <div {...{ [WRAPPED]: "" }}>{children}</div>,
}));

vi.mock("./pithy-config", () => ({ i18nConfig: { enabled: false } }));

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

  // The app is under a translator, and this is the only place that is true of. Delete `<PithyLocale>`
  // from `client.tsx` and every screen renders English under whatever language the document declares —
  // with nothing else in the repository noticing, which is how it got shipped once already.
  const wrapped = document.querySelector(`[${WRAPPED}]`);
  expect(wrapped, "client.tsx renders no <PithyLocale> — the app mounts with no translator over it").not.toBeNull();
  // Inside it, not beside it. A provider rendered as a sibling of the app translates nothing.
  expect(wrapped?.textContent, "the app is not inside <PithyLocale> — nothing under it reads a catalog").toContain(
    MOUNTED,
  );
});
