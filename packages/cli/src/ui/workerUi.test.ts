import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readManifestDocument, readWorkerUi, uiBlock, writeManifestDocument } from "./workerUi";

describe("the ui block of pithy.worker.jsonc", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-ui-manifest-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a missing manifest reads as an empty document, not an error", async () => {
    expect(await readManifestDocument(dir)).toEqual({});
    expect(await readWorkerUi(dir)).toBeNull();
  });

  test("reads the block from raw JSONC, whatever the Zod manifest schema declares", async () => {
    await writeFile(
      join(dir, "pithy.worker.jsonc"),
      '{\n  // a note\n  "dev": { "autostart": true },\n  "ui": { "stub": "react", "build": ["vite", "build"] }\n}\n',
    );
    expect(await readWorkerUi(dir)).toEqual({ stub: "react", build: ["vite", "build"] });
  });

  test("a worker with a dev block but no ui block has no front end", async () => {
    await writeFile(join(dir, "pithy.worker.jsonc"), '{\n  "dev": { "autostart": true }\n}\n');
    expect(await readWorkerUi(dir)).toBeNull();
  });

  test("a malformed manifest surfaces rather than being silently defaulted", async () => {
    await writeFile(join(dir, "pithy.worker.jsonc"), "{ not json");
    await expect(readManifestDocument(dir)).rejects.toThrow(PithyError);
  });

  test("writes back comment-preserving, 2-space, trailing newline", async () => {
    await writeFile(join(dir, "pithy.worker.jsonc"), '{\n  // keep me\n  "dev": { "autostart": false }\n}\n');
    const document = await readManifestDocument(dir);
    document.ui = { stub: "react", build: ["vite", "build"] };
    await writeManifestDocument(dir, document);

    const raw = await readFile(join(dir, "pithy.worker.jsonc"), "utf8");
    expect(raw).toContain("// keep me");
    expect(raw.endsWith("\n")).toBe(true);
    expect(uiBlock(await readManifestDocument(dir))).toEqual({ stub: "react", build: ["vite", "build"] });
  });
});
