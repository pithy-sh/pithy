import { Ed25519PublicJwk } from "@pithy-sh/core/src/controlPlane/data/connection";
import { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";

/**
 * The management client's side of the control-plane seam, as a contract the CLI holds it to.
 *
 * **The dashboard lives in another repo and does not exist yet, so this file defines what it must
 * implement**, not what it happens to do. Six calls, six response shapes, every one Zod-validated on
 * arrival — because a management client is a network boundary like any other, and the thing it hands
 * back gets written into the adopter's own D1 as an authorization record. A malformed `publicKeyJwk`
 * that reached the row would be a connection that can never verify a call and never explain why.
 *
 * It is an **interface first and an HTTP client second** for the same reason: the seam is MIT and
 * ungated (docs/CONTROL-PLANE.md §5), so "write your own management client" has to be true. Anything
 * satisfying {@link DashboardClient} drives `pithy dashboard` — the hosted dashboard, a self-hosted
 * one, or a fake in a test. {@link httpDashboardClient} is one implementation, not the definition.
 *
 * **Nothing secret of the adopter's crosses this wire.** The dashboard mints the Ed25519 keypair and
 * keeps the private half; only the public JWK comes back. What the CLI sends up is a project name, an
 * environment, a Worker URL, and the scopes a human chose.
 */

/** Where the hosted dashboard lives. `--origin` re-points every call at a self-hosted one. */
export const DEFAULT_DASHBOARD_ORIGIN = "https://app.pithy.sh";

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

/**
 * What the CLI shows a human so they can approve the connection in a browser. The device-code flow
 * is the one leg of this design with genuine user delegation, which is why a browser belongs here
 * and nowhere near the machine-to-machine leg (docs/CONTROL-PLANE.md §5).
 */
export const DeviceAuthorization = z
  .object({
    deviceCode: z
      .string()
      .min(1)
      .describe("The opaque code the CLI polls with. Never shown to the human — the user code is."),
    userCode: z
      .string()
      .min(1)
      .describe("The short code the human types into the browser. Short enough to read off a screen and retype."),
    verificationUri: z.url().describe("Where the human approves — the page the CLI prints and offers to open."),
    expiresInSeconds: z
      .number()
      .int()
      .positive()
      .describe("How long this request stays approvable. The CLI stops polling at this bound rather than forever."),
    intervalSeconds: z
      .number()
      .int()
      .positive()
      .describe("How long to wait between polls. The dashboard's rate limit, honoured rather than guessed."),
  })
  .describe("A started device-authorization request: what to show the human, and how to poll for the result.");
export type DeviceAuthorization = z.infer<typeof DeviceAuthorization>;

/** The short-lived credential a completed device flow yields — enough to create or rotate a connection, and nothing more. */
export const ConnectToken = z
  .object({
    connectToken: z
      .string()
      .min(1)
      .describe("The bearer credential for the connection-management calls. Short-lived, and never stored on disk."),
    expiresInSeconds: z
      .number()
      .int()
      .positive()
      .describe("How long the token stays usable. A connect run finishes well inside it or starts over."),
  })
  .describe("The credential a completed device authorization yields, used for the rest of one `pithy dashboard` run.");
export type ConnectToken = z.infer<typeof ConnectToken>;

/** What the CLI asks for when registering a new connection: the identity of the thing being connected. */
export const CreateConnectionRequest = z
  .object({
    project: z
      .string()
      .min(1)
      .describe("The project's stable name, from the root pithy.config.ts. What the connection is labelled with."),
    environment: z
      .string()
      .min(1)
      .describe(
        "Which environment this connection is valid in. Bound into every token, so a staging credential cannot reach production.",
      ),
    workerUrl: z
      .url()
      .describe(
        "This environment's deployed Worker URL — the address the management client calls. Setup, not an afterthought: a client cannot reach a Worker it cannot address.",
      ),
    scopes: z
      .array(ControlPlaneScope)
      .min(1)
      .describe("The operations being granted. Enforced on the adopter's side; sent so the client knows its ceiling."),
  })
  .describe("A request to register one management-client connection for a project and environment.");
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequest>;

/**
 * A newly registered connection. **The private key is not here and never will be** — the dashboard
 * generates the keypair and keeps the private half, so key material never crosses the wire.
 */
export const IssuedConnection = z
  .object({
    connectionId: z
      .uuid()
      .describe("The connection's id — the token `aud`, and the row's primary key in the adopter's D1."),
    keyId: z.string().min(1).max(64).describe("The first key's id, named by the `kid` header of every token it signs."),
    publicKeyJwk: Ed25519PublicJwk.describe("The public half of the generated keypair — the only half that travels."),
    issuer: z
      .url()
      .describe("The `iss` every token from this client will carry, verified on every call and effectively permanent."),
    scopes: z
      .array(ControlPlaneScope)
      .describe("The scopes the dashboard recorded, echoed back so the row stores what was actually granted."),
  })
  .describe("A registered connection and its first public key — everything the adopter's D1 row is built from.");
export type IssuedConnection = z.infer<typeof IssuedConnection>;

/** A rotation's new public key. Appended to the connection; the key it succeeds is left alone. */
export const IssuedKey = z
  .object({
    keyId: z.string().min(1).max(64).describe("The new key's id. Must not already be registered on the connection."),
    publicKeyJwk: Ed25519PublicJwk.describe("The new public key to trust, once a signed ping has proven it works."),
  })
  .describe("The public half of a freshly generated rotation keypair.");
export type IssuedKey = z.infer<typeof IssuedKey>;

/**
 * The result of a signed round-trip against the adopter's Worker. **The CLI cannot make this call
 * itself** — it holds no private key — so it asks the management client to sign a `ping` and report.
 * That is the whole reason this method exists on the contract.
 */
export const ConnectionHealth = z
  .object({
    status: z
      .enum(["connected", "needs_reconnect"])
      .describe(
        "Whether a signed ping reached the Worker and verified. `needs_reconnect` is a live but unusable connection — a moved URL, an unregistered key — never a silent dead link.",
      ),
    detail: z
      .string()
      .optional()
      .describe("What went wrong, when something did. Operator-facing context, shown under the status line."),
  })
  .describe("A connection's health, as proven by a real signed call rather than by the row existing.");
export type ConnectionHealth = z.infer<typeof ConnectionHealth>;

/**
 * The management client, as the CLI needs it. Six calls: authorize a human, create a connection,
 * rotate its key, prove it works, and revoke it.
 *
 * Note what is **not** here. There is no "expire the old key": expiry is the management client's own
 * call once it has proven the successor, and a CLI that did it would recreate exactly the lockout the
 * seam is built to prevent (docs/CONTROL-PLANE.md §6).
 */
export interface DashboardClient {
  /** Begin a device-code authorization. Returns what to show the human and how to poll. */
  startDeviceAuthorization(): Promise<DeviceAuthorization>;
  /** Poll once. `"pending"` while the human has not approved; throws once the request is gone. */
  pollForConnectToken(deviceCode: string): Promise<ConnectToken | "pending">;
  /** Register a connection for this project and environment, and get its first keypair's public half. */
  createConnection(token: string, request: CreateConnectionRequest): Promise<IssuedConnection>;
  /** Generate a successor keypair for an existing connection. Appends only — nothing is replaced. */
  rotateKey(token: string, connectionId: string): Promise<IssuedKey>;
  /** Ask the client to sign a `ping` at `workerUrl` and report what happened. */
  verifyConnection(token: string, connectionId: string, workerUrl: string): Promise<ConnectionHealth>;
  /** Forget a connection on the client's side. The adopter's own revocation is deleting their row. */
  deleteConnection(token: string, connectionId: string): Promise<void>;
}

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

/** A dashboard call that could not produce a usable answer. Always a PithyError with an action line. */
function unusable(message: string, detail: string, cause?: unknown): InternalError {
  return new InternalError(
    {
      message,
      action: "Check the dashboard origin with --origin, then run the command again.",
      detail,
    },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * The HTTP implementation of {@link DashboardClient}.
 *
 * Every response goes through the same three gates — reachable, 2xx, then Zod — and every failure
 * leaves as a `PithyError` carrying an action line. A raw `TypeError: fetch failed` or a `ZodError`
 * escaping to the terminal would breach docs/CLI.md §3.3, which wants a problem line and a next step.
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
      throw unusable("Couldn't reach the management client.", `${call.method} ${call.path} did not complete`, error);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Send, require 2xx, and parse the body against `schema`. The one path every typed call takes. */
  async function request<T>(call: Call, schema: z.ZodType<T>): Promise<T> {
    const { status, raw } = await send(call);
    if (status < 200 || status >= 300) {
      throw unusable("The management client refused that request.", `${call.method} ${call.path} → ${status}`);
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
        throw unusable("The management client refused that request.", `${call.method} ${call.path} → ${status}`);
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
        throw unusable("The management client refused that request.", `${call.method} ${call.path} → ${status}`);
      }
    },
  };
}
