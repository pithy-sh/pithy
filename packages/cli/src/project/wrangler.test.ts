import { InternalError, type PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { runWrangler } from "./wrangler";

/** Use `node` as the binary so these run without wrangler installed. */
const NODE = "node";

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
