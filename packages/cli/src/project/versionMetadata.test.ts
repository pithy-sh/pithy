// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyVersionMetadata, hasVersionMetadata, VERSION_METADATA_KEY } from "./versionMetadata";

async function worker(wrangler: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pithy-version-metadata-"));
  await writeFile(path.join(dir, "wrangler.jsonc"), wrangler, "utf8");
  return dir;
}

describe("hasVersionMetadata", () => {
  it("recognises the declaration the runtime actually reads", () => {
    expect(hasVersionMetadata({ version_metadata: { binding: "CF_VERSION_METADATA" } })).toBe(true);
  });

  it("reports a differently-named binding as absent, because that is what it is", () => {
    // The binding name is the join between the wrangler declaration and the code that reads it.
    // `VERSION_DATA` binds a value nothing consumes and leaves the logger exactly as blind as no
    // declaration at all, so it must not read as satisfied.
    expect(hasVersionMetadata({ version_metadata: { binding: "VERSION_DATA" } })).toBe(false);
    expect(hasVersionMetadata({ version_metadata: {} })).toBe(false);
  });

  it("never throws on a config that is not an object", () => {
    for (const config of [null, undefined, "wrangler", 7, []]) {
      expect(() => hasVersionMetadata(config)).not.toThrow();
      expect(hasVersionMetadata(config)).toBe(false);
    }
  });
});

describe("applyVersionMetadata", () => {
  it("declares the binding on a Worker scaffolded before it existed", async () => {
    const dir = await worker('{\n  "name": "acme-api",\n  "main": "src/index.ts"\n}\n');

    expect(await applyVersionMetadata(dir)).toBe(true);
    const written = JSON.parse(await readFile(path.join(dir, "wrangler.jsonc"), "utf8"));
    expect(written[VERSION_METADATA_KEY]).toEqual({ binding: "CF_VERSION_METADATA" });
    expect(written.name).toBe("acme-api");
  });

  it("is idempotent — a second run changes nothing", async () => {
    const dir = await worker('{\n  "name": "acme-api"\n}\n');

    expect(await applyVersionMetadata(dir)).toBe(true);
    const first = await readFile(path.join(dir, "wrangler.jsonc"), "utf8");
    expect(await applyVersionMetadata(dir)).toBe(false);
    expect(await readFile(path.join(dir, "wrangler.jsonc"), "utf8")).toBe(first);
  });

  it("never overwrites a binding the adopter named themselves", async () => {
    // Repointing a binding they may be reading is not a repair, it is a silent breakage. Report the
    // drift; leave the decision with them.
    const dir = await worker('{\n  "version_metadata": { "binding": "VERSION_DATA" }\n}\n');

    expect(await applyVersionMetadata(dir)).toBe(false);
    const written = JSON.parse(await readFile(path.join(dir, "wrangler.jsonc"), "utf8"));
    expect(written.version_metadata).toEqual({ binding: "VERSION_DATA" });
  });

  it("declines rather than throws for a Worker with no wrangler.jsonc", async () => {
    // A Vite frontend joins the dev set through pithy.worker.jsonc and never deploys, so it has no
    // wrangler.jsonc — and it still reaches the reconcile plan. Throwing here would abort the whole
    // `pithy upgrade --apply` run and take every Worker after it in discovery order with it.
    const { mkdtemp } = await import("node:fs/promises");
    const empty = await mkdtemp(path.join(tmpdir(), "pithy-version-metadata-none-"));
    expect(await applyVersionMetadata(empty)).toBe(false);
  });

  it("declines rather than throws for an unparseable wrangler.jsonc", async () => {
    const dir = await worker("{ this is not json");
    expect(await applyVersionMetadata(dir)).toBe(false);
  });

  it("preserves the adopter's comments", async () => {
    const dir = await worker('{\n  // keep me\n  "name": "acme-api"\n}\n');

    await applyVersionMetadata(dir);
    expect(await readFile(path.join(dir, "wrangler.jsonc"), "utf8")).toContain("// keep me");
  });
});
