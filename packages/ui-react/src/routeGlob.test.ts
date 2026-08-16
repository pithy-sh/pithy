// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { TEMPLATE_DIR } from "./templates";

/**
 * The route globs decide what ships to a browser, so the gate is a real `vite build` — not a string
 * assertion about the glob.
 *
 * **The invariant: a file the test runner owns is never part of the client.** `src/router.tsx` says
 * its two globs ARE the route registration and must not be edited, and the kit co-locates tests
 * everywhere else, so an adopter writing `src/routes/app/home.test.tsx` is following both rules at
 * once. Before #245 that file was registered as a route and bundled — a 283 kB Vitest chunk on every
 * page load in `pithy-sh/dashboard`, with a fully green suite, because running a test is not the
 * problem and no test looked at `dist/`.
 *
 * Refusing a module with no `path` export would stop it *registering* and change nothing here: the
 * glob has already pulled it into the graph by then. So the fix is the glob, and the gate has to be
 * the build.
 *
 * The fixture is deliberately thin — the real `router.tsx`, two ordinary screens, and one planted
 * test beside them — and it is built with a bare Vite config rather than the template's. The three
 * plugins the template loads shape the Worker and the dev server; which modules a glob admits is
 * Vite's own, and building without them keeps this gate free of their install.
 */

/** The fixture builds inside the package's `node_modules`, so `react` and `vitest` resolve as they would. */
const GATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules");

/** A string that exists only in the planted test. Finding it in an asset means the test shipped. */
const PLANTED_MARKER = "planted-route-test-marker-245";

/** A co-located route test, exactly as the kit's own testing rule asks an adopter to write one. */
const PLANTED_TEST = `import { expect, test } from "vitest";
import Home, { path } from "./home";

const fixtureUser = { id: "usr_${PLANTED_MARKER}", email: "someone@example.com" };

test("home answers /", () => {
  expect(path).toBe("/");
  expect(Home).toBeTypeOf("function");
  expect(fixtureUser.id).toContain("planted");
});
`;

/** A screen, in the shape `router.tsx` documents: a declared path and a default export. */
function screen(path: string, name: string): string {
  return `export const path = "${path}";\nexport default function ${name}() {\n  return <p>${name}</p>;\n}\n`;
}

let fixture = "";
let assets: string[] = [];

beforeAll(async () => {
  fixture = await mkdtemp(join(GATE_ROOT, ".pithy-route-gate-"));
  await mkdir(join(fixture, "src", "routes", "app"), { recursive: true });
  await mkdir(join(fixture, "src", "routes", "pithy"), { recursive: true });

  // The file under test, byte for byte as an adopter receives it.
  await writeFile(join(fixture, "src", "router.tsx"), await readFile(join(TEMPLATE_DIR, "src", "router.tsx")));
  await writeFile(join(fixture, "src", "routes", "app", "home.tsx"), screen("/", "Home"));
  await writeFile(join(fixture, "src", "routes", "pithy", "sign-in.tsx"), screen("/sign-in", "SignIn"));
  await writeFile(join(fixture, "src", "routes", "app", "home.test.tsx"), PLANTED_TEST);
  // The entry, in the shape the seeded `src/client.tsx` uses: the mount node is created here rather
  // than looked up by an id `index.html` declares. Two strings and an `if (container)` around the
  // render is what made a renamed div an empty page with no error (#394); a fixture that kept writing
  // the old shape would be this gate quietly teaching it back.
  await writeFile(
    join(fixture, "src", "client.tsx"),
    `import { createRoot } from "react-dom/client";
import { Router } from "./router";

createRoot(document.body.appendChild(document.createElement("div"))).render(<Router />);
`,
  );
  // The seeded page, byte for byte. It carries no mount node, and the entry above does not want one.
  await writeFile(join(fixture, "index.html"), await readFile(join(TEMPLATE_DIR, "index.html")));

  const { build } = await import("vite");
  await build({
    root: fixture,
    logLevel: "silent",
    esbuild: { jsx: "automatic" },
    build: { minify: false, reportCompressedSize: false },
  });

  const dir = join(fixture, "dist", "assets");
  assets = await Promise.all(
    (await readdir(dir)).map((name) => readFile(join(dir, name), "utf8").then((text) => `${name}\n${text}`)),
  );
  expect(assets.length, "the fixture built nothing — the gate would pass vacuously").toBeGreaterThan(0);
}, 120_000);

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

test("a co-located route test is in no client asset the build emits", () => {
  const shipped = assets.filter((asset) => asset.includes(PLANTED_MARKER));
  expect(shipped.map((asset) => asset.split("\n", 1)[0])).toEqual([]);
});

test("the client carries no test runner", () => {
  // The measured symptom, stated as itself: the chunk was Vitest's, and it loaded on every page.
  const shipped = assets.filter((asset) => asset.includes("@vitest/expect") || asset.includes("vitest/dist"));
  expect(shipped.map((asset) => asset.split("\n", 1)[0])).toEqual([]);
});
