// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createServer, type Server, type Socket } from "node:net";
import type { ErrorPayload } from "@pithy-sh/core/src/error/payload";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import Cloudflare, { APIError } from "cloudflare";
import { afterAll, describe, expect, it } from "vitest";
import { cloudflareRequest } from "./errors";

/**
 * **What a timed-out Cloudflare call actually throws — driven, not described.**
 *
 * The 504 branch shipped once with fixtures that read like the producers and matched neither. They were
 * `Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" })` and
 * `Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" })` — objects
 * the SDK cannot construct and `fetch` never rejects with — so the tests passed while every real
 * timeout classified as `cloudflare/request_failed` at 502, and `@pithy-sh/secrets`' rotation, which
 * retries `core/upstream_timeout` and not that, called a transient failure permanent.
 *
 * So this file has no hand-written error objects in it. Each fixture comes off the producer that raises
 * it in production:
 *
 * - **The SDK**, a real `Cloudflare` client with a real `timeout`, pointed at a `node:net` server that
 *   accepts a connection and answers nothing. Milliseconds, no egress, no mock.
 * - **`AbortSignal.timeout`**, a real `fetch` against that same server — the raw-`fetch` escape hatch's
 *   deadline, and the one timeout that arrives as a `DOMException`.
 * - **A refused connection**, a real `fetch` and a real SDK call against a port nothing is listening on:
 *   the negative, three levels deep, which must stay a 502.
 *
 * The fourth producer — undici's own connect timeout, the one that hides on `cause` — is **captured**
 * rather than driven, on the pattern `stepFailure.ts` uses for the Workflows engine's prose. Its timer
 * is undici's fixed 10s `connectTimeout` and there is no way to shorten it through `fetch`, so driving
 * it here would put a ten-second network wait in a unit suite. Read off a real run against TEST-NET-1
 * (`fetch("http://192.0.2.1/…")`, Node 24.13.0, rejected after 10531ms):
 *
 * ```text
 * [0] ctor=TypeError name="TypeError" code=undefined msg="fetch failed"
 * [1] ctor=ConnectTimeoutError name="ConnectTimeoutError" code="UND_ERR_CONNECT_TIMEOUT"
 *     msg="Connect Timeout Error (attempted address: 192.0.2.1:80, timeout: 10000ms)"
 * ```
 *
 * That capture is reconstructed below with `Error`'s own `cause` option — the same nesting `fetch`
 * performs — and it is the reason the predicate walks the chain at all: the top level of a `fetch`
 * failure says `TypeError` and nothing else.
 */

/** Sockets that accept and answer nothing, and the port they answer nothing on. */
const OPEN: { server?: Server; sockets: Socket[] } = { sockets: [] };

/** A real listener that accepts a connection and never writes a byte. The producer of a read timeout. */
async function blackhole(): Promise<string> {
  const server = createServer((socket) => OPEN.sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  OPEN.server = server;
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** A port nothing is listening on: bound, then released, so the refusal is the OS's own. */
async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

afterAll(() => {
  for (const socket of OPEN.sockets) socket.destroy();
  OPEN.server?.close();
});

/** Run `fn` through the real wrapper and hand back the payload it refused with. */
async function refusalOf(operation: string, fn: () => Promise<unknown>): Promise<ErrorPayload> {
  try {
    await cloudflareRequest(operation, fn);
  } catch (error) {
    if (error instanceof PithyError) return error.payload;
    throw error;
  }
  throw new Error("cloudflareRequest resolved; expected it to refuse.");
}

describe("the SDK's own timeout", () => {
  it("carries its class name and nothing else — the shape the old fixture could not have", async () => {
    const client = new Cloudflare({ apiToken: "probe", maxRetries: 0, timeout: 150, baseURL: await blackhole() });
    const thrown = await client.accounts.tokens
      .list({ account_id: "acct" })
      .then(() => undefined)
      .catch((error: unknown) => error);

    // The measurement the 504 branch has to be built on: `APIConnectionTimeoutError extends
    // APIConnectionError extends APIError extends CloudflareError extends Error`, and not one of them
    // assigns `this.name`. So `name` is "Error" and `code` is undefined — a predicate reading either
    // answers no, on the one error class the branch was written for.
    expect((thrown as object).constructor.name).toBe("APIConnectionTimeoutError");
    expect((thrown as Error).name).toBe("Error");
    expect((thrown as { code?: unknown }).code).toBeUndefined();
    expect((thrown as { status?: unknown }).status).toBeUndefined();
  }, 20000);

  it("is core/upstream_timeout, not cloudflare/request_failed", async () => {
    const client = new Cloudflare({ apiToken: "probe", maxRetries: 0, timeout: 150, baseURL: await blackhole() });
    const payload = await refusalOf("mint account token 'pithy-prod-deploy'", () =>
      client.accounts.tokens.list({ account_id: "acct" }),
    );

    // CLAUDE.md §Errors splits the upstream class for a reason a caller acts on: a 502 says Cloudflare
    // answered and refused, so the same call refuses again; a 504 says nobody answered, so it may
    // succeed — and may already have been applied.
    expect(payload.code).toBe("core/upstream_timeout");
    expect(payload.status).toBe(504);
    expect(payload.message).toBe("Cloudflare did not answer in time: mint account token 'pithy-prod-deploy'.");
    expect(payload.action).toContain("may already have been applied");
  }, 20000);
});

describe("a deadline the caller imposed", () => {
  it("AbortSignal.timeout over a real socket is a 504", async () => {
    const url = await blackhole();
    const payload = await refusalOf("Cloudflare Builds trigger", () =>
      fetch(url, { signal: AbortSignal.timeout(120) }),
    );

    expect(payload.code).toBe("core/upstream_timeout");
    expect(payload.status).toBe(504);
  }, 20000);
});

describe("undici's own connect timeout, which hides on `cause`", () => {
  it("is a 504, and reading only the top level is why it was not", async () => {
    // The capture in this file's docblock, reconstructed with `Error`'s `cause` — `fetch` puts the
    // reason exactly one level down and says `TypeError` at the top, so `TIMEOUT_CODES` was dead for
    // the raw-`fetch` escape hatch (`CloudflareBuildsManager`) its own docstring named.
    const underlying = Object.assign(
      new Error("Connect Timeout Error (attempted address: 192.0.2.1:80, timeout: 10000ms)"),
      { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" },
    );
    const payload = await refusalOf("Cloudflare Builds trigger", () =>
      Promise.reject(new TypeError("fetch failed", { cause: underlying })),
    );

    expect(payload.code).toBe("core/upstream_timeout");
    expect(payload.status).toBe(504);
  });
});

describe("what is not a timeout stays a 502", () => {
  it("a refused connection, three levels deep, through the real SDK", async () => {
    const client = new Cloudflare({ apiToken: "probe", maxRetries: 0, baseURL: await closedPort() });
    const thrown = await client.accounts.tokens
      .list({ account_id: "acct" })
      .then(() => undefined)
      .catch((error: unknown) => error);

    // The producer, stated: `APIConnectionError` → `TypeError: fetch failed` → `Error ECONNREFUSED`.
    // The walk reaches the bottom of it and finds a code in neither set, which is the negative the
    // chain walk needs — a predicate that answered "timeout" for any nested error would pass every
    // positive above and still be wrong.
    expect((thrown as object).constructor.name).toBe("APIConnectionError");
    expect((thrown as { cause?: { cause?: { code?: unknown } } }).cause?.cause?.code).toBe("ECONNREFUSED");

    const payload = await refusalOf("KV get for key 'session:1'", () => Promise.reject(thrown));
    expect(payload.code).toBe("cloudflare/request_failed");
    expect(payload.status).toBe(502);
  }, 20000);

  it("a refusal Cloudflare actually answered", async () => {
    const answered = APIError.generate(
      401,
      JSON.parse(`{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}`),
      undefined,
      new Headers(),
    );
    const payload = await refusalOf("Turnstile list widgets", () => Promise.reject(answered));

    expect(payload.code).toBe("cloudflare/request_failed");
    expect(payload.status).toBe(502);
  });

  it("an answered 500 whose cause happens to mention a timeout", async () => {
    // A status means Cloudflare replied, whatever is underneath it. Without that rule a 500 carrying a
    // timed-out internal hop would be reported to the operator as "nobody answered".
    const answered = Object.assign(new Error("500 Internal Server Error"), {
      status: 500,
      cause: Object.assign(new Error("upstream"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
    });
    const payload = await refusalOf("Workers script upload", () => Promise.reject(answered));

    expect(payload.code).toBe("cloudflare/request_failed");
    expect(payload.status).toBe(502);
  });
});

describe("a gateway that answered the timeout for Cloudflare", () => {
  it.each([408, 504, 524])("%s is core/upstream_timeout", async (status) => {
    const payload = await refusalOf("D1 query", () =>
      Promise.reject(Object.assign(new Error(`${status} Gateway Timeout`), { status })),
    );

    expect(payload.code).toBe("core/upstream_timeout");
    expect(payload.status).toBe(504);
  });
});
