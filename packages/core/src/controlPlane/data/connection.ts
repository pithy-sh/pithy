// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { JsonDate, SQLiteDate, sqliteJson } from "../../data/codecs";
import { ControlPlaneScope } from "../scope/scope";

/**
 * The registration record: who may call this Worker's control-plane routes, from where, with what
 * keys, for which operations.
 *
 * **This lives in D1, not the Secrets Store.** A public key is not confidential — but it *is*
 * integrity-critical, because whoever can change it owns the seam. D1 gives it a queryable lifecycle,
 * an audit trail, and room for two valid keys during a rotation overlap. Writes come only from the CLI
 * provisioning path or from a route authenticated by the key being replaced; no runtime route with a
 * lesser credential can touch it.
 */

/** An Ed25519 public key in JWK form — the only key type this seam accepts. */
export const Ed25519PublicJwk = z
  .object({
    kty: z.literal("OKP").describe("Key type. Ed25519 is an octet key pair, so this is always `OKP` (RFC 8037)."),
    crv: z
      .literal("Ed25519")
      .describe(
        "The curve, pinned to Ed25519. Pinned rather than accepted from the key so a weaker curve cannot be smuggled in at registration and honored at verification.",
      ),
    x: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "The base64url-encoded public key point. Public by definition — safe to store, and safe to return from `GET /control-plane/keys`.",
      ),
  })
  .describe("An Ed25519 public key as a JWK: what a management client registers, and what verification imports.");
export type Ed25519PublicJwk = z.output<typeof Ed25519PublicJwk>;

/**
 * One registered public key and its validity window — an element of the connection's versioned array.
 *
 * Several keys are valid at once during a rotation overlap. That is a normal state, not an exception:
 * the new key is appended and proven *before* the old one is given an end date, so there is always a
 * live key to authenticate the next step with.
 */
export const RegisteredKey = z
  .object({
    keyId: z
      .string()
      .min(1)
      .max(64)
      .describe("The key's id, matched against a token's `kid` header. Opaque, and minted by the management client."),
    publicKey: Ed25519PublicJwk.describe(
      "The public key this id names. Imported per request to verify a signature; nothing secret is stored here.",
    ),
    validFrom: JsonDate.describe(
      "When this key became valid. A call signed before it is rejected, so a key registered ahead of time cannot be used early.",
    ),
    validUntil: JsonDate.nullable().describe(
      "When this key stops being accepted, or null while it is open-ended. Set only by the expire route, never at registration — the open-ended overlap is what keeps a failed rotation from locking anyone out.",
    ),
    revokedAt: JsonDate.nullable().describe(
      "When this key was revoked outright, or null. Revocation ignores `validUntil` and takes effect immediately — it is the adopter's unilateral control, and it must not wait for a window to close.",
    ),
  })
  .describe("One registered public key with its validity window. Two live at once during a rotation overlap.");
export type RegisteredKey = z.output<typeof RegisteredKey>;

/**
 * What kind of client a connection is for (#721): `agent`, `dashboard` or `script`.
 *
 * The audit trail's `actorType: "control-plane"` names all three identically, and the questions asked
 * after an incident are exactly the ones that tell them apart — was it a person at the dashboard, a
 * script somebody wrote, or an agent running unattended. So the kind is recorded on the connection when
 * it is registered and stamped from there onto every row its calls write.
 *
 * It follows the path, never a guess: the device-code flow is a dashboard, always, and a key the
 * operator registered themselves is whichever of the other two they say, out loud, with `--kind`.
 */
export const ControlPlaneActorKind = z
  .enum(["agent", "dashboard", "script"])
  .describe(
    "What kind of client a connection is for: `agent` (an automated client acting on its own judgment, often unattended), `dashboard` (a management dashboard a person drives, registered through the device-code flow), or `script` (an operator's own automation, doing one fixed thing).",
  );
export type ControlPlaneActorKind = z.output<typeof ControlPlaneActorKind>;

/**
 * Who sanctioned a connection: the email address of the signed-in Cloudflare session that registered it.
 *
 * **A plain string, deliberately not a reference.** An adopter's `pithy_auth_users` are their customers,
 * and the operator who registers a connection is their staff, so a join into the organization model would
 * be empty for most of them. A string is readable by anybody, and matchable against a directory where the
 * operator is in one.
 *
 * **Derived, never asserted.** No flag supplies it; the CLI reads it from `GET /user` under the session.
 */
export const ConnectionPrincipal = z
  .email()
  .max(254)
  .describe(
    "The email address of the person who sanctioned this connection, read from their signed-in Cloudflare session at registration. Never typed, so never asserted.",
  );
export type ConnectionPrincipal = z.output<typeof ConnectionPrincipal>;

/** The longest purpose a connection may carry. One line on a review screen, with room to say what it does. */
export const MAX_CONNECTION_PURPOSE = 200;

/**
 * Characters a purpose may not carry: every C0 and C1 control (so no terminal escape, no newline and no
 * carriage return), the Unicode line and paragraph separators, and the bidi embeddings, overrides and
 * isolates that let text render in a different order from the one it is stored in.
 *
 * Each of those is a way for a sentence to look like something else once it reaches a renderer: a line
 * in `pithy dashboard status` forged beneath the real one, a screen cleared, a scope name read backwards.
 * Escaping them at every renderer is a promise each renderer has to keep. Refusing them at the boundary
 * is one promise, kept here.
 */
const UNRENDERABLE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/**
 * What a connection is for, in the words of whoever registered it (#721).
 *
 * **Required at registration, and refused when absent**, because a review listing credentials by key id
 * cannot support the decision it exists for. **Untrusted input**: a customer writes it and something else
 * renders it, so it is validated on the way in, and again on every read of the row.
 */
export const ConnectionPurpose = z
  .string()
  .trim()
  .min(1, "Say what this client is for.")
  .max(MAX_CONNECTION_PURPOSE, `A purpose is ${MAX_CONNECTION_PURPOSE} characters at most.`)
  .refine((purpose) => !UNRENDERABLE.test(purpose), "A purpose is one line of plain text: no control characters.")
  .describe(
    `What this connection's client is for, in the registering operator's words — one line of plain text, ${MAX_CONNECTION_PURPOSE} characters at most, with no control or bidi characters. Written by a customer and rendered elsewhere, so validated at the boundary.`,
  );
export type ConnectionPurpose = z.output<typeof ConnectionPurpose>;

/**
 * One management-client connection — the row in `pithy_controlplane_connections`.
 *
 * Keys are a versioned JSON column rather than a child table for two reasons. **Rotation becomes one
 * atomic `UPDATE`**: appending the new key and expiring the old cannot half-apply, where separate rows
 * would need a batch. And **verification stays a single read** with no join on a Worker hot path —
 * scanning two or three keys for a matching `kid` is free.
 */
export const ControlPlaneConnection = z
  .object({
    id: z
      .uuid()
      .describe(
        "The connection id — a UUID because it is the token `aud` and therefore externally exposed. Text rather than an autoincrementing integer, so connections cannot be enumerated.",
      ),
    environment: z
      .string()
      .min(1)
      .max(32)
      .describe(
        "The environment this connection is valid in (`dev`, `staging`, `production`). Checked against the Worker's own on every call, so a staging credential cannot reach production.",
      ),
    issuer: z
      .url()
      .describe(
        "The exact `iss` this connection accepts. Verified on every call, and effectively permanent — changing the management client's origin is a migration across every registered connection, not a DNS change.",
      ),
    workerUrl: z
      .url()
      .describe(
        "This environment's deployed Worker URL, captured at connect. The address the management client calls; re-pointed by `pithy dashboard connect --update` when a custom domain or a rename moves it.",
      ),
    basePath: z
      .string()
      .min(1)
      .default("/control-plane")
      .describe(
        "Where this Worker mounts the control-plane seam, captured at connect from its resolved config. Stored beside `workerUrl` because the two together fully determine the manifest address — and this is the one part of it a client cannot discover, since it *is* the manifest's own address. Defaulted rather than required so a connection registered before the column existed still parses, reading as the default it was necessarily using.",
      ),
    managementOrigin: z
      .url()
      .nullable()
      .default(null)
      .describe(
        "Where the management client that registered this connection answers — the origin the CLI calls for a verify, a rotation or a disconnect. Stored because it is not derivable: `issuer` is what that client *signs as*, and nothing says a dashboard's API answers at its own `iss`. Null for a connection registered before this column, which reads as the issuer rather than as the hosted dashboard — an older row is still a row about somebody's own deployment. Nothing on the Worker's side reads it; verification cares about `issuer` alone.",
      ),
    authorizedBy: ConnectionPrincipal.nullable()
      .default(null)
      .describe(
        "Who sanctioned this connection: the email of the signed-in Cloudflare session that registered it, never a flag. Null for a connection registered before principals were recorded (#721), which keeps working and reads as exactly that; registering again is the only way to set it.",
      ),
    actorKind: ControlPlaneActorKind.nullable()
      .default(null)
      .describe(
        "What kind of client this connection is for — `agent`, `dashboard` or `script` — stamped onto every audit row its calls write so the trail can tell them apart. Null for a connection registered before it was recorded.",
      ),
    purpose: ConnectionPurpose.nullable()
      .default(null)
      .describe(
        "What this connection's client is for, in the registering operator's words. Required at registration and editable with `pithy dashboard connect --update --purpose`; null only for a connection registered before it was recorded.",
      ),
    scopes: sqliteJson(z.array(ControlPlaneScope)).describe(
      "The operations this connection was granted, stored and enforced on the adopter's side. Enforced only by the caller, a scope would not be a limit at all.",
    ),
    keys: sqliteJson(z.array(RegisteredKey)).describe(
      "Every key this connection may sign with, current and superseded. One JSON column rather than a child table, so a rotation is one atomic UPDATE and verification is one read.",
    ),
    createdAt: SQLiteDate.describe("When the connection was registered. Ms-epoch in SQLite, a Date in TypeScript."),
    updatedAt: SQLiteDate.describe(
      "When the row last changed — a key registered or expired, or the Worker URL re-pointed.",
    ),
  })
  .describe(
    "One management-client connection: its identity, the environment and URL it is bound to, the operations it was granted, and its versioned public keys.",
  );
export type ControlPlaneConnection = z.output<typeof ControlPlaneConnection>;
export type ControlPlaneConnectionRow = z.input<typeof ControlPlaneConnection>;
