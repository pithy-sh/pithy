// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { recordSemanticBindings } from "./support";

/**
 * What `pithy support provision` writes into the app Worker's `wrangler.jsonc` for the semantic message index:
 * the `SUPPORT_VECTORIZE` entry, per environment, naming that environment's index while semantic search is on,
 * and gone once the index is dropped or semantic search is off.
 */

interface Stanza {
  vectorize?: { binding: string; index_name?: string; remote?: boolean }[];
}
interface Wrangler extends Stanza {
  env?: Record<string, Stanza | undefined>;
}

const fixture = `{
  "name": "pithy-app",
  "main": "src/index.ts",
  "d1_databases": [{ "binding": "DB" }],
  "env": {
    "staging": { "d1_databases": [{ "binding": "DB" }] },
    "prod": { "d1_databases": [{ "binding": "DB" }] }
  }
}
`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-support-semantic-"));
  await writeFile(join(dir, "wrangler.jsonc"), fixture);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = async (): Promise<Wrangler> =>
  parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as Wrangler;

const on = { search: { semantic: true } };
const off = { search: { semantic: false } };

describe("recordSemanticBindings", () => {
  test("on: writes each environment's entry with that environment's index name", async () => {
    await recordSemanticBindings(dir, on, [
      { env: "staging", indexName: "acme-staging-support-messages", dropped: false },
      { env: "prod", indexName: "acme-prod-support-messages", dropped: false },
    ]);
    const config = await read();
    expect(config.env?.staging?.vectorize).toEqual([
      { binding: "SUPPORT_VECTORIZE", index_name: "acme-staging-support-messages", remote: true },
    ]);
    expect(config.env?.prod?.vectorize).toEqual([
      { binding: "SUPPORT_VECTORIZE", index_name: "acme-prod-support-messages", remote: true },
    ]);
  });

  test("a dropped index loses its entry, and the other environment keeps its own", async () => {
    await recordSemanticBindings(dir, on, [
      { env: "staging", indexName: "acme-staging-support-messages", dropped: false },
      { env: "prod", indexName: "acme-prod-support-messages", dropped: false },
    ]);
    await recordSemanticBindings(dir, on, [
      { env: "staging", indexName: "acme-staging-support-messages", dropped: true },
    ]);
    const config = await read();
    expect(config.env?.staging?.vectorize ?? []).toEqual([]);
    expect(config.env?.prod?.vectorize?.map((entry) => entry.index_name)).toEqual(["acme-prod-support-messages"]);
  });

  test("off: removes the entry, and writes none where there was none", async () => {
    await recordSemanticBindings(dir, on, [
      { env: "staging", indexName: "acme-staging-support-messages", dropped: false },
    ]);
    await recordSemanticBindings(dir, off, [
      { env: "staging", indexName: "acme-staging-support-messages", dropped: false },
      { env: "prod", indexName: "acme-prod-support-messages", dropped: false },
    ]);
    const config = await read();
    expect(config.env?.staging?.vectorize ?? []).toEqual([]);
    expect(config.env?.prod?.vectorize).toBeUndefined();
  });

  test("a semantic config of its own model counts as on", async () => {
    await recordSemanticBindings(dir, { search: { semantic: { model: "@cf/custom", dimensions: 768 } } }, [
      { env: "prod", indexName: "acme-prod-support-messages", dropped: false },
    ]);
    expect((await read()).env?.prod?.vectorize?.map((entry) => entry.binding)).toEqual(["SUPPORT_VECTORIZE"]);
  });
});
