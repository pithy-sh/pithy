// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { WorkerConfig } from "../project/config";
import { resolveTemplateSource } from "../project/scaffold";
import { reactStub } from "./react";
import { deriveWorkerFirst } from "./routeAllowlist";
import { wireAssets, wireManifest } from "./wire";
import { readManifestDocument } from "./workerUi";

/**
 * **The invariant: a file `pithy ui` writes is a file the Biome `pithy init` scaffolds would print
 * unchanged, and a two-line change is a two-line diff.**
 *
 * Both halves are #249, and both were found by running the real command in `pithy-sh/dashboard`.
 * `pithy ui sync --worker board` correctly detected a missing `/control-plane` in `run_worker_first`
 * and corrected it — and then failed `biome check` in the pre-commit hook the CLI itself scaffolds,
 * over four hunks of `"compatibility_flags": [\n "nodejs_compat"\n]` where Biome wants one line. The
 * same run turned a two-line change into 78 insertions, which puts the real edit somewhere inside a
 * reformat nobody can review.
 *
 * The gate runs the adopter's own toolchain: the starter's `biome.jsonc` verbatim, over the starter's
 * own `wrangler.jsonc` and `pithy.worker.jsonc` after the real wiring functions have edited them. A
 * literal here would only assert what the writer already believes.
 */

/** The starter, resolved the way `pithy init` resolves it. */
const STARTER = resolveTemplateSource(import.meta.dirname).dir;

/** The repo root — four up from `packages/cli/src/ui`, which is where the workspace's Biome lives. */
const BIOME = join(import.meta.dirname, "..", "..", "..", "..", "node_modules", ".bin", "biome");

/** The environments a project declares when it says nothing — what `pithy init` writes. */
const DECLARED = ["staging", "prod"];

const CONFIG: WorkerConfig = {
  capabilities: [
    defineCapability({
      name: "auth",
      requiredBindings: [],
      routes: (app) => {
        app.post("/auth/sign-in/magic-link", (c) => c.json({}));
      },
    }),
  ],
};

/** What `biome format` says about `files`, run from `cwd` against the scaffolded config. */
function biomeFormat(cwd: string, files: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(BIOME, ["format", ...files], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

/** How many lines differ between two texts, counted the way `git diff --stat` counts them. */
function changedLines(before: string, after: string): number {
  const kept = new Set(before.split("\n"));
  const had = new Set(after.split("\n"));
  const added = after.split("\n").filter((line) => !kept.has(line)).length;
  const removed = before.split("\n").filter((line) => !had.has(line)).length;
  return added + removed;
}

describe("what pithy ui writes, the scaffolded Biome would print", () => {
  let project: string;
  let worker: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), "pithy-ui-format-"));
    worker = join(project, "apps", "board");
    await mkdir(worker, { recursive: true });
    // The adopter's own toolchain, verbatim: the scaffolded Biome config and the Grit plugins it names.
    await cp(join(STARTER, "biome.template.jsonc"), join(project, "biome.jsonc"));
    await cp(join(STARTER, "plugins"), join(project, "plugins"), { recursive: true });
    // The two files the CLI edits rather than creates, exactly as `pithy init` writes them.
    await cp(join(STARTER, "apps", "api", "wrangler.jsonc"), join(worker, "wrangler.jsonc"));
    await cp(join(STARTER, "apps", "api", "pithy.worker.jsonc"), join(worker, "pithy.worker.jsonc"));
    await writeFile(join(worker, "package.json"), `${JSON.stringify({ name: "replay-board" }, null, 2)}\n`);
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  test("the starter's own files pass before anything touches them", async () => {
    // The control. A gate that cannot tell "Pithy wrote it badly" from "it was already like that"
    // proves nothing about the writer.
    const { code, output } = await biomeFormat(project, ["apps/board/wrangler.jsonc", "apps/board/pithy.worker.jsonc"]);
    expect(output).not.toContain("Formatter would have printed");
    expect(code).toBe(0);
  });

  test("wireAssets leaves a file Biome would print unchanged", async () => {
    await wireAssets(worker, deriveWorkerFirst(CONFIG, DECLARED));
    const { code, output } = await biomeFormat(project, ["apps/board/wrangler.jsonc"]);
    expect(output).not.toContain("Formatter would have printed");
    expect(code).toBe(0);
  });

  test("wireManifest leaves a file Biome would print unchanged", async () => {
    await wireManifest(worker, reactStub, "bun");
    const { code, output } = await biomeFormat(project, ["apps/board/pithy.worker.jsonc"]);
    expect(output).not.toContain("Formatter would have printed");
    expect(code).toBe(0);
  });

  test("adding an assets stanza changes the lines it means to change, and no others", async () => {
    const before = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    await wireAssets(worker, deriveWorkerFirst(CONFIG, DECLARED));
    const after = await readFile(join(worker, "wrangler.jsonc"), "utf8");

    // The stanza itself is four lines. Anything past that is the file being reformatted around the edit,
    // which is how a two-line change became 78 insertions.
    expect(changedLines(before, after)).toBeLessThanOrEqual(6);
    expect(after).toContain('"not_found_handling": "single-page-application"');
    // What the file already had, untouched — the shape an adopter chose is not the writer's to revisit.
    expect(after).toContain('"compatibility_flags": ["nodejs_compat"]');
    expect(after).toContain('"version_metadata": { "binding": "CF_VERSION_METADATA" }');
  });

  test("the correction pithy ui sync exists to make still happens, and is still reported", async () => {
    // The half of the dashboard's run that worked. It has to keep working, and a formatting fix is
    // exactly the kind of change that would quietly cost it.
    const first = await wireAssets(worker, deriveWorkerFirst(CONFIG, DECLARED));
    expect(first.before).toBeNull();
    expect(first.after).toContain("/auth");

    const grown = await wireAssets(
      worker,
      deriveWorkerFirst(
        {
          capabilities: [
            ...CONFIG.capabilities,
            defineCapability({
              name: "control-plane",
              requiredBindings: [],
              routes: (app) => {
                app.get("/control-plane/manifest", (c) => c.json({}));
              },
            }),
          ],
        },
        DECLARED,
      ),
    );
    expect(grown.before).toEqual(["/auth", "/auth/*", "/health", "/health/*"]);
    expect(grown.after).toContain("/control-plane");

    const { code, output } = await biomeFormat(project, ["apps/board/wrangler.jsonc"]);
    expect(output).not.toContain("Formatter would have printed");
    expect(code).toBe(0);
  });

  test("a second run with nothing to change writes nothing at all", async () => {
    await wireAssets(worker, deriveWorkerFirst(CONFIG, DECLARED));
    await wireManifest(worker, reactStub, "bun");
    const wrangler = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    const manifest = await readFile(join(worker, "pithy.worker.jsonc"), "utf8");

    await wireAssets(worker, deriveWorkerFirst(CONFIG, DECLARED));
    await wireManifest(worker, reactStub, "bun");
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(wrangler);
    expect(await readFile(join(worker, "pithy.worker.jsonc"), "utf8")).toBe(manifest);
    // And the document still parses to what the manifest reader expects, not just to the same bytes.
    expect((await readManifestDocument(worker)).ui).toMatchObject({ stub: "react" });
  });
});
