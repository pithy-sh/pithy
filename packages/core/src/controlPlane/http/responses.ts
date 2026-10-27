// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PrivacyPosture } from "../../privacy/posture";
import { PRIVACY_SOURCES } from "../../privacy/report";
import { ConnectionPrincipal, ConnectionPurpose, ControlPlaneActorKind, Ed25519PublicJwk } from "../data/connection";
import { EvidenceControlId, EvidenceSource, EvidenceState } from "../evidence/mapping";

/**
 * What the seam's own routes return, as Zod objects a management client can validate against.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. Both halves are
 * runtime values for the same reason: a management client reading a customer's Worker is crossing a
 * trust boundary and must validate what comes back, and a TypeScript interface is erased before it
 * can help. `GET /control-plane/manifest` already had a schema — {@link ControlPlaneManifest}, in
 * `discovery/adminRoute.ts`, because it is the discovery contract rather than a projection — and the
 * other four routes had none at all, `publicKeyView` returning a bare `Record<string, unknown>`.
 *
 * **No codecs, and no transform anywhere in this file.** These describe JSON on the wire, so parsing
 * one hands back exactly what went in — which is what lets a test compare the parsed value with a live
 * response and fail on a field either side forgot. A `JsonDate` here would decode an ISO string into a
 * `Date` and make that comparison meaningless.
 *
 * **Nothing here can carry a private key, because none is ever held.** The connection stores public
 * halves only, so `keys` is exactly what a client needs to see a key ageing and exactly what an
 * attacker learns nothing from.
 */

/** One registered key as a client sees it: the public half and its window. */
export const PublicKeyView = z
  .object({
    keyId: z.string().describe("The key's id, matched against a token's `kid` header."),
    publicKey: Ed25519PublicJwk.describe("The public key this id names. The private half is never held here."),
    validFrom: z.iso.datetime().describe("When this key became valid, ISO-8601. A call signed before it is rejected."),
    validUntil: z.iso
      .datetime()
      .nullable()
      .describe("When it stops being accepted, ISO-8601, or null while open-ended. Set only by the expire route."),
    revokedAt: z.iso
      .datetime()
      .nullable()
      .describe("When it was revoked outright, ISO-8601, or null. Revocation ignores the window and is immediate."),
  })
  .describe("One registered public key and its validity window. Two live at once during a rotation overlap.");
export type PublicKeyView = z.output<typeof PublicKeyView>;

/**
 * `GET /control-plane/ping`.
 *
 * It echoes the `keyId` that verified the call, so a client rotating a key can confirm *which* key
 * answered rather than inferring it from a 200 — which is the whole point of the route.
 */
export const ControlPlanePingResponse = z
  .object({
    status: z.literal("ok").describe("Always `ok`. A failure is an error payload, never this shape."),
    connectionId: z.string().describe("The connection this call authenticated as."),
    environment: z.string().describe("The environment that connection is bound to."),
    keyId: z.string().describe("The key that verified this call. The proof a newly registered key works."),
    now: z.iso.datetime().describe("This Worker's clock, ISO-8601 — what a token's lifetime is judged against."),
  })
  .describe("Connectivity, and proof of which key answered.");
export type ControlPlanePingResponse = z.output<typeof ControlPlanePingResponse>;

/** `GET /control-plane/keys` — the registration state, so a client can surface a stale key. */
export const ControlPlaneKeysResponse = z
  .object({
    connectionId: z.string().describe("The connection these keys belong to."),
    environment: z.string().describe("The environment that connection is bound to."),
    keys: z.array(PublicKeyView).describe("Every registered key, expired and revoked ones included."),
    // Added (#721), so `.optional()` as well as `.nullable()`: a client validating against a Worker that
    // predates the three columns receives none of them, and must still parse the answer.
    authorizedBy: ConnectionPrincipal.nullable()
      .optional()
      .describe(
        "Who sanctioned this connection — the signed-in session's email at registration. Null for a connection registered before principals were recorded; absent from a Worker older than the field.",
      ),
    actorKind: ControlPlaneActorKind.nullable()
      .optional()
      .describe(
        "What kind of client this connection is for: `agent`, `dashboard` or `script`. Null for a connection registered before it was recorded; absent from an older Worker.",
      ),
    purpose: ConnectionPurpose.nullable()
      .optional()
      .describe(
        "What the client is for, in the registering operator's words. Untrusted text: render it escaped. Null for a connection registered before it was recorded; absent from an older Worker.",
      ),
  })
  .describe("Every key registered against this connection, with its window, and who authorized it for what.");
export type ControlPlaneKeysResponse = z.output<typeof ControlPlaneKeysResponse>;

/** `POST /control-plane/keys` — the appended key, and the set as it now stands. */
export const RegisterKeyResponse = z
  .object({
    keyId: z.string().describe("The key just registered."),
    validFrom: z.iso.datetime().describe("When its window opened, ISO-8601 — now, by construction."),
    keys: z
      .array(PublicKeyView)
      .describe("The connection's keys after the append and the prune, so a client sees what it now holds."),
  })
  .describe("The registered key, and the set it joined.");
export type RegisterKeyResponse = z.output<typeof RegisterKeyResponse>;

/** `POST /control-plane/keys/:keyId/expire` — the retired key, and the set as it now stands. */
export const ExpireKeyResponse = z
  .object({
    keyId: z.string().describe("The key just given an end date."),
    validUntil: z.iso.datetime().describe("When its window closed, ISO-8601 — now, by construction."),
    keys: z.array(PublicKeyView).describe("The connection's keys after the expiry."),
  })
  .describe("The expired key, and the set it left behind.");
export type ExpireKeyResponse = z.output<typeof ExpireKeyResponse>;

/**
 * One migration as `GET {basePath}/migrations` reports it: its composed name, and whose it is.
 *
 * The namespace is a capability's name, which the manifest already reports in `capabilities[]`. So a
 * client tells an adopter's own migrations from a composed capability's by comparing the two — no
 * convention, and no list kept anywhere.
 */
export const MigrationView = z
  .object({
    name: z.string().describe("The composed migration name, exactly as the ledger records it: `0250_audit_0001_init`."),
    namespace: z
      .string()
      .nullable()
      .describe(
        "The capability this migration belongs to — its name, as `capabilities[]` in the manifest reports it. Null only for an undeclared migration whose name no Pithy registry could have composed.",
      ),
  })
  .describe("One migration, and the capability namespace it belongs to.");
export type MigrationView = z.output<typeof MigrationView>;

/** Whether the last group is still reversible by name, or what is in its way. */
export const MigrationGroupPositionView = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z
          .literal("top")
          .describe(
            "The group's migrations are the contiguous tip of this database's chain. Not a promise that `pithy migrate --rollback --group <value>` runs: the CLI also refuses an undeclared migration in the ledger, and keeps back or refuses a database another environment binds.",
          ),
      })
      .describe("A group nothing on this database's ledger sits over."),
    z
      .object({
        state: z
          .literal("buried")
          .describe("Something sits over the group or inside it, so reversing it by name is refused."),
        above: z.array(z.string()).describe("The groups in the way, newest first."),
        ungrouped: z
          .array(MigrationView)
          .describe(
            "The migrations in the way that no group claims, newest first. Nothing can be reversed by group while one of them is at the tip.",
          ),
      })
      .describe("A group with something in its way, and what that is."),
  ])
  .describe("Where the last group sits in this database's chain: the top, or buried under named things.");
export type MigrationGroupPositionView = z.output<typeof MigrationGroupPositionView>;

/** The run that last moved a database, and whether it can still be taken back. */
export const MigrationGroupView = z
  .object({
    group: z
      .string()
      .describe("The group's value: the `--group` the run was given, or the ISO-8601 timestamp it generated."),
    appliedAt: z.iso.datetime().describe("When this group last applied something here, ISO-8601."),
    migrations: z
      .array(MigrationView)
      .describe("What this group applied in this database and is still applied, in application order."),
    position: MigrationGroupPositionView.describe("Whether the group is the top of the chain, or what is in its way."),
  })
  .describe("The newest group with anything still applied in this database.");
export type MigrationGroupView = z.output<typeof MigrationGroupView>;

/**
 * One database this Worker binds, read or not.
 *
 * **An unreadable database carries no list at all**, never empty ones. `pending: []` reads as up to date,
 * and a database nobody read is not that. The state is on the value, so a client reaches a list only by
 * narrowing.
 */
export const MigrationDatabaseView = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("readable").describe("This database's ledger was read."),
        database: z.string().describe("The database name, as capabilities declare it in `databases`."),
        binding: z.string().describe("The D1 binding it is read through, as `wrangler.jsonc` declares it."),
        applied: z.array(MigrationView).describe("Every applied migration, in the order the ledger applied them."),
        pending: z
          .array(MigrationView)
          .describe("Declared by this build and not applied here, in the order they would run."),
        undeclared: z
          .array(MigrationView)
          .describe(
            "Applied here and not declared by this Worker, sorted. Relative to this Worker: a database shared with another Worker lists that Worker's migrations here. Otherwise Kysely reads one as a corrupted chain and applies nothing.",
          ),
        lastGroup: MigrationGroupView.nullable().describe(
          "The newest group with anything applied here, or null when nothing applied here was ever grouped.",
        ),
      })
      .describe("A database whose ledger was read."),
    z
      .object({
        state: z.literal("unreadable").describe("This database's ledger could not be read on this call."),
        database: z.string().describe("The database name, as capabilities declare it in `databases`."),
        binding: z.string().describe("The D1 binding it would be read through."),
      })
      .describe(
        "A database that could not be read. No lists, so nothing about it reads as zero. The other databases still answer.",
      ),
  ])
  .describe("One database this Worker binds: its migration state, or the fact that it could not be read.");
export type MigrationDatabaseView = z.output<typeof MigrationDatabaseView>;

/**
 * `GET /control-plane/migrations` — where every database this Worker binds stands.
 *
 * Asked of the Worker because the Worker *is* the deployed build. `pithy doctor` reads the project on disk,
 * which is what the operator has and not necessarily what is deployed.
 */
export const ControlPlaneMigrationsResponse = z
  .object({
    environment: z.string().describe("The environment this Worker answers for."),
    databases: z
      .array(MigrationDatabaseView)
      .describe("One entry per database this Worker binds, sorted by database name. One unreadable costs only itself."),
  })
  .describe("What is applied, pending and undeclared in each bound database, and which run put it there.");
export type ControlPlaneMigrationsResponse = z.output<typeof ControlPlaneMigrationsResponse>;

/**
 * One marked field, as `GET {basePath}/privacy` reports it (#132).
 *
 * **The per-field record.** Since #390 it says whether the field rests encrypted beside `class`, so "which of
 * your PHI fields are encrypted" is a derivation over this list rather than a second inventory to keep.
 */
export const PrivacyFieldView = z
  .object({
    path: z
      .string()
      .describe(
        "Where the field sits. A D1 column path (`email`, `address.line1`, `profile.phone` inside a JSON column), or a KV entry's part first (`key.email`, `value.token`, `metadata.ip`, or `value` for a whole marked value). An array element is `[]`, a record's value `*`.",
      ),
    class: z
      .string()
      .describe("The privacy class it is marked with: `secret`, `pii`, `phi`, `pci`, or an adopter's own."),
    truncated: z
      .literal(true)
      .optional()
      .describe(
        "Set where the class is assumed rather than found: a read ran out of its budget there, or the schema could not be read at all, so any class may be marked below it. Absent where the schema was read to the end.",
      ),
    sameAs: z
      .string()
      .optional()
      .describe(
        "Set on a reference: the path this field's position was first listed under, once the list reached its cap on paths. The class is marked somewhere beneath both, and the paths beneath this one are those beneath that one.",
      ),
    encryptedAtRest: z
      .boolean()
      .optional()
      .describe(
        "Whether the field rests encrypted (#390). Absent where the core cannot say — an assumed class, a reference, or a core older than encrypted fields — and never defaulted to false.",
      ),
    unrotatable: z
      .literal(true)
      .optional()
      .describe(
        "Set on an encrypted field whose storage is not D1: it can never be rotated, and it blocks retirement.",
      ),
  })
  .describe("One marked field and its class.");
export type PrivacyFieldView = z.output<typeof PrivacyFieldView>;

/** One storage schema holding at least one marked field. */
export const PrivacySchemaView = z
  .object({
    capability: z
      .string()
      .describe("The capability that declared the schema, as the manifest's `capabilities[]` names it."),
    storage: z.enum(PRIVACY_SOURCES).describe("Where it is stored: a `d1` table or a `kv` store."),
    container: z.string().describe("The D1 database name or the KV namespace name it lives in."),
    name: z.string().describe("The table name, or the KV store name."),
    fields: z.array(PrivacyFieldView).describe("Every marked field in it, in schema order."),
    encrypted: z
      .array(
        z
          .object({
            path: z.string().describe("Where the encrypted field sits, on the same paths as `fields[].path`."),
            unrotatable: z
              .literal(true)
              .optional()
              .describe("Set where the storage is not D1, so the field can never be rotated."),
          })
          .describe("One encrypted field."),
      )
      .optional()
      .describe(
        "Every field marked encrypted at rest, classed or not (#390). Absent on a Worker whose core predates encrypted fields.",
      ),
  })
  .describe("One storage schema and the marked fields it holds.");
export type PrivacySchemaView = z.output<typeof PrivacySchemaView>;

/**
 * `GET /control-plane/privacy` — the full inventory, behind `privacy:read` (#132).
 *
 * Derived at runtime from the schemas this Worker composed, walked once per isolate. The manifest's `privacy`
 * block is the headline; this is the detail, and it names fields, which is why it has a scope of its own.
 */
export const ControlPlanePrivacyResponse = z
  .object({
    environment: z.string().describe("The environment this Worker answers for."),
    posture: PrivacyPosture.describe("The declared and observed classes, the delta, and the console gate."),
    schemasWalked: z
      .number()
      .int()
      .nonnegative()
      .describe("How many storage schemas were walked, marked or not, across the sources `posture.sources` names."),
    schemas: z
      .array(PrivacySchemaView)
      .describe("Every schema holding a marked field, in composition order. A schema with none is not listed."),
  })
  .describe(
    "Every schema this Worker stores that holds a marked field, each field's path and class, and where it lives.",
  );
export type ControlPlanePrivacyResponse = z.output<typeof ControlPlanePrivacyResponse>;

/**
 * One value a fact carries: a scalar, a list of names, or null where the record holds nothing.
 *
 * Scalars and string lists only, so a fact can never carry a row, a secret, or a key: it names and counts.
 */
export const EvidenceValue = z
  .union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string().describe("One name."))])
  .describe("A fact's value: a word, a number, a flag, a list of names, or null where the record holds none.");
export type EvidenceValue = z.output<typeof EvidenceValue>;

/** One fact the Worker read for a control, and the declaration it read it from (#821). */
export const EvidenceFact = z
  .object({
    fact: z.string().describe("What the fact is, as one camelCase name: `auditRecorder`, `liveKeys`, `pending`."),
    subject: z
      .string()
      .optional()
      .describe(
        "What the fact is about where a control reads several of one thing: a connection id, a database name, a capability, a class, a strategy. Absent where the fact is about the Worker as a whole.",
      ),
    value: EvidenceValue.describe("What the Worker read."),
    source: EvidenceSource.describe("The declaration or record it was read from."),
  })
  .describe("One fact behind a control, and where it came from.");
export type EvidenceFact = z.output<typeof EvidenceFact>;

/** One control in the pack: its references, the facts read, and what the Worker could say (#821). */
export const EvidenceEntry = z
  .object({
    control: EvidenceControlId,
    title: z.string().describe("The control in one line, as the mapping table names it."),
    soc2: z
      .array(z.string().describe("One criterion, such as `CC6.1`."))
      .describe("The AICPA Trust Services Criteria this control answers."),
    iso27001: z
      .array(z.string().describe("One Annex A control, such as `A.8.15`."))
      .describe("The ISO/IEC 27001:2022 Annex A controls this control answers."),
    state: EvidenceState,
    reasons: z
      .array(z.string().describe("One sentence."))
      .describe(
        "For `gap`, what is missing. For `not-derivable`, why the Worker cannot say. Empty when `evidenced`. Where both kinds apply, the gaps come first.",
      ),
    facts: z
      .array(EvidenceFact)
      .describe("Every fact read for this control, each naming its source. Read from declarations, never typed in."),
  })
  .describe("One control: what it answers, what the Worker read, and what it could say. Evidence, never a judgment.");
export type EvidenceEntry = z.output<typeof EvidenceEntry>;

/**
 * `GET /control-plane/evidence` — the evidence pack, behind `evidence:read` (#821).
 *
 * Computed in the Worker because the Worker is the deployed build: every fact is read from what this build
 * composes and records. It proves controls present and performs nothing.
 */
export const ControlPlaneEvidenceResponse = z
  .object({
    environment: z.string().describe("The environment this Worker answers for."),
    generatedAt: z.iso.datetime().describe("When this Worker read the facts, ISO-8601."),
    version: z
      .string()
      .nullable()
      .describe("The Cloudflare version id of the build that answered, or null where the binding is absent."),
    mappingVersion: z
      .number()
      .int()
      .positive()
      .describe(
        "The version of the kit's mapping table these entries follow. A control, a reference or a rule moving is a new version.",
      ),
    controls: z
      .array(EvidenceEntry)
      .describe("One entry per control in the mapping table, in its order. Evidence for an auditor to weigh."),
  })
  .describe(
    "SOC 2 and ISO 27001 evidence this Worker derives from its own declarations. Each control names its facts, their sources and what could be said. An auditor decides the rest.",
  );
export type ControlPlaneEvidenceResponse = z.output<typeof ControlPlaneEvidenceResponse>;
