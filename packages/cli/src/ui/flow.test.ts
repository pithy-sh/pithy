// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { compositionEnvironment } from "@pithy-sh/core/src/env/ambient";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { DEV_LOGIN_ROUTE } from "@pithy-sh/core/src/seed/devLogin";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { WorkerConfig } from "../project/config";
import { listStubs, runUiAdd, runUiSync } from "./flow";

/** A capability mounting one route under `base` — enough to appear in the composed route table. */
function routed(name: string, base: string) {
  return defineCapability({
    name,
    requiredBindings: [],
    routes: (app) => {
      app.get(base, (c) => c.json({}));
    },
  });
}

const WITH_AUTH: WorkerConfig = { capabilities: [routed("auth", "/auth")] };
const WITHOUT_AUTH: WorkerConfig = { capabilities: [routed("leaderboard", "/leaderboard")] };
const WITH_PAYMENTS: WorkerConfig = { capabilities: [routed("auth", "/auth"), routed("payments", "/payments")] };

/**
 * A worker composing a capability that mounts its route **only** in a `dev` composition — the shape
 * `@pithy-sh/auth` gives the dev-login route, and the shape no single composition can reveal.
 */
const DEV_ONLY: WorkerConfig = {
  capabilities: [
    defineCapability({
      name: "auth",
      requiredBindings: [],
      routes: (app) => {
        if (compositionEnvironment() !== "dev") return;
        app.get(DEV_LOGIN_ROUTE, (c) => c.json({}));
      },
    }),
  ],
};

/** The target worker's directory — the `<name>` in `apps/<name>`. */
const WORKER = "board";

/** The same worker's deployed name, which is `<project>-<worker>` and never a path. */
const DEPLOYED = "replay-board";

describe("pithy ui", () => {
  let projectDir: string;
  let workerDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "pithy-ui-flow-"));
    // The two names a Worker has, deliberately different: it lives at `apps/board` and deploys as
    // `replay-board`. A fixture where they agree cannot tell which one a path was built from.
    workerDir = join(projectDir, "apps", WORKER);
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), `{\n  "name": "${DEPLOYED}"\n}\n`);
    await writeFile(join(workerDir, "pithy.worker.jsonc"), '{\n  "dev": { "autostart": true }\n}\n');
    await writeFile(
      join(workerDir, "package.json"),
      `${JSON.stringify({ name: DEPLOYED, scripts: { dev: "wrangler dev" } }, null, 2)}\n`,
    );
    await writeFile(join(projectDir, "tsconfig.json"), `${JSON.stringify({ files: [], references: [] }, null, 2)}\n`);
    // A real root config, because the allowlist derivation reads the project's `environments` from it —
    // a Worker's route table is a function of the environment it composes in, so the set is an input.
    await writeFile(
      join(projectDir, "pithy.config.ts"),
      'export default { name: "replay", environments: ["staging", "prod"] };\n',
    );
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  /** The common half of every `runUiAdd` call in this file. */
  function options(config: WorkerConfig) {
    return { projectDir, workerDir, config, framework: "react", packageManager: "bun" as const };
  }

  test("lists the frameworks it can scaffold", () => {
    expect(listStubs()).toEqual([
      { id: "react", description: "React 19 SPA on Vite, served by the worker as static assets" },
    ]);
  });

  test("scaffolds the bare template and wires the worker end to end", async () => {
    const report = await runUiAdd({ ...options(WITHOUT_AUTH), auth: false });

    expect(report.auth).toBe(false);
    expect(report.created).toContain("vite.config.ts");
    expect(report.created).not.toContain("src/routes/pithy/sign-in.tsx");
    expect(report.runWorkerFirst).toEqual(["/health", "/health/*", "/leaderboard", "/leaderboard/*"]);

    const wrangler = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as {
      assets: { not_found_handling: string; run_worker_first: string[] };
    };
    expect(wrangler.assets.not_found_handling).toBe("single-page-application");
    expect(wrangler.assets.run_worker_first).toEqual(report.runWorkerFirst);

    const manifest = parse(await readFile(join(workerDir, "pithy.worker.jsonc"), "utf8")) as unknown as {
      dev: { command: string[]; readySignal: string };
      ui: { stub: string; build: string[] };
    };
    expect(manifest.ui).toEqual({ stub: "react", build: ["vite", "build", "--configLoader", "runner"] });
    expect(manifest.dev.command).toEqual([
      "bun",
      "x",
      "vite",
      "dev",
      "--configLoader",
      "runner",
      "--strictPort",
      "--port",
      "{port}",
    ]);
  });

  test("names the worker by its directory, never by the name it deploys under", async () => {
    // A Worker deploys as `<project>-<worker>` and lives at `apps/<worker>`. Every string below is a
    // path, so every one is the directory: `apps/replay-board/` does not exist, and a reference to it
    // fails `tsc -b` with TS6053 and stops Vite from loading the worker's own config.
    const report = await runUiAdd({ ...options(WITHOUT_AUTH), auth: false });
    expect(report.worker).toBe(WORKER);

    const solution = parse(await readFile(join(projectDir, "tsconfig.json"), "utf8")) as unknown as {
      references: { path: string }[];
    };
    expect(solution.references.map((reference) => reference.path)).toEqual([
      `./apps/${WORKER}/tsconfig.client.json`,
      `./apps/${WORKER}/tsconfig.node.json`,
    ]);

    // The build-state files too: `pithy init` names the Worker's own after the directory, and two halves
    // of one Worker writing `dist/board.server.tsbuildinfo` beside `dist/replay-board.client.tsbuildinfo`
    // is the same confusion surviving somewhere it happens to still work.
    for (const program of ["tsconfig.client.json", "tsconfig.node.json"]) {
      const contents = await readFile(join(workerDir, program), "utf8");
      expect(contents, program).toContain(`../../dist/${WORKER}.`);
      expect(contents, program).not.toContain(DEPLOYED);
    }
  });

  test("--json with no flags never blocks: it follows what the worker composes", async () => {
    // No prompt is supplied, which is exactly the agent/CI path.
    const report = await runUiAdd(options(WITH_AUTH));
    expect(report.auth).toBe(true);
    expect(report.payments).toBe(false);
  });

  test("at a TTY it asks about each composed screen set, suggesting yes for each", async () => {
    const asked: { screens: string; suggestion: boolean }[] = [];
    const report = await runUiAdd({
      ...options(WITH_PAYMENTS),
      prompt: async (request) => {
        asked.push(request);
        return false;
      },
    });
    expect(asked).toEqual([
      { screens: "auth", suggestion: true },
      { screens: "payments", suggestion: true },
    ]);
    expect(report.auth).toBe(false);
    expect(report.payments).toBe(false);
  });

  test("a worker composing payments gets the paywall and the subscription screen", async () => {
    const report = await runUiAdd({ ...options(WITH_PAYMENTS), auth: false, payments: true });
    expect(report.payments).toBe(true);
    expect(report.created).toContain("src/routes/pithy/paywall.tsx");
    expect(report.created).toContain("src/routes/pithy/subscription.tsx");
    expect(report.created).toContain("src/payments.tsx");
    // Derived from the real route table, so the payments routes reach the worker instead of the SPA shell.
    expect(report.runWorkerFirst).toContain("/payments");
    expect(report.runWorkerFirst).toContain("/payments/*");
  });

  test("--payments on a worker with no payments capability is actionable, never a broken scaffold", async () => {
    try {
      await runUiAdd({ ...options(WITH_AUTH), auth: false, payments: true });
      expect.unreachable("expected --payments without the capability to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      const payload = (error as PithyError).payload;
      expect(payload.action).toContain("pithy add payments");
      expect(payload.action).toContain("--no-payments");
    }
    await expect(readFile(join(workerDir, "vite.config.ts"), "utf8")).rejects.toThrow();
  });

  test("--payments after --no-payments adds exactly the payments files", async () => {
    const first = await runUiAdd({ ...options(WITH_PAYMENTS), auth: true, payments: false });
    const second = await runUiAdd({ ...options(WITH_PAYMENTS), auth: true, payments: true });
    expect(second.created.sort()).toEqual([
      "src/payments.tsx",
      "src/routes/pithy/paywall.tsx",
      "src/routes/pithy/subscription.tsx",
    ]);
    expect(second.skipped).toEqual(first.created);
  });

  test("a backfill onto a hand-written stylesheet produces screens that render styled", async () => {
    // The reported failure, exactly. A project scaffolded `--no-auth` before Pithy's screens carried
    // their own stylesheet — so `src/pithy-screens.css` is absent — whose `src/styles.css` the adopter
    // has since replaced with their own design. Then it gains the sign-in screens.
    await runUiAdd({ ...options(WITH_AUTH), auth: false });
    await rm(join(workerDir, "src", "pithy-screens.css"));
    const mine = "/* Replay's own design. */\nbody { background: #0e0e10; }\n";
    await writeFile(join(workerDir, "src", "styles.css"), mine);

    const backfill = await runUiAdd({ ...options(WITH_AUTH), auth: true });

    expect(backfill.created).toContain("src/routes/pithy/sign-in.tsx");
    // Theirs, untouched — skipping it is right, and is what left the screens unstyled before.
    expect(backfill.skipped).toContain("src/styles.css");
    expect(await readFile(join(workerDir, "src", "styles.css"), "utf8")).toBe(mine);
    // And the screens are styled anyway, because the run that writes them writes their rules.
    expect(backfill.created).toContain("src/pithy-screens.css");
    expect(backfill.unstyled).toEqual([]);
  });

  test("a run whose screens would render unstyled says exactly which classes are missing", async () => {
    // The planted violation, end to end: `pithy-screens.css` is on disk but the adopter has emptied
    // it, so it is skipped as theirs and defines nothing. The command has to name what is missing
    // rather than report the screens as created and stop there.
    await runUiAdd({ ...options(WITH_AUTH), auth: false });
    await writeFile(join(workerDir, "src", "pithy-screens.css"), "/* mine now */\n");
    await writeFile(join(workerDir, "src", "styles.css"), "body { margin: 0; }\n");

    const backfill = await runUiAdd({ ...options(WITH_AUTH), auth: true });
    expect(backfill.created).toContain("src/routes/pithy/sign-in.tsx");
    expect(backfill.unstyled).toEqual([
      "auth",
      "auth__brand",
      "auth__check",
      "auth__credentials",
      "auth__failed",
      "auth__form",
      "auth__form-mark",
      "auth__mark",
      "auth__provider",
      "auth__providers",
      "auth__signup",
      "divider",
      "muted",
      "otp",
      "screen",
      "secondary",
      "stack",
    ]);
  });

  test("--auth on a worker with no auth capability is actionable, never a broken scaffold", async () => {
    try {
      await runUiAdd({ ...options(WITHOUT_AUTH), auth: true });
      expect.unreachable("expected --auth without the capability to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      const payload = (error as PithyError).payload;
      expect(payload.action).toContain("pithy add auth");
      expect(payload.action).toContain("--no-auth");
    }
    // Nothing was scaffolded.
    await expect(readFile(join(workerDir, "vite.config.ts"), "utf8")).rejects.toThrow();
  });

  test("--auth after --no-auth adds exactly the auth files and leaves every other byte alone", async () => {
    const first = await runUiAdd({ ...options(WITH_AUTH), auth: false });
    const before = new Map<string, string>();
    for (const path of first.created) before.set(path, await readFile(join(workerDir, path), "utf8"));

    const second = await runUiAdd({ ...options(WITH_AUTH), auth: true });
    expect(second.created.sort()).toEqual([
      "src/routes/pithy/callback.tsx",
      "src/routes/pithy/otp.tsx",
      "src/routes/pithy/sign-in.tsx",
      "src/session.tsx",
      "src/turnstile.tsx",
    ]);
    expect(second.skipped).toEqual(first.created);

    for (const [path, contents] of before) {
      expect(await readFile(join(workerDir, path), "utf8"), path).toBe(contents);
    }
  });

  test("adding a UI twice is a clean, actionable error rather than a partial overwrite", async () => {
    await runUiAdd({ ...options(WITH_AUTH), auth: true });
    try {
      await runUiAdd({ ...options(WITH_AUTH), auth: true });
      expect.unreachable("expected a second identical add to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      const payload = (error as PithyError).payload;
      expect(payload.message).toContain("already has a react front end");
      expect(payload.action).toContain("pithy ui sync");
    }
  });

  test("a colliding file on a first scaffold is refused, and nothing is written", async () => {
    await writeFile(join(workerDir, "index.html"), "mine\n");
    await expect(runUiAdd({ ...options(WITHOUT_AUTH), auth: false })).rejects.toThrow(PithyError);
    expect(await readFile(join(workerDir, "index.html"), "utf8")).toBe("mine\n");
    await expect(readFile(join(workerDir, "vite.config.ts"), "utf8")).rejects.toThrow();
  });

  test("sync is idempotent and picks up a capability added after the scaffold", async () => {
    await runUiAdd({ ...options(WITHOUT_AUTH), auth: false });

    const same = await runUiSync({ projectDir, workerDir, config: WITHOUT_AUTH });
    expect(same.changed).toBe(false);
    expect(same.before).toEqual(same.after);

    const grown: WorkerConfig = { capabilities: [...WITHOUT_AUTH.capabilities, routed("ledger", "/ledger")] };
    const changed = await runUiSync({ projectDir, workerDir, config: grown });
    expect(changed.changed).toBe(true);
    expect(changed.after.filter((path) => !changed.before.includes(path))).toEqual(["/ledger", "/ledger/*"]);

    // No file creation — sync only re-derives.
    await expect(readFile(join(workerDir, "src", "routes", "pithy", "sign-in.tsx"), "utf8")).rejects.toThrow();
  });

  test("sync --check reports the routes the SPA shell is answering, and writes nothing", async () => {
    await runUiAdd({ ...options(WITHOUT_AUTH), auth: false });
    const written = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");

    // The reported failure: the adopter mounts routes on their own app capability after the scaffold.
    // No `pithy add` runs, so nothing re-derives, and every one of them comes back 200 text/html.
    const grown: WorkerConfig = {
      ...WITHOUT_AUTH,
      app: defineCapability({
        name: "api",
        requiredBindings: [],
        routes: (app) => {
          app.get("/api/organisations", (c) => c.json({}));
        },
      }),
    };
    const report = await runUiSync({ projectDir, workerDir, config: grown, check: true });

    expect(report.uncovered).toEqual(["/api/organisations"]);
    expect(report.changed).toBe(true);
    // A check that repairs the thing it is checking cannot be run twice for the same answer.
    expect(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")).toBe(written);
  });

  test("sync --check passes on a worker in sync", async () => {
    await runUiAdd({ ...options(WITHOUT_AUTH), auth: false });
    const report = await runUiSync({ projectDir, workerDir, config: WITHOUT_AUTH, check: true });
    expect(report.uncovered).toEqual([]);
    expect(report.changed).toBe(false);
  });

  test("a sync that writes leaves nothing uncovered", async () => {
    await runUiAdd({ ...options(WITHOUT_AUTH), auth: false });
    const grown: WorkerConfig = { capabilities: [...WITHOUT_AUTH.capabilities, routed("ledger", "/ledger")] };
    expect((await runUiSync({ projectDir, workerDir, config: grown })).uncovered).toEqual([]);
    expect((await runUiSync({ projectDir, workerDir, config: grown, check: true })).uncovered).toEqual([]);
  });

  test("a route only a dev composition mounts is in the allowlist ui add writes", async () => {
    // `pithy dev` composes this; `pithy ui add` does not. Nothing about the invocation says `dev`, so
    // the project's own environment set is what has to reach the derivation — and `dev` rides with it.
    const report = await runUiAdd({ ...options(DEV_ONLY), auth: false });
    expect(report.runWorkerFirst).toContain("/__pithy");
    expect(report.runWorkerFirst).toContain("/__pithy/*");
  });

  test("sync --check fails while a dev-only route is unreachable, and sync repairs it", async () => {
    // The planted violation, end to end. The allowlist is written without the route — the state
    // `pithy ui add` left every project in — and the check has to call it what it is.
    await runUiAdd({ ...options(WITHOUT_AUTH), auth: false });
    const stale = await runUiSync({ projectDir, workerDir, config: DEV_ONLY, check: true });
    expect(stale.uncovered).toEqual([DEV_LOGIN_ROUTE]);

    await runUiSync({ projectDir, workerDir, config: DEV_ONLY });
    expect((await runUiSync({ projectDir, workerDir, config: DEV_ONLY, check: true })).uncovered).toEqual([]);
  });

  test("sync on a worker with no front end says so", async () => {
    try {
      await runUiSync({ projectDir, workerDir, config: WITHOUT_AUTH });
      expect.unreachable("expected sync without a UI to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.action).toContain("pithy ui add react");
    }
  });
});
