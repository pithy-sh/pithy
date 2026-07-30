// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
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

describe("pithy ui", () => {
  let projectDir: string;
  let workerDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "pithy-ui-flow-"));
    workerDir = join(projectDir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), '{\n  "name": "api"\n}\n');
    await writeFile(join(workerDir, "pithy.worker.jsonc"), '{\n  "dev": { "autostart": true }\n}\n');
    await writeFile(
      join(workerDir, "package.json"),
      `${JSON.stringify({ name: "api", scripts: { dev: "wrangler dev" } }, null, 2)}\n`,
    );
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  /** The common half of every `runUiAdd` call in this file. */
  function options(config: WorkerConfig) {
    return { projectDir, workerDir, worker: "api", config, framework: "react", packageManager: "bun" as const };
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

    const same = await runUiSync({ workerDir, worker: "api", config: WITHOUT_AUTH });
    expect(same.changed).toBe(false);
    expect(same.before).toEqual(same.after);

    const grown: WorkerConfig = { capabilities: [...WITHOUT_AUTH.capabilities, routed("ledger", "/ledger")] };
    const changed = await runUiSync({ workerDir, worker: "api", config: grown });
    expect(changed.changed).toBe(true);
    expect(changed.after.filter((path) => !changed.before.includes(path))).toEqual(["/ledger", "/ledger/*"]);

    // No file creation — sync only re-derives.
    await expect(readFile(join(workerDir, "src", "routes", "pithy", "sign-in.tsx"), "utf8")).rejects.toThrow();
  });

  test("sync on a worker with no front end says so", async () => {
    try {
      await runUiSync({ workerDir, worker: "api", config: WITHOUT_AUTH });
      expect.unreachable("expected sync without a UI to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.action).toContain("pithy ui add react");
    }
  });
});
