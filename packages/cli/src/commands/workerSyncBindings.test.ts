// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { scaffoldProject } from "../project/scaffold";
import { linkKitPackages } from "../test-utils/linkKit";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";

/** An app capability declaring its own database and bucket, the way `pithy-sh/stats` does. */
const APP_CONFIG = `import { defineCapability } from "@pithy-sh/core/src/capability/capability";

const app = defineCapability({
  name: "app",
  requiredBindings: [
    { type: "d1", name: "DB" },
    { type: "r2", name: "PUBLISHED" },
  ],
});

export default { capabilities: [], app };
`;

interface Stanza {
  d1_databases?: { binding: string; database_name?: string }[];
  r2_buckets?: { binding: string }[];
}
type Config = Stanza & { env?: Record<string, Stanza> };

let dir: string;
let worker: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-worker-sync-bindings-"));
  // A project and a worker whose names differ, so a name composed from the wrong one shows.
  await scaffoldProject({ targetDir: dir, appName: "replay", worker: "board" });
  await linkKitPackages(dir, ["core"]);
  worker = join(dir, "apps", "board");
  await writeFile(join(worker, "pithy.config.ts"), APP_CONFIG);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const read = async (): Promise<Config> =>
  parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as Config;

describe("pithy worker sync writes the app's own resource bindings", () => {
  test("D1 and R2 land in every stanza, with no upgrade and no hand edit, and a second run changes nothing", async () => {
    const before = await read();
    const envs = ["dev", ...Object.keys(before.env ?? {})];
    expect(envs.length).toBeGreaterThan(1);

    const first = await runCaptured("worker sync", ["--worker", "board", "--json"]);
    await expectConforms("worker sync", first);
    const config = await read();
    for (const env of envs) {
      const stanza = env === "dev" ? config : config.env?.[env];
      expect(stanza?.d1_databases).toEqual([{ binding: "DB", database_name: `replay-${env}-db` }]);
      expect(stanza?.r2_buckets).toEqual([{ binding: "PUBLISHED" }]);
    }
    const payload = JSON.parse(first.join("")) as {
      bindings: { env: string; written: { binding: string; type: string }[]; skipped: unknown[] }[];
    };
    expect(payload.bindings.map((run) => run.env)).toEqual(envs);
    expect(payload.bindings[0]?.written).toEqual([
      { binding: "DB", type: "d1" },
      { binding: "PUBLISHED", type: "r2" },
    ]);

    const written = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    vi.restoreAllMocks();
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const second = await runCaptured("worker sync", ["--worker", "board"]);
    expect(second.join("")).toContain("board is already in sync.");
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(written);
  });

  test("says which bindings each environment gained", async () => {
    const lines = (await runCaptured("worker sync", ["--worker", "board", "--env", "staging"])).join("");
    expect(lines).toContain("staging: DB, PUBLISHED written.");
    // `--env staging` writes staging alone.
    expect((await read()).d1_databases ?? []).toEqual([]);
  });

  test("refuses, writing nothing, when the Worker's declinedBindings cannot be read", async () => {
    await writeFile(
      join(worker, "pithy.config.ts"),
      APP_CONFIG.replace("{ capabilities: [], app }", "{ capabilities: [], app, declinedBindings: { PUBLISHED: 42 } }"),
    );
    const before = await readFile(join(worker, "wrangler.jsonc"), "utf8");
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    await expect(runCaptured("worker sync", ["--worker", "board"])).rejects.toThrow(/exit/);
    expect(errors.join("")).toContain("This Worker's `declinedBindings` declaration is not valid.");
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(before);
  });
});
