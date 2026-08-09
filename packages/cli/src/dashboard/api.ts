// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import {
  ConnectionHealth,
  ConnectToken,
  type DashboardClient,
  DEFAULT_DASHBOARD_ORIGIN,
  DeviceAuthorization,
  IssuedConnection,
  IssuedKey,
} from "./contract";

/**
 * The HTTP implementation of the management-client contract in `./contract`.
 *
 * **The contract is a separate module, and that boundary is the point.** The schemas, the
 * `DashboardClient` interface and `DEFAULT_DASHBOARD_ORIGIN` have no runtime dependencies, so anything
 * that could implement the contract can import them. This file has all three — `fetch`, `AbortController`,
 * and a `setTimeout` handle whose type differs between node and the Workers runtime — and none of them
 * belong in a program that only wants the shapes.
 *
 * Every response goes through the same three gates — reachable, 2xx, then Zod — and every failure leaves
 * as a `PithyError` carrying an action line. A raw `TypeError: fetch failed` or a `ZodError` escaping to
 * the terminal would breach docs/CLI.md §3.3, which wants a problem line and a next step.
 */

/** How long one dashboard call waits before giving up, so a hung origin never wedges the CLI. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** The request shape the client issues — a subset of `RequestInit` the global `fetch` satisfies. */
export interface DashboardRequestInit {
  /** The HTTP method. */
  method: string;
  /** Request headers, lowercase-keyed so a test can assert `authorization` without guessing case. */
  headers: Record<string, string>;
  /** The JSON body, already serialized. Absent for a request that carries none. */
  body?: string;
  /** The timeout's abort signal. */
  signal?: AbortSignal;
}

/** The slice of a `fetch` `Response` this client reads. `text()`, so a non-JSON body is our error. */
export interface DashboardResponse {
  /** The HTTP status — `202` and `410` are protocol, not failure, on the device-token route. */
  readonly status: number;
  /** Whether the status is 2xx. */
  readonly ok: boolean;
  /** The raw body. Read as text so an HTML error page becomes a PithyError, not a `SyntaxError`. */
  text(): Promise<string>;
}

/** A minimal `fetch`. The real `globalThis.fetch` satisfies it; a test injects a double. */
export type DashboardFetch = (url: string, init: DashboardRequestInit) => Promise<DashboardResponse>;

/** Options for {@link httpDashboardClient}. */
export interface HttpDashboardClientOptions {
  /** The management client's origin. Defaults to {@link DEFAULT_DASHBOARD_ORIGIN}. */
  origin?: string;
  /** Injected `fetch`; defaults to the global. */
  fetch?: DashboardFetch;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/** One request's inputs, before the shared plumbing adds the token, the timeout, and the parsing. */
interface Call {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
}

/**
 * A dashboard call that could not produce a usable answer. Always a PithyError with an action line.
 *
 * **`action` is a parameter, and that is the whole of #217 here.** One sentence — *Check the dashboard
 * origin with --origin* — used to answer all four call sites: a transport failure, a non-2xx, a body
 * that was not JSON, and a body that failed Zod. It is right for exactly one of them. An operator whose
 * network was down, whose token had expired, or whose own management client returned 500 was told to
 * check an origin that was correct, and a wrong action is worse than no action because it is followed.
 */
function unusable(message: string, action: string, detail: string, cause?: unknown): InternalError {
  return new InternalError({ message, action, detail }, cause === undefined ? undefined : { cause });
}

/** Read a property off an unknown throwable without widening anything to `any`. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** The errno an undici `TypeError: fetch failed` hides one level down, in its `cause`. */
function transportCode(error: unknown): string | undefined {
  for (const candidate of [error, prop(error, "cause")]) {
    const code = prop(candidate, "code");
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * What to tell an operator whose call did not complete, chosen from the failure (#217).
 *
 * `fetch` rejects for a mistyped host, a dead network, a refused port, an expired certificate and this
 * client's own abort, and only the first is answered by re-checking `--origin`. Duck-typed throughout:
 * the abort is identified by `name`, and undici buries the errno in `cause`, so nothing here may lean on
 * `instanceof` — the CLI ships on Bun, whose transport errors are not node's classes.
 *
 * **The two runtimes do not classify the same failure the same way, and this was checked rather than
 * assumed.** Node wraps in a `TypeError: fetch failed` and puts `ENOTFOUND` or `ECONNREFUSED` on the
 * `cause`; Bun throws a plain `Error` and reports a dead host, a bogus TLD and a refused port all as one
 * `code: "ConnectionRefused"`. Bun cannot tell those two apart — so on Bun this must not either, and its
 * branch names both possibilities. Node keeps the sharper split it has earned. Both verified live
 * against Bun 1.3.14 and Node 22; TLS is the one place the codes already agree.
 */
function transportAction(error: unknown, origin: string, timeoutMs: number): string {
  if (prop(error, "name") === "AbortError" || prop(error, "name") === "TimeoutError") {
    return `The call timed out after ${timeoutMs}ms. Retry; the origin answered nothing, not the wrong thing.`;
  }
  const code = transportCode(error);
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `That host does not resolve. Check the origin with --origin (currently ${origin}).`;
    case "ECONNREFUSED":
      return `Nothing is listening at ${origin}. Start it, or point --origin somewhere that is.`;
    // Bun's own codes. One of them covers what node splits in two, so the sentence covers both.
    case "ConnectionRefused":
    case "FailedToOpenSocket":
      return `Nothing at ${origin} answered. Check that it is listening, and that the origin is right (--origin).`;
    case "ConnectionClosed":
    case "ECONNRESET":
    case "EPIPE":
    case "ETIMEDOUT":
      return `The connection to ${origin} dropped. Check that it is reachable, then run the command again.`;
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return `TLS to ${origin} could not be verified. Fix that certificate — the origin itself answered.`;
    default:
      return `The call to ${origin} did not complete${code ? ` (${code})` : ""}. Check network access to it, then run the command again.`;
  }
}

/** What to tell an operator about a status the client itself returned — reachable, and refusing. */
function statusAction(status: number): string {
  if (status === 401 || status === 403) {
    return "Sign in again with pithy login — that credential was refused, not the request.";
  }
  if (status === 404) return "That route is not on this management client. Check the origin with --origin.";
  if (status === 429) return "Rate limited. Wait, then run the command again.";
  if (status >= 500) return `The management client answered ${status}. Retry; if it persists, that is its fault.`;
  return `The management client answered ${status}. The detail line says which call.`;
}

/** The one answer `--origin` genuinely earns: the thing at that origin is not a management client. */
function notAManagementClient(origin: string): string {
  return `Whatever is at ${origin} is not a Pithy management client. Check the origin with --origin.`;
}

/**
 * Build the HTTP client — one implementation of `DashboardClient`, never the definition of it.
 *
 * `origin` re-points every call at a self-hosted management client. `fetch` and `timeoutMs` are the
 * seams a test replaces, so no suite reaches the network or waits out a timeout.
 */
export function httpDashboardClient(options: HttpDashboardClientOptions = {}): DashboardClient {
  const origin = (options.origin ?? DEFAULT_DASHBOARD_ORIGIN).replace(/\/+$/, "");
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as DashboardFetch);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Issue one call and hand back its status and raw body. Never throws for a non-2xx — the caller decides. */
  async function send(call: Call): Promise<{ status: number; raw: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // The timeout must never hold the event loop open past the CLI's own work.
    timer.unref?.();
    try {
      const response = await doFetch(`${origin}${call.path}`, {
        method: call.method,
        headers: {
          accept: "application/json",
          ...(call.body === undefined ? {} : { "content-type": "application/json" }),
          ...(call.token === undefined ? {} : { authorization: `Bearer ${call.token}` }),
        },
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
        signal: controller.signal,
      });
      return { status: response.status, raw: await response.text() };
    } catch (error) {
      throw unusable(
        "Couldn't reach the management client.",
        transportAction(error, origin, timeoutMs),
        `${call.method} ${call.path} did not complete`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Send, require 2xx, and parse the body against `schema`. The one path every typed call takes. */
  async function request<T>(call: Call, schema: z.ZodType<T>): Promise<T> {
    const { status, raw } = await send(call);
    if (status < 200 || status >= 300) {
      throw unusable(
        "The management client refused that request.",
        statusAction(status),
        `${call.method} ${call.path} → ${status}`,
      );
    }
    return decode(schema, raw, call);
  }

  /** Parse a raw body as JSON, then against `schema`. Both failures read the same way to an operator. */
  function decode<T>(schema: z.ZodType<T>, raw: string, call: Call): T {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (error) {
      throw unusable(
        "The management client returned something Pithy couldn't read.",
        notAManagementClient(origin),
        `${call.method} ${call.path} body was not JSON`,
        error,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      // The issue list goes in `detail`, which the HTTP codec strips and the terminal keeps — an
      // operator debugging their own management client needs the field path, and nobody else does.
      throw unusable(
        "The management client returned something Pithy couldn't read.",
        notAManagementClient(origin),
        `${call.method} ${call.path} response failed validation: ${z.prettifyError(parsed.error)}`,
        parsed.error,
      );
    }
    return parsed.data;
  }

  return {
    startDeviceAuthorization: () => request({ method: "POST", path: "/api/cli/device/start" }, DeviceAuthorization),

    async pollForConnectToken(deviceCode) {
      const call: Call = { method: "POST", path: "/api/cli/device/token", body: { deviceCode } };
      const { status, raw } = await send(call);
      // 202 is the flow working: the human has not clicked yet. 410 is the flow over.
      if (status === 202) return "pending";
      if (status === 410) {
        throw new NotFoundError({
          message: "That sign-in request expired.",
          action: "Run the command again to start a new one.",
          detail: "POST /api/cli/device/token → 410",
        });
      }
      if (status < 200 || status >= 300) {
        throw unusable(
          "The management client refused that request.",
          statusAction(status),
          `${call.method} ${call.path} → ${status}`,
        );
      }
      return decode(ConnectToken, raw, call);
    },

    createConnection: (token, body) =>
      request({ method: "POST", path: "/api/cli/connections", token, body }, IssuedConnection),

    rotateKey: (token, connectionId) =>
      request(
        { method: "POST", path: `/api/cli/connections/${encodeURIComponent(connectionId)}/rotate`, token },
        IssuedKey,
      ),

    async updateConnection(token, connectionId, body) {
      await request(
        { method: "PATCH", path: `/api/cli/connections/${encodeURIComponent(connectionId)}`, token, body },
        z.unknown(),
      );
    },

    verifyConnection: (token, connectionId, workerUrl) =>
      request(
        {
          method: "POST",
          path: `/api/cli/connections/${encodeURIComponent(connectionId)}/verify`,
          token,
          body: { workerUrl },
        },
        ConnectionHealth,
      ),

    async deleteConnection(token, connectionId) {
      const call: Call = {
        method: "DELETE",
        path: `/api/cli/connections/${encodeURIComponent(connectionId)}`,
        token,
      };
      const { status } = await send(call);
      // 204 carries no body, so there is nothing to parse and nothing to validate.
      if (status < 200 || status >= 300) {
        throw unusable(
          "The management client refused that request.",
          statusAction(status),
          `${call.method} ${call.path} → ${status}`,
        );
      }
    },
  };
}
