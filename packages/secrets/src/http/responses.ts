// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SecretRotation } from "@pithy-sh/core/src/capability/secretOrigin";
import { z } from "zod";
import { RotationStatus, RotationTrigger } from "../data/secretRotations";
import { SecretBackend, SecretValueType } from "../registry";
import { SecretRotationStatus, SecretRotationUnchangedReason } from "../rotation/rotateValue";
import type { CarriesNoValue } from "../valueBearing";

/**
 * What the secrets management routes return, as Zod objects a client can validate against.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. Both halves are
 * runtime values rather than interfaces because a management client reading a customer's Worker is
 * crossing a trust boundary and must validate what comes back — and a TypeScript interface is erased
 * before it can help, so every client that had only an interface hand-wrote a mirror and the mirror
 * drifted the first time a field landed here.
 *
 * **No codecs and no transforms.** These describe JSON on the wire, so parsing one hands back exactly
 * what went in. Dates render as ISO-8601 strings: they are ms-epoch integers in SQLite and `Date`s in
 * TypeScript, and a JSON number would leave every client guessing the unit.
 *
 * **One deliberate exception, and it is a rewrite rather than a decode: `rotation.issuer`.** `SecretRotation`
 * comes from core with `SecretIssuer.catch("other")` on its issuer field, so a client parsing a response
 * from a Worker running a *newer* kit than itself renders `other` instead of throwing. That is the right
 * failure here for the same reason it is right on the manifest — this is third-party data from somebody
 * else's deployment, and a pane blanked over an issuer name a client did not need to understand is worse
 * than an honest *somebody issues this, and I cannot help you with them.* It rewrites a field, never a key,
 * so nothing merges and nothing is lost; see `secretOrigin.ts`'s `IssuerKey` for why that distinction is
 * load-bearing.
 *
 * **Nothing here can carry a value.** The field lists are the same argument `admin/status.ts` makes
 * about its reader shapes, restated at the wire, and {@link SECRET_RESPONSES_CARRY_NO_VALUE} is the
 * compile-time tripwire that keeps it true. A ciphertext, an IV, a metadata snapshot and a rotation's
 * error message are all absent from the type rather than omitted by a projection.
 *
 * **A browser imports this file, so it reaches no module that needs the Workers runtime** — which is
 * why `CarriesNoValue` comes from `../valueBearing.ts` and not from `admin/status.ts`, where it was
 * declared until #419. The reader is a Kysely module; importing a *type* out of it still put the D1
 * layer in the browser program's file set, and `@pithy-sh/support` shipped the version of that mistake
 * where the reached module named a bare Workers global and the adopter's client build went red.
 * `tooling/browser-scopes` compiles this module with `types: []` and walks its imports.
 */

/** One rotation attempt on the wire. */
export const SecretRotationView = z
  .object({
    startedAt: z.iso.datetime().describe("When the rotation attempt began, ISO-8601."),
    completedAt: z.iso.datetime().nullable().describe("When it finished, ISO-8601; null while it is still running."),
    status: RotationStatus.describe("How it ended: `in_progress`, `success`, or `failed`."),
    trigger: RotationTrigger.describe("What caused it: `cron`, `manual`, or the `baseline` marker on first write."),
    rotatedBy: z.string().describe("Who or what initiated it — a workflow instance id, an operator id, or `baseline`."),
  })
  .describe("One rotation attempt as a client reads it. A failure is a status, never a message.");
export type SecretRotationView = z.output<typeof SecretRotationView>;

/** One secret's status on the wire. */
export const SecretStatusView = z
  .object({
    name: z.string().describe("The secret's registry name."),
    backend: SecretBackend.describe("Where the value lives. Decides what a null `createdAt` means."),
    valueType: SecretValueType.describe("How the value is interpreted: `text` or `json`."),
    rotatable: z.boolean().describe("Whether a value-rotator may manage it. Never changes what is reported."),
    rotation: SecretRotation.nullable().describe(
      "How this secret is replaced: `local`, `provider`, or `manual` — with the issuer, and the page a human goes to. Null when the registry declares nothing, which is not the same as `manual`. **This is the field a client branches on to decide whether a rotation control exists at all**, and it is metadata by construction: a kind, an issuer and an `https:` documentation URL are all it can hold. An issuer this client has never heard of parses as `other` rather than failing, so a Worker newer than its reader still renders.",
    ),
    keyVersion: z
      .number()
      .int()
      .nullable()
      .describe("Which master-key version the stored envelope sits under, or null when nothing is stored here."),
    createdAt: z.iso
      .datetime()
      .nullable()
      .describe("When it was first written to this store, ISO-8601; null when it is not stored here."),
    updatedAt: z.iso
      .datetime()
      .nullable()
      .describe("When its value was last written, ISO-8601; null when it is not stored here."),
    lastRotatedAt: z.iso
      .datetime()
      .nullable()
      .describe(
        "The newest successful rotation, ISO-8601, or **null for never rotated** — not zero, and not the epoch.",
      ),
    rotationCount: z
      .number()
      .int()
      .nonnegative()
      .describe("How many rotation attempts are recorded, successful or not."),
    rotateEveryDays: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("The cadence the registry declares for this secret, or null when it declares none."),
    overdue: z
      .boolean()
      .nullable()
      .describe("Whether it is past that cadence. Null when the question has no answer, which is not the same as no."),
  })
  .describe("One secret's status as a client reads it. Metadata only — this shape cannot express a value.");
export type SecretStatusView = z.output<typeof SecretStatusView>;

/** `GET {base}/admin/status` — every declared secret. */
export const SecretsStatusResponse = z
  .object({
    secrets: z
      .array(SecretStatusView)
      .describe("Every named secret the composed Worker declares, by name. Keyed entries are excluded."),
    unreadable: z
      .array(z.string())
      .describe(
        "Declared secrets whose stored rows would not decode, by registry name — so one bad row costs its own entry and names itself, instead of costing the read (#387). Registry names only: keyed entries are excluded from this read, so no stored `<keyspace>/<key>` name can appear here. Carries no reason; why a row is malformed is a question for the database, not for a client.",
      ),
  })
  .describe("The status of every declared secret, and any whose stored rows would not decode.");
export type SecretsStatusResponse = z.output<typeof SecretsStatusResponse>;

/** `GET {base}/admin/status/:name/rotations` — one secret's history. */
export const SecretRotationsResponse = z
  .object({
    name: z.string().describe("The secret this history belongs to, echoed so a client can label it."),
    rotations: z.array(SecretRotationView).describe("Its rotation attempts, newest first, capped by `limit`."),
    unreadable: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "How many rows in this page would not decode (#387). A count and not a list, because every row here is the same secret's and what identifies one is its place in the history — which is exactly what a row with an undecodable `startedAt` cannot supply. Reported so a client can say the history is incomplete rather than render a short list as a whole one.",
      ),
  })
  .describe("One secret's rotation history, and how much of the page would not decode.");
export type SecretRotationsResponse = z.output<typeof SecretRotationsResponse>;

/**
 * `POST {base}/admin/status/:name/rotate` — what one rotation did, **per environment and never in
 * aggregate**.
 *
 * This is `SecretRotationOutcome` projected for the wire, field by field, and the projection is where two
 * things are dropped on purpose:
 *
 * - **`cause`.** The core carries whatever the store threw, typed `unknown`, for the command to render into
 *   a `detail`. An `unknown` on a response schema is a hole of arbitrary shape pointed at a management
 *   client, filled by an exception raised at a site that was handling a value. It does not cross.
 * - **Anything a value could sit in.** There is no such field, which is the same structural argument the
 *   core makes about its own outcome: a payload with nowhere to put a secret cannot leak one by a later
 *   caller's oversight. {@link SECRET_RESPONSES_CARRY_NO_VALUE} is the tripwire.
 *
 * **It answers 200 for every one of the four statuses, including `unrecorded`**, and that is a decision
 * rather than an oversight. The alternative — throwing `secrets/rotation_unrecorded` so the incident
 * arrives as a 500 — renders one sentence and drops `recorded` and `stranded` on the floor, which is
 * exactly the "all rotated" summary over a partial failure that this whole design refuses. The status is a
 * required field of a closed enum, so a client that validates its response cannot fail to see it, and the
 * audit event for that member is `critical`.
 */
export const SecretRotationOutcomeView = z
  .object({
    name: z.string().describe("The secret that was rotated, echoed so a client can label the result."),
    status: SecretRotationStatus.describe(
      "How it ended: `rotated`, `unchanged`, `unrecorded`, or `failed`. `unrecorded` is the one that needs a human in a console now — read it before `recorded`.",
    ),
    kind: z
      .enum(["local", "provider", "manual"])
      .describe(
        "How the registry says this secret is replaced — the same fact `rotation.kind` reports on a status read.",
      ),
    rolled: z
      .boolean()
      .describe(
        "Whether the issuer's credential was actually replaced. True only for a `provider` rotation that reached its rotator; a `local` mint rolls nothing anywhere.",
      ),
    rollFailed: z
      .boolean()
      .describe(
        "Whether the **rotator itself** threw, rather than the store after it. With `rolled`, this is the difference between *was rolled* and *may have been rolled*: a call that reached the issuer and lost its answer cannot be told from one that never landed, and a report claiming either is wrong half the time about the fact being acted on. False on every run that never called a rotator.",
      ),
    recorded: z
      .array(z.string())
      .describe("The environments this run wrote the new value to, in the order each write landed."),
    stranded: z
      .array(z.string())
      .describe(
        "The environments the new value never reached. Empty on a run that finished. With `rolled` true these hold a credential the issuer has already retired.",
      ),
    reason: SecretRotationUnchangedReason.nullable().describe(
      "Why nothing was called, when nothing was — `manual` for a secret only a human can replace. Null whenever something was attempted.",
    ),
    attempts: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("How many store attempts the failing environment cost. Null when nothing was stored."),
  })
  .describe(
    "What one rotation did, per environment. Facts only, no prose, and no field a value or an exception could sit in.",
  );
export type SecretRotationOutcomeView = z.output<typeof SecretRotationOutcomeView>;

/** `POST {base}/admin/status/:name/rotate` — one secret, one outcome. */
export const SecretRotateResponse = z
  .object({
    rotation: SecretRotationOutcomeView.describe(
      "The outcome. One secret per call, so there is no summary line to hide a partial failure behind.",
    ),
  })
  .describe("One secret's rotation outcome.");
export type SecretRotateResponse = z.output<typeof SecretRotateResponse>;

/**
 * The wire half of the constraint. `true` only while no response shape names a value-bearing field; add
 * one and this assignment stops compiling.
 */
export const SECRET_RESPONSES_CARRY_NO_VALUE: CarriesNoValue<SecretStatusView> &
  CarriesNoValue<SecretRotationView> &
  CarriesNoValue<SecretRotationOutcomeView> = true;
