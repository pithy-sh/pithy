// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_READY_SIGNAL,
  DEV_PORT_TOKEN,
  defaultWorkerDev,
  parseWorkerManifest,
  WorkerDev,
  WorkerManifest,
  WorkerUi,
} from "./workerManifest";

describe("WorkerManifest", () => {
  // The manifest has no say in whether a worker starts any more (#548). It describes how a worker is
  // run — its ready signal, its command — and nothing it can contain keeps a worker out of the dev set.
  test("a parsed dev block carries no autostart at all", () => {
    expect(WorkerManifest.parse({}).dev).toEqual({ readySignal: DEFAULT_READY_SIGNAL });
    expect(WorkerManifest.parse({ dev: { readySignal: "Local:\\s+http" } }).dev).toEqual({
      readySignal: "Local:\\s+http",
    });
  });

  // Refused whatever its value. The key decides nothing now, and a `z.object` would strip it in
  // silence — which for `false` means starting a worker its owner had turned off, the loudest version
  // of the bug #536 fixed. One project exists and it has one such key; the refusal is how it gets
  // deleted rather than quietly ignored forever.
  test.each([true, false])("an autostart key is refused, whatever its value (%s)", (value) => {
    const result = WorkerManifest.safeParse({ dev: { autostart: value, readySignal: "x" } });

    expect(result.success).toBe(false);
    const message = JSON.stringify(result.error?.issues);
    expect(message).toContain("dev.autostart was removed");
    expect(message).toContain("--disable-autostart");
  });

  test("keeps a declared command and preferredPort", () => {
    const manifest = WorkerManifest.parse({
      dev: { command: ["bun", "run", "dev"], preferredPort: 5173 },
    });
    expect(manifest.dev).toEqual({
      readySignal: DEFAULT_READY_SIGNAL,
      command: ["bun", "run", "dev"],
      preferredPort: 5173,
    });
  });

  test("rejects a non-positive preferredPort", () => {
    expect(WorkerManifest.safeParse({ dev: { preferredPort: 0 } }).success).toBe(false);
  });

  test("has no ui block until one is declared, and keeps it verbatim when it is", () => {
    expect(WorkerManifest.parse({}).ui).toBeUndefined();
    expect(
      WorkerManifest.parse({
        dev: { command: ["bun", "x", "vite", "dev", "--port", DEV_PORT_TOKEN] },
        ui: { stub: "react", build: ["vite", "build"] },
      }).ui,
    ).toEqual({ stub: "react", build: ["vite", "build"] });
  });

  test("rejects a ui block with an empty build argv or a missing stub", () => {
    expect(WorkerUi.safeParse({ stub: "react", build: [] }).success).toBe(false);
    expect(WorkerUi.safeParse({ stub: "", build: ["vite", "build"] }).success).toBe(false);
    expect(WorkerUi.safeParse({ build: ["vite", "build"] }).success).toBe(false);
  });

  test("every field of the ui block documents itself — the manifest is the documentation", () => {
    expect(WorkerUi.description).toBeTruthy();
    for (const field of Object.values(WorkerUi.shape)) expect(field.description).toBeTruthy();
  });

  test("the port token is documented on dev.command, so the schema teaches it", () => {
    expect(WorkerDev.shape.command.description).toContain(DEV_PORT_TOKEN);
  });
});

describe("defaultWorkerDev", () => {
  test("reports exactly the schema's own defaults", () => {
    expect(defaultWorkerDev()).toEqual({ readySignal: DEFAULT_READY_SIGNAL });
  });
});

describe("parseWorkerManifest", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-manifest-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns null when the file is absent", async () => {
    expect(await parseWorkerManifest(dir)).toBeNull();
  });

  test("parses a commented JSONC manifest", async () => {
    await writeFile(join(dir, "pithy.worker.jsonc"), '{\n  // the api worker\n  "dev": { "preferredPort": 8787 }\n}\n');
    const manifest = await parseWorkerManifest(dir);
    expect(manifest?.dev.preferredPort).toBe(8787);
  });

  test("reads the ui block a worker's front end declares", async () => {
    await writeFile(
      join(dir, "pithy.worker.jsonc"),
      JSON.stringify({
        dev: { command: ["bun", "x", "vite", "dev", "--strictPort", "--port", "{port}"] },
        ui: { stub: "react", build: ["vite", "build"] },
      }),
    );
    const manifest = await parseWorkerManifest(dir);
    expect(manifest?.ui).toEqual({ stub: "react", build: ["vite", "build"] });
    expect(manifest?.dev.command).toContain("{port}");
  });

  test("throws on a ui block with an empty build", async () => {
    await writeFile(join(dir, "pithy.worker.jsonc"), JSON.stringify({ ui: { stub: "react", build: [] } }));
    await expect(parseWorkerManifest(dir)).rejects.toThrow(/invalid/);
  });

  test("throws on invalid JSONC", async () => {
    await writeFile(join(dir, "pithy.worker.jsonc"), "{ not json ");
    await expect(parseWorkerManifest(dir)).rejects.toThrow(/not valid JSONC/);
  });

  test("throws on a schema violation", async () => {
    await writeFile(join(dir, "pithy.worker.jsonc"), JSON.stringify({ dev: { readySignal: 42 } }));
    await expect(parseWorkerManifest(dir)).rejects.toThrow(/invalid/);
  });

  test("tolerates an unrelated apps subdir path", async () => {
    await mkdir(join(dir, "nested"), { recursive: true });
    expect(await parseWorkerManifest(join(dir, "nested"))).toBeNull();
  });
});
