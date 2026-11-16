// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { UNSEEN_WORKER_WAIT_MS, unseenWorker, withUnseenWorkerRetry } from "./unseenWorkerRetry";

/** wrangler's failure for a Worker Cloudflare has not propagated yet, as `runWrangler` raises it. */
function notYetVisible(script: string): InternalError {
  return new InternalError({
    message: [
      "wrangler deploy failed.",
      `  ✘ [ERROR] A request to the Cloudflare API (/accounts/abc123/workers/workers/${script}) failed.`,
      "",
      "    This Worker does not exist on your account. [code: 10007]",
    ].join("\n"),
    detail: "exit 1",
  });
}

describe("unseenWorker", () => {
  test("is 10007 on /workers/workers/<the script>", () => {
    expect(unseenWorker(notYetVisible("dash-prod-audit"), "dash-prod-audit")).toBe(true);
  });

  test("reads the error's detail too, where a captured stderr lands", () => {
    const error = new InternalError({
      message: "wrangler deploy failed.",
      detail:
        "exit 1\nA request to the Cloudflare API (/accounts/abc/workers/workers/acme-web) failed. This Worker does not exist on your account. [code: 10007]",
    });
    expect(unseenWorker(error, "acme-web")).toBe(true);
  });

  test("is not 10007 on another script, nor on a script whose name only starts the same", () => {
    expect(unseenWorker(notYetVisible("dash-prod-audit"), "dash-prod")).toBe(false);
    expect(unseenWorker(notYetVisible("dash-prod-audit-2"), "dash-prod-audit")).toBe(false);
  });

  test("is not another code on that path, nor 10007 on another endpoint", () => {
    const otherCode = new InternalError({
      message: "✘ [ERROR] A request to the Cloudflare API (/accounts/a/workers/workers/acme-web) failed. [code: 10021]",
    });
    const otherPath = new InternalError({
      message: "✘ [ERROR] A request to the Cloudflare API (/accounts/a/workers/scripts/acme-web) failed. [code: 10007]",
    });
    expect(unseenWorker(otherCode, "acme-web")).toBe(false);
    expect(unseenWorker(otherPath, "acme-web")).toBe(false);
  });

  test("reads a plain Error's message", () => {
    expect(unseenWorker(new Error("(/accounts/a/workers/workers/acme-web) failed. [code: 10007]"), "acme-web")).toBe(
      true,
    );
  });
});

describe("withUnseenWorkerRetry", () => {
  test("runs once more, after the wait, when the first attempt meets an unseen Worker", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const result = await withUnseenWorkerRetry(
      "acme-web",
      async () => {
        attempts += 1;
        if (attempts === 1) throw notYetVisible("acme-web");
        return "ok";
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(waits).toEqual([UNSEEN_WORKER_WAIT_MS]);
  });

  test("a second unseen Worker fails with that error, and there is no third attempt", async () => {
    let attempts = 0;
    const second = notYetVisible("acme-web");
    const run = withUnseenWorkerRetry(
      "acme-web",
      async () => {
        attempts += 1;
        throw attempts === 1 ? notYetVisible("acme-web") : second;
      },
      async () => {},
    );
    await expect(run).rejects.toBe(second);
    expect(attempts).toBe(2);
  });

  test("any other failure is not retried and is not waited on", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const failure = new InternalError({ message: "wrangler deploy failed. [code: 10021]" });
    const run = withUnseenWorkerRetry(
      "acme-web",
      async () => {
        attempts += 1;
        throw failure;
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    await expect(run).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(waits).toEqual([]);
  });
});
