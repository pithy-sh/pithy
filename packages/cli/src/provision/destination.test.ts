// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sourceFiles } from "../ci/sourceFiles";
import { provisionFeature } from "../feature/provision";
import { type ProvisionReport, provisionEnvironment } from "./environment";
import type { ResourceProvisioner, ResourceProvisioners } from "./resources";

/**
 * **The gate for #251, and it is one sentence: a run names every file it wrote, and `committed` says
 * whether those bytes landed in a file the checkout tracks.**
 *
 * One command now has two modes with opposite persistence semantics. `--env` writes long-lived ids into
 * the tracked `wrangler.jsonc`, which a human commits in a pull request; `--feature` writes one job's ids
 * into a generated file under the already-ignored `.wrangler/`, which nothing ever commits. A single flag
 * flipping whether output is committed will surprise someone, so the run says which it did and where —
 * and this is what keeps that sentence true rather than merely written down.
 *
 * Stated as a property of every byte on disk rather than as a list of expected files, for the reason the
 * `writes nothing a checkout tracks` gate beside it gives: the list was the problem. A report that names
 * one file while the writer touches another passes any list and fails this.
 *
 * It is also the standing rule in code — **a CI build process never commits back to the repository.** A
 * pipeline runs `--feature`, and what it wrote is ignored; a human runs `--env`, and what they wrote is
 * source.
 */

/** An in-memory provisioner over a name→id map, mirroring the real find/create semantics. */
function fakeKind(kind: string, store: Map<string, string>): ResourceProvisioner {
  let seq = 0;
  return {
    find: async (name: string) => (store.has(name) ? { id: store.get(name) as string } : null),
    create: async (name: string) => {
      seq += 1;
      const id = kind === "r2" ? name : `${kind}-${seq}`;
      store.set(name, id);
      return { id };
    },
    delete: async (id: string) => {
      for (const [name, value] of store) if (value === id) store.delete(name);
    },
  };
}

function fakeProvisioners(): ResourceProvisioners {
  return {
    d1: fakeKind("d1", new Map()),
    kv: fakeKind("kv", new Map()),
    r2: fakeKind("r2", new Map()),
  } as unknown as ResourceProvisioners;
}

/** The Worker that declares everything: one D1, one KV, one R2. */
const full = defineCapability({
  name: "full",
  requiredBindings: [
    { type: "d1", name: "DB" },
    { type: "kv", name: "CACHE" },
    { type: "r2", name: "ASSETS" },
  ] satisfies BindingSpecInput[],
});

/** The Worker that shares the database and nothing else — so the two configs carry different id counts. */
const shared = defineCapability({
  name: "shared",
  requiredBindings: [{ type: "d1", name: "DB" }] satisfies BindingSpecInput[],
});

/** Every file under `root`, by absolute path, with its bytes — through the one walker (`ci/sourceFiles`). */
function snapshot(root: string): Map<string, string> {
  return new Map(sourceFiles(root, { dotted: true, keep: () => true }).map((file) => [file.path, file.text]));
}

/**
 * Would a checkout track this path? The two rules the scaffolded `.gitignore` has carried since the first
 * release — `.wrangler/` at any depth, and the feature manifest — written out rather than read off the
 * ignore file, because those two are the only ones provisioning is allowed to rely on.
 */
function tracked(path: string): boolean {
  return !(path.split(sep).includes(".wrangler") || path.endsWith(".pithy-feature.json"));
}

/**
 * The invariant itself. Every path whose bytes moved is one the report named, every path the report named
 * moved, and each one's tracked-ness is exactly what `committed` claims.
 *
 * The feature manifest is excluded by name and only by name: it is a side record of what to delete, not a
 * config any command reads bindings from, and `--env` has none.
 */
function assertSaysWhatItDid(projectDir: string, before: Map<string, string>, report: ProvisionReport): void {
  const after = snapshot(projectDir);
  const changed = [...after]
    .filter(([path, bytes]) => before.get(path) !== bytes)
    .map(([path]) => path)
    .filter((path) => !path.endsWith(".pithy-feature.json"))
    .sort();
  const named = report.configs.map((config) => resolve(projectDir, config.path)).sort();

  expect(changed).toEqual(named);
  expect(changed.length).toBeGreaterThan(0); // non-vacuity: "wrote nothing" is not a passing answer.
  for (const path of named) expect(tracked(path)).toBe(report.committed);
}

describe("a provisioning run says which file it wrote, and whether that file is committed", () => {
  let dir: string;
  let boardDir: string;
  let apiDir: string;
  // Project and worker names differ throughout: a Worker deploys as `<project>-<worker>`, and a fixture
  // where both are one word hides every place the two are confused.
  const workers = () => [
    { name: "replay-board", dir: boardDir, capabilities: [full] },
    { name: "replay-api", dir: apiDir, capabilities: [shared] },
  ];
  const noBackend = { migrate: async () => {}, seed: async () => {} };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-destination-"));
    boardDir = join(dir, "apps", "board");
    apiDir = join(dir, "apps", "api");
    await mkdir(boardDir, { recursive: true });
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(boardDir, "wrangler.jsonc"), '{\n  "name": "replay-board"\n}\n');
    await writeFile(join(apiDir, "wrangler.jsonc"), '{\n  "name": "replay-api"\n}\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("--env writes the tracked wrangler.jsonc, and says those ids are committed", async () => {
    const before = snapshot(dir);
    const report = await provisionEnvironment({
      projectDir: dir,
      scope: environmentScope("replay", "staging"),
      capabilities: [full, shared],
      provisioners: fakeProvisioners(),
      seedData: false,
      resolveWorkers: async () => workers(),
      ...noBackend,
    });

    assertSaysWhatItDid(dir, before, report);
    expect(report.committed).toBe(true);
    expect(report.configs).toEqual([
      { worker: "replay-board", path: join("apps", "board", "wrangler.jsonc"), ids: 3 },
      { worker: "replay-api", path: join("apps", "api", "wrangler.jsonc"), ids: 1 },
    ]);
  });

  test("--feature writes the generated config, and says those ids are not", async () => {
    const before = snapshot(dir);
    const report = await provisionFeature({
      projectDir: dir,
      capabilities: [full, shared],
      identity: { project: "replay", issue: "251", slug: "one-command" },
      provisioners: fakeProvisioners(),
      resolveWorkers: async () => workers(),
      ...noBackend,
    });

    assertSaysWhatItDid(dir, before, report);
    expect(report.committed).toBe(false);
    expect(report.configs).toEqual([
      { worker: "replay-board", path: join("apps", "board", ".wrangler", "pithy", "wrangler.feature.jsonc"), ids: 3 },
      { worker: "replay-api", path: join("apps", "api", ".wrangler", "pithy", "wrangler.feature.jsonc"), ids: 1 },
    ]);
  });
});
