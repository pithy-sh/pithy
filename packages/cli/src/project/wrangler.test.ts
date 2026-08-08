// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InternalError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readOptionalWranglerConfig, readWranglerConfig, runWrangler } from "./wrangler";

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
