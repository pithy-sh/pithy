// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "comment-json";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { formatJsonc, JSONC_LINE_WIDTH, writeJsonc } from "./jsonc";
import { resolveTemplateSource } from "./scaffold";

/**
 * The printer's own tests, and the one that decides whether it works: **Biome, run over the output.**
 *
 * Every other assertion here is Pithy's opinion about its own bytes. That one is the invariant #249 is
 * about — a file the CLI writes is a file the formatter the CLI scaffolds would print unchanged — and it
 * is checked by asking the formatter rather than by encoding what somebody believed it does.
 */

/** The repo root — three up from `packages/cli/src/project`'s parent — and the workspace's Biome. */
const BIOME = join(import.meta.dirname, "..", "..", "..", "..", "node_modules", ".bin", "biome");

/** The starter, for the two real files the CLI edits. */
const STARTER = resolveTemplateSource(import.meta.dirname).dir;

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-jsonc-"));
  // The starter's Biome, so the corpus is judged by the config an adopter actually gets — with the Grit
  // plugins it names beside it, or it refuses to load at all.
  await writeFile(join(dir, "biome.jsonc"), await readFile(join(STARTER, "biome.template.jsonc")));
  await cp(join(STARTER, "plugins"), join(dir, "plugins"), { recursive: true });
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Would the scaffolded Biome reprint `text`? Empty means no — the bytes are already what it prints. */
async function biomeWouldReprint(text: string): Promise<string> {
  const path = join(dir, "subject.jsonc");
  await writeFile(path, text);
  return new Promise((resolve, reject) => {
    // `--files-ignore-unknown` off on purpose: a config that stopped matching `.jsonc` would otherwise
    // make every case here pass by checking nothing.
    const child = spawn(BIOME, ["format", "subject.jsonc"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code === 0 ? "" : output));
  });
}

describe("the printer agrees with the formatter the kit scaffolds", () => {
  test("Biome is where this gate's answers come from", async () => {
    // The control. If Biome cannot be reached, or stops reading `.jsonc`, every case below would pass
    // while proving nothing — so one case is a text Biome is known to reject.
    expect(await biomeWouldReprint('{\n  "a": [\n    1\n  ]\n}\n')).toContain("Formatter would have printed");
  });

  const CORPUS: Record<string, unknown> = {
    "a short array": { compatibility_flags: ["nodejs_compat"] },
    "an array past the width": {
      run_worker_first: [
        "/auth",
        "/auth/*",
        "/control-plane",
        "/control-plane/*",
        "/health",
        "/health/*",
        "/payments",
        "/payments/*",
        "/support",
        "/support/*",
      ],
    },
    "an empty array": { d1_databases: [], kv_namespaces: [] },
    "a nested object": { assets: { not_found_handling: "single-page-application", run_worker_first: ["/health"] } },
    "an array of one-key objects": { references: [{ path: "./a.json" }, { path: "./b.json" }] },
    "an array of many-key objects": {
      d1_databases: [
        { binding: "DB", database_name: "replay-dev-db", database_id: "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d" },
        {
          binding: "COLLAB_DB",
          database_name: "replay-dev-collab",
          database_id: "9f8e7d6c-5b4a-3928-1706-5f4e3d2c1b0a",
        },
      ],
    },
    // Prettier breaks an array whose elements are all multi-key objects, whatever it measures. Biome is
    // Prettier-compatible, so whether it inherited that rule decides whether this printer needs it.
    "a short array of multi-key objects": {
      routes: [
        { pattern: "api.example.com", zone: "example.com" },
        { pattern: "app.example.com", zone: "example.com" },
      ],
    },
    "a value at the width": { key: [`${"x".repeat(JSONC_LINE_WIDTH - 16)}`] },
    "a value one past it": { key: [`${"x".repeat(JSONC_LINE_WIDTH - 15)}`] },
    "nothing at all": {},
  };

  for (const [name, value] of Object.entries(CORPUS)) {
    test(`${name} is printed the way Biome prints it`, async () => {
      expect(await biomeWouldReprint(formatJsonc(value))).toBe("");
    });
  }

  test("the starter's own files survive a round trip through the printer", async () => {
    for (const file of ["apps/api/wrangler.jsonc", "apps/api/pithy.worker.jsonc"]) {
      const original = await readFile(join(STARTER, file), "utf8");
      const printed = formatJsonc(parse(original), original);
      expect(printed, file).toBe(original);
      expect(await biomeWouldReprint(printed), file).toBe("");
    }
  });
});

describe("what the printer decides", () => {
  test("an array is one line when it fits and one element per line when it does not", () => {
    expect(formatJsonc({ flags: ["a", "b"] })).toBe('{\n  "flags": ["a", "b"]\n}\n');
    const long = Array.from({ length: 20 }, (_, index) => `/route-${index}`);
    expect(formatJsonc({ flags: long })).toContain('"flags": [\n    "/route-0",\n');
  });

  test("an object keeps the shape the previous bytes had", () => {
    const previous = '{\n  "wide": {\n    "a": 1\n  },\n  "tight": { "b": 2 }\n}\n';
    const printed = formatJsonc({ wide: { a: 1 }, tight: { b: 2 } }, previous);
    expect(printed).toBe(previous);
  });

  test("an object Pithy is adding has no shape to keep, and collapses if it fits", () => {
    const previous = '{\n  "kept": { "a": 1 }\n}\n';
    const printed = formatJsonc({ kept: { a: 1 }, added: { b: 2 } }, previous);
    expect(printed).toBe('{\n  "kept": { "a": 1 },\n  "added": { "b": 2 }\n}\n');
  });

  test("the document's top level is never collapsed, however short it is", () => {
    expect(formatJsonc({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  test("a span holding a comment is left alone — a joined line would swallow what follows the slashes", () => {
    const previous = '{\n  "flags": [\n    // why this one\n    "nodejs_compat"\n  ]\n}\n';
    const printed = formatJsonc(parse(previous), previous);
    expect(printed).toBe(previous);
    expect(printed).toContain("// why this one\n");
  });

  test("an adopter's comment survives an edit to the value beside it", () => {
    const previous = '{\n  // The adopter\'s note.\n  "assets": {\n    "run_worker_first": ["/health"]\n  }\n}\n';
    const document = parse(previous) as unknown as { assets: { run_worker_first: string[] } };
    document.assets.run_worker_first.push("/health/*");
    const printed = formatJsonc(document, previous);
    expect(printed).toContain("// The adopter's note.");
    expect(printed).toContain('"run_worker_first": ["/health", "/health/*"]');
  });

  test("what goes in comes out — the printer is a printer, not an editor", () => {
    const value = {
      name: "replay-board",
      vars: { ENVIRONMENT: "dev", PROJECT: "replay" },
      env: { staging: { d1_databases: [{ binding: "DB" }] } },
      empty: {},
      list: [],
    };
    expect(parse(formatJsonc(value))).toEqual(value);
  });
});

describe("writeJsonc", () => {
  test("a file with no previous bytes is written, and read back as what went in", async () => {
    const path = join(dir, "new.jsonc");
    await writeJsonc(path, { a: [1, 2] });
    expect(await readFile(path, "utf8")).toBe('{\n  "a": [1, 2]\n}\n');
  });

  test("the previous bytes are the oracle, and no caller has to remember to pass them", async () => {
    const path = join(dir, "existing.jsonc");
    await writeFile(path, '{\n  "wide": {\n    "a": 1\n  }\n}\n');
    await writeJsonc(path, { wide: { a: 1 }, b: 2 });
    expect(await readFile(path, "utf8")).toBe('{\n  "wide": {\n    "a": 1\n  },\n  "b": 2\n}\n');
  });
});
