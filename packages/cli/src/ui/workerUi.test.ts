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

  test("a manifest that parses to something other than an object is refused by name, not read as empty", async () => {
    // The last path in this family from "the read succeeded" to "start from an empty base": valid JSONC
    // that is not an object. `{}` here is what `writeManifestDocument` renames over the adopter's file.
    const path = join(dir, "pithy.worker.jsonc");
    await writeFile(path, "[1, 2, 3]\n");

    const thrown = (await readManifestDocument(dir).catch((error: unknown) => error)) as PithyError;
    expect(thrown).toBeInstanceOf(PithyError);
    // The file, and what was found in it — never a byte of what it holds.
    expect(thrown.payload.message).toContain(path);
    expect(thrown.payload.message).toContain("array");
    expect(thrown.payload.action ?? "").not.toBe("");
    // And the same refusal through the question `pithy ui add` gates on before it writes anything.
    await expect(readWorkerUi(dir)).rejects.toThrow(PithyError);
    // Nothing was written over it.
    expect(await readFile(path, "utf8")).toBe("[1, 2, 3]\n");
  });

  test("a manifest holding `null`, or a bare primitive, is not an absent one either", async () => {
    // `null` is the shape that reached `{}` most directly: `typeof null === "object"` is the check that
    // was meant to stop it and does not. The primitives are the second half of the same mistake —
    // comment-json boxes a top-level scalar so it has somewhere to hang the file's comments, so
    // `parse('"react"')` is a `String` *object* and `typeof` calls it one too.
    for (const source of ["null\n", '"react"\n', "42\n", "true\n"]) {
      await writeFile(join(dir, "pithy.worker.jsonc"), source);
      await expect(readManifestDocument(dir), source).rejects.toThrow(PithyError);
    }
  });

  /**
   * The last thing this reader decided for itself (#222).
   *
   * It refuses on every failure it can see now — unopenable, unparseable, not a record — and then **cast**
   * what survived to `ManifestDocument`, a type that claims `dev` and `ui` are objects. A manifest whose
   * `ui` is the string `"react"` reached the merge as if it were valid, `pithy ui add` assigned into it,
   * and `stringify` renamed the result over the adopter's file. A cast is the assertion no test can fail.
   *
   * So it takes the merge-base read like its two siblings, and the schema is what the type used to claim.
   */
  test("a manifest whose blocks are not objects is refused rather than cast into shape", async () => {
    const path = join(dir, "pithy.worker.jsonc");
    const held = '{\n  "name": "api",\n  "ui": "react"\n}\n';
    await writeFile(path, held);

    const thrown = (await readManifestDocument(dir).catch((error: unknown) => error)) as PithyError;
    expect(thrown).toBeInstanceOf(PithyError);
    expect(thrown.payload.message).toContain(path);
    // The key that broke, so the line can be found.
    expect(thrown.payload.detail ?? "").toContain("ui");
    expect(thrown.payload.action ?? "").not.toBe("");
    // And the same refusal through the question `pithy ui add` gates on before it writes anything.
    await expect(readWorkerUi(dir)).rejects.toThrow(PithyError);
    expect(await readFile(path, "utf8")).toBe(held);
  });

  test("no refusal quotes a line of the file — not in message, and not in detail either", async () => {
    // #219 drops the parser's own error rather than carrying it, because every parser in this family
    // quotes the line it choked on. This reader used to put comment-json's message straight into `detail`.
    const path = join(dir, "pithy.worker.jsonc");
    for (const source of ['{ "bindings": { "DB": "a-binding-NAME" }', '"a-binding-NAME"\n', '{ "ui": 7 }\n']) {
      await writeFile(path, source);
      const thrown = (await readManifestDocument(dir).catch((error: unknown) => error)) as PithyError;
      expect(thrown, source).toBeInstanceOf(PithyError);
      expect(thrown.payload.message, source).toContain(path);
      expect(JSON.stringify(thrown.payload), source).not.toContain("a-binding-NAME");
    }
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
