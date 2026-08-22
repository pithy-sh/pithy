// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InternalError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readOptionalWranglerConfig, readWranglerConfig, runWrangler, workerEntryPath } from "./wrangler";

/** Use `node` as the binary so these run without wrangler installed. */
const NODE = "node";

/**
 * The read behind every `wrangler.jsonc` caller in the CLI — nineteen of them, and the one the ENOENT
 * gate could not see, because the scan recognises leaf reads and this is a wrapper (#204).
 *
 * It goes through `readOptionalFile` now, so the errno decision has one home rather than being made again
 * at whichever caller happened to catch. Absent and unreadable are different answers, and both are a
 * `PithyError` naming the file.
 */
describe("readWranglerConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-wrangler-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("parses the file, comments and all", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), '{\n  // a note\n  "name": "api"\n}\n');
    expect(await readWranglerConfig(dir)).toMatchObject({ name: "api" });
  });

  test("a directory with no wrangler.jsonc is a PithyError naming it, not node's raw ENOENT", async () => {
    const thrown = (await readWranglerConfig(dir).catch((error: unknown) => error)) as PithyError;
    expect(thrown).toBeInstanceOf(PithyError);
    expect(thrown.payload.message).toContain(join(dir, "wrangler.jsonc"));
    expect(thrown.payload.action ?? "").not.toBe("");
  });

  test("a wrangler.jsonc that is there and will not open is a different refusal from an absent one", async () => {
    // EISDIR for every uid, root included. Absent means ENOENT and nothing else — the decision lives in
    // `readOptionalFile`, and this wrapper is now inside that rule rather than outside it.
    await mkdir(join(dir, "wrangler.jsonc"));

    const thrown = (await readWranglerConfig(dir).catch((error: unknown) => error)) as PithyError;
    expect(thrown).toBeInstanceOf(PithyError);
    expect(thrown.payload.message).toContain(join(dir, "wrangler.jsonc"));
    expect(thrown.payload.detail).toContain("EISDIR");
    expect((thrown.cause as { code?: string } | undefined)?.code).toBe("EISDIR");
  });

  test("the optional read answers null for absent — and only for absent", async () => {
    // What `pithy env` needs: a Worker whose wrangler.jsonc vanished between discovery and the read drops
    // out of the inventory, and one that will not open still refuses rather than being reported as empty.
    expect(await readOptionalWranglerConfig(dir)).toBeNull();

    await mkdir(join(dir, "wrangler.jsonc"));
    await expect(readOptionalWranglerConfig(dir)).rejects.toThrow(PithyError);
  });
});

/**
 * **The module `main` names, which is the file a Durable Object's export has to land in (#428).**
 *
 * Every branch here is a decision `pithy add` and `pithy remove` act on, and the `null` one is the
 * refusal `add` raises by name. It had no test of its own: replacing `return null` with a guess at
 * `src/index.ts` left the whole `capabilities` + `project` suite green, so the branch was reachable only
 * in principle. A Worker with no `main` is a real Worker — a Vite frontend joins the dev set through
 * `pithy.worker.jsonc` alone — so the answer has to be the config's, never a guess.
 */
describe("workerEntryPath", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-entry-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("resolves main against the worker directory", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), '{\n  "name": "api",\n  "main": "src/index.ts"\n}\n');
    expect(await workerEntryPath(dir)).toBe(join(dir, "src/index.ts"));
  });

  test("a main the adopter has moved is followed, never assumed", async () => {
    // The whole reason this reads the config: a Worker carrying a front end has its entry written by the
    // Vite plugin, and guessing `src/index.ts` would put the export in a file nothing bundles.
    await writeFile(join(dir, "wrangler.jsonc"), '{\n  "name": "api",\n  "main": "worker/entry.ts"\n}\n');
    expect(await workerEntryPath(dir)).toBe(join(dir, "worker/entry.ts"));
  });

  test("no main is null — the Worker cannot say which module it is", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), '{\n  "name": "web"\n}\n');
    expect(await workerEntryPath(dir)).toBeNull();
  });

  test("a main that is not a string is null, not a path built out of a number", async () => {
    // `wrangler.jsonc` is the adopter's file and JSON holds any type. `join(dir, 42)` throws a raw
    // TypeError; the honest answer is that this config names no entry.
    await writeFile(join(dir, "wrangler.jsonc"), '{\n  "name": "api",\n  "main": 42\n}\n');
    expect(await workerEntryPath(dir)).toBeNull();
  });

  test("an empty main is null, not the worker directory itself", async () => {
    // `join(dir, "")` is `dir` — a directory, which `add` would then try to read as source and `remove`
    // would try to rewrite. Empty names no module.
    await writeFile(join(dir, "wrangler.jsonc"), '{\n  "name": "api",\n  "main": ""\n}\n');
    expect(await workerEntryPath(dir)).toBeNull();
  });

  test("no wrangler.jsonc at all refuses, rather than answering null", async () => {
    // The refusal is `readWranglerConfig`'s and stays its: a directory that is not a Worker is a
    // different fact from a Worker that names no entry, and only the second one is a value.
    await expect(workerEntryPath(dir)).rejects.toThrow(PithyError);
  });
});

describe("runWrangler", () => {
  test("resolves with captured stdout/stderr on a zero exit", async () => {
    await expect(runWrangler(["-e", "process.exit(0)"], { bin: NODE })).resolves.toEqual({ stdout: "", stderr: "" });
  });

  test("captures stdout so callers can scrape it (deploy reads the version id + url)", async () => {
    const { stdout } = await runWrangler(["-e", "process.stdout.write('Current Version ID: v1')"], { bin: NODE });
    expect(stdout).toContain("Version ID: v1");
  });

  test("rejects on a non-zero exit, surfacing the captured output in detail (quiet mode)", async () => {
    const error = (await runWrangler(["-e", "console.error('boom'); process.exit(1)"], { bin: NODE }).catch(
      (e: unknown) => e,
    )) as PithyError;
    expect(error).toBeInstanceOf(InternalError);
    expect(error.payload.detail).toContain("boom");
    expect(error.payload.detail).toContain("exit 1");
  });

  test("rejects with a clear error when the binary is missing", async () => {
    const error = (await runWrangler(["--version"], { bin: "pithy-no-such-binary-xyz" }).catch(
      (e: unknown) => e,
    )) as PithyError;
    expect(error).toBeInstanceOf(InternalError);
    expect(error.payload.action).toContain("installed");
  });

  test("passthrough mode resolves on success (nothing captured — output already streamed)", async () => {
    await expect(runWrangler(["-e", "process.exit(0)"], { bin: NODE, passthrough: true })).resolves.toEqual({
      stdout: "",
      stderr: "",
    });
  });

  test("passes extra env to the child — how wrangler gets CLOUDFLARE_API_TOKEN from .dev.vars", async () => {
    // The child exits 0 only when the injected env var is visible to it.
    await expect(
      runWrangler(["-e", "process.exit(process.env.PITHY_WRANGLER_TEST === 'ok' ? 0 : 1)"], {
        bin: NODE,
        env: { PITHY_WRANGLER_TEST: "ok" },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "" });
  });
});
