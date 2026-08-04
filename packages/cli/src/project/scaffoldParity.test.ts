// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION_METADATA_BINDING } from "@pithy-sh/core/src/worker/identity";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hasVersionMetadata } from "./versionMetadata";
import { scaffoldWorker } from "./workerScaffold";

/**
 * The two `wrangler.jsonc` producers, held together.
 *
 * A Pithy project's Workers come from two entirely separate code paths that share nothing.
 * `pithy init` copies `templates/starter/apps/api/wrangler.jsonc` and string-replaces three
 * placeholders; `pithy worker add` generates a file from an inline template string in
 * `workerScaffold.ts`. Nothing pinned them together, and they had already drifted — the added-Worker
 * template carries no `d1_databases`/`kv_namespaces` arrays where the starter does.
 *
 * That drift is not cosmetic. `CF_VERSION_METADATA` is the exact failure it produces: a reader shipped in
 * `createBackend`, was documented, was tested — and no template declared the binding, so a scaffolded
 * project's log records silently carried no `version` field at all. Two producers, one of them updated.
 *
 * So this file asserts the invariants that must hold in **both**, rather than in whichever one a change
 * happened to touch. It deliberately does not demand the files be identical: they legitimately differ.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTER_WRANGLER = resolve(HERE, "../../../../templates/starter/apps/api/wrangler.jsonc");

describe("both wrangler.jsonc producers", () => {
  let dir: string;
  let added: Record<string, unknown>;
  let starter: Record<string, unknown>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-scaffold-parity-"));
    const { dir: workerDir } = await scaffoldWorker({ projectDir: dir, name: "web", project: "acme" });
    added = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as Record<string, unknown>;
    starter = parse(await readFile(STARTER_WRANGLER, "utf8")) as unknown as Record<string, unknown>;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("declare the version-metadata binding under the name the runtime reads", () => {
    // The regression this file exists for. `hasVersionMetadata` keys on the binding *name*, so a block
    // naming anything else fails here exactly as an absent one does — it would bind a value nothing
    // consumes.
    expect(hasVersionMetadata(starter)).toBe(true);
    expect(hasVersionMetadata(added)).toBe(true);
    expect(VERSION_METADATA_BINDING).toBe("CF_VERSION_METADATA");
  });

  test("declare it at the top level, so every environment inherits one copy", () => {
    // `env.<name>` stanzas REPLACE rather than merge. A per-environment copy would be three places for
    // one build fact to drift in, and Cloudflare inherits the top-level declaration anyway.
    for (const config of [starter, added]) {
      const envs = (config.env ?? {}) as Record<string, Record<string, unknown>>;
      expect(Object.keys(envs).length).toBeGreaterThan(0);
      for (const stanza of Object.values(envs)) expect(stanza.version_metadata).toBeUndefined();
    }
  });

  test("stamp the same three identity vars into every environment stanza", () => {
    // The other thing a Worker cannot derive about itself, and the other thing one producer could
    // quietly stop emitting. `env.<name>.vars` replaces the top-level block, so every stanza repeats all
    // three or the ones it omits are simply absent in that environment.
    const stanzas = (config: Record<string, unknown>) => [
      config,
      ...Object.values((config.env ?? {}) as Record<string, Record<string, unknown>>),
    ];

    for (const config of [starter, added]) {
      for (const stanza of stanzas(config)) {
        const vars = stanza.vars as Record<string, string> | undefined;
        expect(Object.keys(vars ?? {}).sort()).toEqual(["ENVIRONMENT", "PROJECT", "WORKER"]);
      }
    }
  });

  test("declare the same environments, so a capability lands everywhere in both", () => {
    expect(Object.keys((added.env ?? {}) as object).sort()).toEqual(Object.keys((starter.env ?? {}) as object).sort());
  });
});
