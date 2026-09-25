// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createServer, type Server, type Socket } from "node:net";
import { cloudflareRequest } from "@pithy-sh/cloudflare/src/client/errors";
import { classifyWorkflowFault } from "@pithy-sh/core/src/workflow/faults";
import { afterAll, describe, expect, it } from "vitest";
import { secretsWorkflowRetry } from "./retryPolicy";

/**
 * **What the rotation Workflow does with a Cloudflare call that ran out of time.**
 *
 * The policy retries `core/upstream_timeout` and refuses `cloudflare/request_failed`, and the two are
 * one line apart in a record — which is exactly why the split has to be driven rather than read. For a
 * round it was decorative: `cloudflareRequest`'s 504 branch matched `error.name` and `error.code`, and
 * a real timeout sets neither, so every timed-out store call inside `AtRestKeyRotationWorkflow`
 * classified `{"disposition":"terminal","code":"cloudflare/request_failed","reason":"secrets does not
 * retry cloudflare/request_failed: a second attempt reaches the same answer."}` — the exact wrong story
 * the split exists to prevent, on the most retryable failure the manager has.
 *
 * So this drives a real socket that accepts and never answers, through the real wrapper, into the real
 * classifier. Nothing here is an error object anybody typed out.
 */

const OPEN: { server?: Server; sockets: Socket[] } = { sockets: [] };

/** A real listener that accepts a connection and never writes a byte. */
async function blackhole(): Promise<string> {
  const server = createServer((socket) => OPEN.sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  OPEN.server = server;
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

afterAll(() => {
  for (const socket of OPEN.sockets) socket.destroy();
  OPEN.server?.close();
});

describe("the at-rest rotation's retry classification", () => {
  it("re-drives a store call whose deadline expired", async () => {
    // A real socket that accepts and answers nothing, and a real `AbortSignal.timeout` over it.
    const url = await blackhole();
    const thrown = await cloudflareRequest("Secrets Store write-back", () =>
      fetch(url, { signal: AbortSignal.timeout(120) }),
    ).catch((error: unknown) => error);

    expect(classifyWorkflowFault(thrown, secretsWorkflowRetry)).toEqual({
      disposition: "retry",
      code: "core/upstream_timeout",
      reason: "The Cloudflare API ran out of time; the write-back is idempotent on the key set.",
    });
  }, 20000);

  it("re-drives a store call whose connection never completed", async () => {
    // The producer that was *not* classified for a round, and the reason this file exists. `fetch`
    // rejects with `TypeError: fetch failed` and puts undici's own timeout one level down, so a
    // predicate reading the top level answered "Cloudflare refused" for a connection that was never
    // made. The chain below is the capture in `@pithy-sh/cloudflare`'s `timeoutProducers.test.ts`,
    // read off a real 10.5s connect timeout against TEST-NET-1 — undici's connect timer cannot be
    // shortened through `fetch`, so it is quoted rather than waited for.
    const underlying = Object.assign(
      new Error("Connect Timeout Error (attempted address: 192.0.2.1:443, timeout: 10000ms)"),
      { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" },
    );
    const thrown = await cloudflareRequest("Secrets Store write-back", () =>
      Promise.reject(new TypeError("fetch failed", { cause: underlying })),
    ).catch((error: unknown) => error);

    expect(classifyWorkflowFault(thrown, secretsWorkflowRetry)).toEqual({
      disposition: "retry",
      code: "core/upstream_timeout",
      reason: "The Cloudflare API ran out of time; the write-back is idempotent on the key set.",
    });
  });

  it("stops on a refusal Cloudflare actually answered", async () => {
    // The other half of the split, and the reason a timeout must not borrow this code: a store that
    // answered "no" answers "no" again, and re-driving it burns the budget on a settled question.
    const answered = Object.assign(new Error("403 Forbidden"), { status: 403 });
    const thrown = await cloudflareRequest("Secrets Store write-back", () => Promise.reject(answered)).catch(
      (error: unknown) => error,
    );

    expect(classifyWorkflowFault(thrown, secretsWorkflowRetry).disposition).toBe("terminal");
  });

  /**
   * **Both halves of the status split, driven rather than read (`#647`).**
   *
   * The classification is keyed on the HTTP status at the raise site, because a retry policy sees only
   * the `code` and a durable step record carries nothing else. Each case below is a real throw through
   * the real `cloudflareRequest` wrapper and the real classifier.
   *
   * The pairing is the point. A 5xx or a 429 on the master-key write-back is worth another attempt — the
   * at-rest rotation is the only caller that talks to Cloudflare, and ending its instance on a transient
   * 503 is expensive in the one place it is expensive. A 401 or a 403 is a token that was revoked or
   * under-scoped, and retrying it loops a nightly cron forever with nothing ever saying why. Fails if
   * either half moves: if `cloudflare/request_failed` is added to the policy, the auth cases go green
   * on "retry"; if the status keying is dropped, the transient ones go red.
   */
  it.each([
    { status: 429, label: "rate limited", disposition: "retry", code: "core/upstream_failed" },
    { status: 500, label: "internal error", disposition: "retry", code: "core/upstream_failed" },
    { status: 503, label: "unavailable", disposition: "retry", code: "core/upstream_failed" },
    { status: 401, label: "unauthorized", disposition: "terminal", code: "cloudflare/request_failed" },
    { status: 403, label: "forbidden", disposition: "terminal", code: "cloudflare/request_failed" },
    { status: 404, label: "no such store", disposition: "terminal", code: "cloudflare/request_failed" },
  ])("a $status ($label) is $disposition", async ({ status, disposition, code }) => {
    const answered = Object.assign(new Error(`${status}`), { status });
    const thrown = await cloudflareRequest("Secrets Store write-back", () => Promise.reject(answered)).catch(
      (error: unknown) => error,
    );

    const fault = classifyWorkflowFault(thrown, secretsWorkflowRetry);
    expect(fault.disposition).toBe(disposition);
    expect(fault.code).toBe(code);
  });
});
