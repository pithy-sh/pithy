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
  test("applies defaults for an empty dev block", () => {
    const manifest = WorkerManifest.parse({});
    expect(manifest.dev).toEqual({ autostart: false, readySignal: DEFAULT_READY_SIGNAL });
  });

  test("keeps a declared command and preferredPort", () => {
    const manifest = WorkerManifest.parse({
      dev: { autostart: true, command: ["bun", "run", "dev"], preferredPort: 5173 },
    });
    expect(manifest.dev).toEqual({
      autostart: true,
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
        dev: { autostart: true, command: ["bun", "x", "vite", "dev", "--port", DEV_PORT_TOKEN] },
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
  test("autostarts with wrangler's ready signal", () => {
    expect(defaultWorkerDev()).toEqual({ autostart: true, readySignal: DEFAULT_READY_SIGNAL });
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
    await writeFile(
      join(dir, "pithy.worker.jsonc"),
      '{\n  // the api worker\n  "dev": { "autostart": true, "preferredPort": 8787 }\n}\n',
    );
    const manifest = await parseWorkerManifest(dir);
    expect(manifest?.dev.autostart).toBe(true);
    expect(manifest?.dev.preferredPort).toBe(8787);
  });

  test("reads the ui block a worker's front end declares", async () => {
    await writeFile(
      join(dir, "pithy.worker.jsonc"),
      JSON.stringify({
        dev: { autostart: true, command: ["bun", "x", "vite", "dev", "--strictPort", "--port", "{port}"] },
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
    await writeFile(join(dir, "pithy.worker.jsonc"), JSON.stringify({ dev: { autostart: "yes" } }));
    await expect(parseWorkerManifest(dir)).rejects.toThrow(/invalid/);
  });

  test("tolerates an unrelated apps subdir path", async () => {
    await mkdir(join(dir, "nested"), { recursive: true });
    expect(await parseWorkerManifest(join(dir, "nested"))).toBeNull();
  });
});
