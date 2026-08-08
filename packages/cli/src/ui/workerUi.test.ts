// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  test("a manifest that is there and will not open refuses — it is not an empty document", async () => {
    // The #142 shape with a different file name: `{}` here, and `writeManifestDocument` renames a
    // document holding only `dev` and `ui` over a file full of the adopter's other blocks. A directory
    // where the file should be is EISDIR for every uid, so this says the same thing as root.
    const path = join(dir, "pithy.worker.jsonc");
    await mkdir(path);

    const thrown = (await readManifestDocument(dir).catch((error: unknown) => error)) as PithyError;
    expect(thrown).toBeInstanceOf(PithyError);
    expect(thrown.payload.message).toContain(path);
    expect(thrown.payload.detail).toContain("EISDIR");
    // The same refusal through the "does this worker already have a UI?" question, which is what
    // `pithy ui add` gates on before it writes anything.
    await expect(readWorkerUi(dir)).rejects.toThrow(PithyError);
  });

  test("every block this writer does not own survives a read-modify-write", async () => {
    // A writer that reads, merges and renames must round-trip every key it did not come to change.
    // An unreadable file is one way to lose the adopter's other blocks; a lossy rebuild is another.
    await writeFile(
      join(dir, "pithy.worker.jsonc"),
      '{\n  "name": "api",\n  "bindings": { "DB": "pithy-db" },\n  "dev": { "autostart": false }\n}\n',
    );

    const document = await readManifestDocument(dir);
    document.dev = { autostart: true };
    document.ui = { stub: "react", build: ["vite", "build"] };
    await writeManifestDocument(dir, document);

    expect(await readManifestDocument(dir)).toEqual({
      name: "api",
      bindings: { DB: "pithy-db" },
      dev: { autostart: true },
      ui: { stub: "react", build: ["vite", "build"] },
    });
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
