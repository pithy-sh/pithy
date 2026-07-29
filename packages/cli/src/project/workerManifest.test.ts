import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_READY_SIGNAL, defaultWorkerDev, parseWorkerManifest, WorkerManifest } from "./workerManifest";

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
