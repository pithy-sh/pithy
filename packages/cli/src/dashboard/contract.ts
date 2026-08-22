// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Ed25519PublicJwk } from "@pithy-sh/core/src/controlPlane/data/connection";
import { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { z } from "zod";

/**
 * The management client's side of the control-plane seam, as a contract the CLI holds it to.
 *
 * **The dashboard lives in another repo, so this file defines what it must implement**, not what it
 * happens to do. Six calls, six response shapes, every one Zod-validated on arrival — because a
 * management client is a network boundary like any other, and the thing it hands back gets written into
 * the adopter's own D1 as an authorization record. A malformed `publicKeyJwk` that reached the row would
 * be a connection that can never verify a call and never explain why.
 *
 * It is an **interface first and an HTTP client second** for the same reason: the seam is MIT and
 * ungated (docs/CONTROL-PLANE.md §5), so "write your own management client" has to be true. Anything
 * satisfying {@link DashboardClient} drives `pithy dashboard` — the hosted dashboard, a self-hosted one,
 * or a fake in a test. `httpDashboardClient` (`./api`) is one implementation, not the definition.
 *
 * **This module is the contract, and it is a module so that the client it specifies can import it.**
 * Everything here is schemas and types over `zod` and `@pithy-sh/core` — no `fetch`, no timers, nothing
 * from node. The HTTP client is a separate module because it needs all three, and a `setTimeout` handle
 * is a `number` under `@cloudflare/workers-types` and a `Timeout` under node's: with the two in one file,
 * the module failed to typecheck in every Workers-typed program, which is every program that could
 * implement this contract. The dashboard hand-copied the field sets into a conformance test instead, and
 * a hand-copied schema drifts silently — the precise thing exporting these was meant to prevent.
 * `tsconfig.contract.json` compiles this file alone against the Workers types, so the split stays real.
 *
 * **Nothing secret of the adopter's crosses this wire.** The dashboard mints the Ed25519 keypair and
 * keeps the private half; only the public JWK comes back. What the CLI sends up is a project name, an
 * environment, a Worker URL, and the scopes a human chose.
 */

/** Where the hosted dashboard lives. `--origin` re-points every call at a self-hosted one. */
export const DEFAULT_DASHBOARD_ORIGIN = "https://app.pithy.sh";

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
      .describe("How long to wait between polls. The dashboard's rate limit, honored rather than guessed."),
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
      .describe("The project's stable name, from the root pithy.config.ts. What the connection is labeled with."),
    environment: z
      .string()
      .min(1)
      .describe(
        "Which environment this connection is valid in. Bound into every token, so a staging credential cannot reach production.",
      ),
    isProduction: z
      .boolean()
      .describe(
        "Whether this environment holds live data — the CLI's answer, not the client's guess. A management client's production treatment is load-bearing UI: it is what stands between an operator and an unguarded destructive action against real users. The name cannot answer it, because a project may call production `live` or `prod-eu`, and a client inferring from `prod` alone would give every one of them the safe-looking treatment. The CLI already knows: the built-in `prod`/`production`, plus whatever the project declared in `seed.productionEnvironments`, which is the same list that gates a destructive seed.",
      ),
    workerUrl: z
      .url()
      .describe(
        "This environment's deployed Worker URL — the address the management client calls. Setup, not an afterthought: a client cannot reach a Worker it cannot address.",
      ),
    basePath: z
      .string()
      .min(1)
      .describe(
        "Where the control-plane seam is mounted on that Worker, from its resolved config — `/control-plane` unless the adopter moved it. **The one address a client cannot discover from the manifest, because it is the manifest's own address.** Everything else is discoverable: `AdminRoute.path` carries the fully mounted path so no client hardcodes a capability's mount point. Without this, a client has to assume the default, and an adopter who set `basePath: \"/admin\"` registers successfully, passes the ping, and then 404s on every call — the ping is called at the same assumed path, so a wrong base path fails identically to an unreachable Worker and the operator diagnoses the wrong problem.",
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

/**
 * Where the seam answers on the adopter's Worker — the address a registration has to be sent to.
 *
 * Sent from the adopter's own row rather than left to the client's memory of it. The row is the
 * authority on where their Worker is; a client holding a stale address would otherwise register a key
 * against whatever now answers there.
 */
export const SeamAddress = z
  .object({
    workerUrl: z.url().describe("This environment's Worker URL, as the adopter's own registration records it."),
    basePath: z
      .string()
      .min(1)
      .describe("Where the seam is mounted on it — `/control-plane` unless the adopter moved the mount."),
  })
  .describe("The address of one Worker's control-plane seam, taken from the adopter's own connection row.");
export type SeamAddress = z.infer<typeof SeamAddress>;

/**
 * A rotation's new key, **after the adopter's Worker has recorded it**.
 *
 * The public JWK is deliberately absent. It used to come back because the CLI wrote the key into the
 * adopter's D1 itself; the registration now happens at `POST {basePath}/keys`, which writes that row,
 * so the CLI has nothing to do with the key material and asking for it would be asking for something
 * to go wrong with.
 */
export const RotatedKey = z
  .object({
    keyId: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "The successor key's id, as the adopter's Worker registered it. Named by the `kid` of every token it signs.",
      ),
    validFrom: z.iso
      .datetime()
      .describe(
        "When the Worker opened the new key's window, ISO-8601 — its clock, since its clock is what judges a token.",
      ),
  })
  .describe("A successor key the management client generated and registered through the adopter's own seam.");
export type RotatedKey = z.infer<typeof RotatedKey>;

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
    keyId: z
      .string()
      .nullable()
      .describe(
        "Which registered key answered, read off the `ping` response's own `keyId`, or null when nothing did. **This is what proves a rotation.** The seam echoes the key that verified the call precisely so a client can tell which one answered rather than infer it from a 200, and the second step of a rotation — prove the successor before expiring what it replaces — is exactly that question. Without it a rotation is reported on the client's account of its own work.",
      ),
    detail: z
      .string()
      .optional()
      .describe("What went wrong, when something did. Operator-facing context, shown under the status line."),
  })
  .describe("A connection's health, as proven by a real signed call rather than by the row existing.");
export type ConnectionHealth = z.infer<typeof ConnectionHealth>;

/**
 * What `--update` re-registers: the address, and nothing else.
 *
 * Scopes are deliberately absent. The adopter's own row is the authority on what a connection may do —
 * `assertNoScopeEscalation` refuses a client that returns more than was asked for — so telling the client
 * about a scope change is neither necessary nor safe to trust. The address is the opposite case: the
 * client is the one that has to *reach* the Worker, so it is the one that has to be told where it moved.
 *
 * `isProduction` is absent for a different reason: an environment does not stop being production. It is
 * a fact about the environment, settled once, at the connect that created the record.
 */
export const UpdateConnectionRequest = z
  .object({
    workerUrl: z
      .url()
      .describe(
        "Where this environment's Worker now answers. A custom domain, a rename, or a moved environment all change it, and a client still calling the old address fails in a way that looks like an outage.",
      ),
    basePath: z
      .string()
      .min(1)
      .describe(
        "Where the seam is now mounted. Together with `workerUrl` this fully determines the manifest address — and it is the half a client cannot discover, because it is the manifest's own address.",
      ),
  })
  .describe("Re-point an existing connection at the address its Worker now answers on.");
export type UpdateConnectionRequest = z.infer<typeof UpdateConnectionRequest>;

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
  /**
   * Generate a successor keypair and **register it through the adopter's own seam**.
   *
   * Two steps, and the second is the one that matters: the client mints the keypair, then calls
   * `POST {basePath}/keys` on the Worker at `address`, signing that request with the key it is
   * replacing. Appends only — nothing is expired, and both keys are live when this returns.
   *
   * **The CLI cannot make that call itself**, holding no private key, which is the same reason
   * {@link DashboardClient.verifyConnection} exists. Routing it through the client rather than writing
   * the key straight into the adopter's D1 is what puts the rotation behind their `keys:rotate` scope
   * check and into their own audit trail — the safety property at a boundary rather than in a function
   * a caller has to remember to use (docs/CONTROL-PLANE.md §6).
   *
   * A Worker that cannot be reached must fail this call rather than report a key it did not register.
   * The CLI cannot audit that claim by reading the adopter's row — locally the row is behind a second
   * runtime's cache, and a check that is only sometimes right is worse than none. What it does instead
   * is insist on evidence: the `ping` that follows must come back naming *this* key
   * ({@link ConnectionHealth.keyId}), which no amount of reporting can fake.
   */
  rotateKey(token: string, connectionId: string, address: SeamAddress): Promise<RotatedKey>;
  /**
   * Re-point an existing connection at a new address.
   *
   * **Without this, `--update` is half an update.** It would rewrite the adopter's own enforcement row
   * while the management client kept calling wherever it was told at connect — so the CLI would report
   * success and every subsequent management call would fail against a dead address, which reads as an
   * outage rather than as a stale registration.
   */
  updateConnection(token: string, connectionId: string, request: UpdateConnectionRequest): Promise<void>;
  /** Ask the client to sign a `ping` at `workerUrl` and report what happened. */
  verifyConnection(token: string, connectionId: string, workerUrl: string): Promise<ConnectionHealth>;
  /** Forget a connection on the client's side. The adopter's own revocation is deleting their row. */
  deleteConnection(token: string, connectionId: string): Promise<void>;
}
