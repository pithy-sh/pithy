// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PACKAGE_VERSION } from "@pithy-sh/core/src/version.generated";
import { HOME_SCREEN, TEMPLATE_DIR, TEMPLATE_GROUPS, WORKER_TOKEN } from "@pithy-sh/ui-react/src/templates";
import { kitRange } from "../project/scaffold";
import type { UiStub, UiStubContext, UiStubFile } from "./stubs";

/**
 * The React 19 stub — the first framework `pithy ui add` scaffolds, registered through the same
 * {@link UiStub} declaration any later framework would use.
 *
 * Two templates. **bare** is a SPA with one typed `fetch("/health")`: no auth imports, no dead files.
 * **auth** is that plus the passwordless screens, a session hook, and a route guard.
 *
 * The screens live in `@pithy-sh/ui-react`, a template library with its own React toolchain, so they
 * are typechecked and linted like any other source. This module is the part that belongs to the CLI:
 * which of them a given invocation writes, and how the result is run and built. A second framework
 * brings its own library and its own module here; neither needs to touch the other's toolchain.
 *
 * Every client file is `.tsx`. That is load-bearing: the Worker's own `tsconfig.json` includes
 * `src/**\/*.ts`, which does **not** match `.tsx`, so the client never enters the Worker's program and
 * the Worker's config needs no edit. The ambient declarations live at the Worker root as
 * `client-env.d.ts` rather than under `src/`, because `.d.ts` *would* match that glob.
 */

/** The same path in and out — true of every template except the home screen. */
function inPlace(paths: readonly string[]): UiStubFile[] {
  return paths.map((path) => ({ source: path, target: path }));
}

function manifest(context: UiStubContext): UiStubFile[] {
  const files = inPlace(TEMPLATE_GROUPS.base);
  files.push({
    source: context.auth ? HOME_SCREEN.auth : HOME_SCREEN.bare,
    target: HOME_SCREEN.target,
  });
  // The capability groups stack rather than choose: they name disjoint files over one layout, so a Worker
  // composing both auth and payments gets both screen sets and no path moves.
  if (context.auth) files.push(...inPlace(TEMPLATE_GROUPS.auth));
  if (context.payments) files.push(...inPlace(TEMPLATE_GROUPS.payments));
  return files;
}

/** React 19, through Vite 8 and `@cloudflare/vite-plugin`. */
export const reactStub: UiStub = {
  id: "react",
  description: "React 19 SPA on Vite, served by the worker as static assets",
  templateDir: TEMPLATE_DIR,
  manifest,
  substitutions: (context) => ({ [WORKER_TOKEN]: context.worker }),
  dependencies: {
    react: "^19.2.8",
    "react-dom": "^19.2.8",
  },
  devDependencies: {
    "@cloudflare/vite-plugin": "^1.48.0",
    // Derived, never a literal. `@pithy-sh/vite` is the one package here the kit ships itself, so the
    // range it deserves is the kit's own — `kitRange` reads it off core's stamped version and answers
    // `null` while nothing under the scope is published, which drops the line entirely. Written as
    // `"^0.0.0"` it 404'd the adopter's next install, and no release would ever have moved it: the
    // publish that fixed every sibling range would have left this one wrong and alone.
    "@pithy-sh/vite": kitRange(PACKAGE_VERSION),
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.4",
    vite: "^8.0.16",
    wrangler: "^4.115.0",
  },
  // `--configLoader runner` is load-bearing, not a preference. Vite's default config loader bundles
  // vite.config.ts and leaves every bare import external, so Node itself has to import
  // `@pithy-sh/vite` — which, like every package here, ships raw TypeScript with extensionless
  // relative imports. Node cannot resolve those, and refuses to strip types under node_modules at
  // all. The runner loads the config through Vite's own resolver instead, where both are ordinary.
  devCommand: (port) => ["vite", "dev", "--configLoader", "runner", "--strictPort", "--port", port],
  readySignal: "ready in \\d+",
  buildCommand: ["vite", "build", "--configLoader", "runner"],
  // The adopter's own entry points. Every one loads vite.config.ts, so every one needs the runner —
  // and `dev` deliberately omits `--port`/`--strictPort`: a bare `vite dev` is someone working on the
  // front end alone, where Vite picking its own port is right. `pithy dev` is what pins ports.
  scripts: {
    dev: "vite dev --configLoader runner",
    build: "vite build --configLoader runner",
    preview: "vite preview --configLoader runner",
  },
};
