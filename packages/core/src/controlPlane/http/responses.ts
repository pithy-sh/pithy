// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PrivacyPosture } from "../../privacy/posture";
import { PRIVACY_SOURCES } from "../../privacy/report";
import { BASIS_SOURCES, LegalBasis, PROCESSING_GAP_KINDS, RECIPIENT_SOURCES } from "../../processing/vocabulary";
import {
  ConnectionCredentialKind,
  ConnectionPrincipal,
  ConnectionPurpose,
  ControlPlaneActorKind,
  Ed25519PublicJwk,
} from "../data/connection";
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
 * One OIDC trust as `GET {basePath}/keys` lists it: who it admits, beside who sanctioned it.
 *
 * **The subject constraint is on the face of the listing**, because it *is* the population: a trust pinned to a
 * workflow is usable by anyone who can run that workflow, and the claims are the only place that is written down.
 * Nothing here is secret — an issuer, an audience and claim values are all public facts about a workload.
 */
export const TrustView = z
  .object({
    trustId: z.string().describe("The trust's id, as a call names it on `pithy-control-plane-trust`."),
    issuer: z.string().describe("The `iss` the trust accepts."),
    audience: z.string().describe("The `aud` a token must name."),
    claims: z
      .record(z.string().describe("A claim name."), z.string().describe("The value that claim must have."))
      .describe("The subject constraint: every named claim must equal its value. This is who may use the trust."),
    authorizedBy: z.string().describe("Who sanctioned the trust — never who may use it."),
    validFrom: z.iso.datetime().describe("When the trust was registered, ISO-8601."),
    revokedAt: z.iso
      .datetime()
      .nullable()
      .describe("When it was revoked, ISO-8601, or null. A token already minted stays usable until it expires."),
    firstCallAt: z.iso
      .datetime()
      .nullable()
      .describe("When a call first verified under it, ISO-8601, or null while it is awaiting a first call."),
  })
  .describe("One OIDC trust: who it admits, and who sanctioned it.");
export type TrustView = z.output<typeof TrustView>;

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
    // `.optional()` as well as `.nullable()`: a Worker that predates the three columns sends none of them.
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
    trusts: z
      .array(TrustView)
      .optional()
      .describe("Every OIDC trust on this connection, revoked ones included. Absent from a Worker older than trusts."),
  })
  .describe("Every key and trust registered against this connection, and who authorized it for what.");
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
 * One marked field, as `GET {basePath}/privacy` reports it.
 *
 * **The per-field record.** It says whether the field rests encrypted beside `class`, so "which of
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
 * `GET /control-plane/privacy` — the full inventory, behind `privacy:read`.
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

/** One fact the Worker read for a control, and the declaration it read it from. */
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

/** One control in the pack: its references, the facts read, and what the Worker could say. */
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
 * `GET /control-plane/evidence` — the evidence pack, behind `evidence:read`.
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

/** Where a purge stands. */
export const ErasureState = z
  .enum(["scheduled", "in_progress", "complete", "failed"])
  .describe(
    "Where the purge stands: `scheduled`, deleted with its window still open and nothing erased yet; `in_progress`, due and not yet finished; `complete`, every step ran and the `purged` record is written; `failed`, the purge gave up at the step it names, until the next daily pass starts it again.",
  );
export type ErasureState = z.output<typeof ErasureState>;

/** One recorded audit event, cited by id and chain position. Never its personal values. */
export const ErasureCitation = z
  .object({
    eventId: z.string().describe("The audit event's stable public id."),
    action: z.string().describe("Its `domain/reason` action."),
    occurredAt: z.iso.datetime().describe("When it was recorded, ISO-8601."),
    tenant: z
      .string()
      .nullable()
      .describe("The tenant whose chain holds it, or null for the untenanted chain. `pithy audit verify` walks it."),
    seq: z
      .number()
      .int()
      .nullable()
      .describe("Its 1-based position in that chain, or null for an event recorded before the chain began."),
    hash: z.string().nullable().describe("Its chain hash, or null for an event recorded before the chain began."),
  })
  .describe(
    "One audit event the attestation rests on, by id and chain position. The chain (#822) is what makes it tamper-evident; nothing here is signed.",
  );
export type ErasureCitation = z.output<typeof ErasureCitation>;

/** One purge step: whose rows, what happened to them, and the event that records it. */
export const ErasureStepView = z
  .object({
    capability: z.string().describe("The capability whose rows this step answered for."),
    disposition: z
      .enum(["erased", "retained"])
      .describe(
        "`erased`, the rows were deleted or anonymized; `retained`, the capability kept them under the reason it stated (#814). A retained step never reads as erased.",
      ),
    reason: z
      .string()
      .nullable()
      .describe(
        "For a retained step, the basis the capability stated, written for the person. Null for an erased step.",
      ),
    summary: z
      .string()
      .nullable()
      .describe(
        "For an erased step, what the capability says it erases. Null for a retained step, and when none was given.",
      ),
    completedAt: z.iso.datetime().describe("When the step finished, ISO-8601."),
    audit: ErasureCitation.nullable().describe(
      "The audit event that records this step, or null when the trail holds none: no audit composed, or a step run before #823.",
    ),
  })
  .describe("One step of a purge: one capability's rows, erased or kept with a reason, and the event that records it.");
export type ErasureStepView = z.output<typeof ErasureStepView>;

/** The subject an attestation is about: its kind and its id, and nothing else. */
export const ErasureSubjectView = z
  .object({
    type: z.enum(["user", "organization"]).describe("The kind of subject."),
    id: z.string().describe("Its id, the one value the trail keeps about it."),
  })
  .describe("Who was erased: the kind of subject and its id. No address, no name.");
export type ErasureSubjectView = z.output<typeof ErasureSubjectView>;

/** One subject's erasure, attested. */
export const ErasureAttestation = z
  .object({
    subject: ErasureSubjectView,
    deletion: z
      .object({
        at: z.iso.datetime().describe("When the subject was deleted, ISO-8601."),
        actorType: z
          .string()
          .describe(
            "Who deleted it: `control-plane` (a management client), `user` (the account's own holder) or `system`.",
          ),
        reason: z.string().nullable().describe("Why, in the words of whoever deleted it. Null when nobody had to say."),
        mode: z
          .enum(["soft", "hard"])
          .nullable()
          .describe(
            "`soft`, with a window to restore it; `hard`, with none — a soft deletion brought forward reads as `hard`. Null for a deletion recorded before #823.",
          ),
        purgeAfter: z.iso
          .datetime()
          .nullable()
          .describe("When the purge came due, ISO-8601. Null for a deletion recorded before #823."),
        audit: ErasureCitation.nullable().describe(
          "The audit event that records the deletion, or null when the trail holds none.",
        ),
      })
      .describe("The deletion the purge erases under."),
    state: ErasureState,
    overdue: z
      .boolean()
      .describe("True when the purge came due more than two days ago and has not completed: a daily pass was missed."),
    stoppedAt: z
      .string()
      .nullable()
      .describe(
        "For a failed purge, the step it gave up at. For an overdue one, the last step it finished, or `due` when none has run. Null otherwise.",
      ),
    steps: z
      .array(ErasureStepView)
      .describe(
        "Every step that has run, in the order it first ran. A step run again on a later pass is shown once, as it last finished.",
      ),
    completedAt: z.iso.datetime().nullable().describe("When the purge finished, ISO-8601. Null until it has."),
    completion: ErasureCitation.nullable().describe(
      "The audit event that records the purge finishing, or null until it has, or when the trail holds none.",
    ),
    failure: ErasureCitation.nullable().describe("The audit event that records the purge giving up, or null."),
    trail: z
      .enum(["recorded", "absent"])
      .describe(
        "`recorded` when an audit capability is composed and its events are cited; `absent` when none is, so nothing here is cited and the lifecycle rows are the only record.",
      ),
  })
  .describe(
    "Proof that one subject's erasure happened: the deletion, every step with its disposition, the state, and the audit events that record each one.",
  );
export type ErasureAttestation = z.output<typeof ErasureAttestation>;

/** `GET /control-plane/erasure/:subjectType/:subjectId` — one subject's attestation, behind `erasure:read`. */
export const ControlPlaneErasureSubjectResponse = z
  .object({
    generatedAt: z.iso.datetime().describe("When this Worker read the records, ISO-8601."),
    attestation: ErasureAttestation,
  })
  .describe("One subject's erasure attestation, read from the purge's own record and cited in the audit chain.");
export type ControlPlaneErasureSubjectResponse = z.output<typeof ControlPlaneErasureSubjectResponse>;

/** One purge in a period: who, where it stands, and where it stopped. */
export const ErasurePeriodEntry = z
  .object({
    subject: ErasureSubjectView,
    state: ErasureState,
    overdue: z.boolean().describe("True when it came due more than two days ago and has not completed."),
    purgeAfter: z.iso.datetime().nullable().describe("When it came due, or null for a deletion recorded before #823."),
    completedAt: z.iso.datetime().nullable().describe("When it finished, or null until it has."),
    stoppedAt: z
      .string()
      .nullable()
      .describe("For a failed or overdue purge, the step it stopped at — `due` when none has run. Null otherwise."),
  })
  .describe("One purge in the period, summarized. Its full record is the subject read.");
export type ErasurePeriodEntry = z.output<typeof ErasurePeriodEntry>;

/** `GET /control-plane/erasure` — every purge in a period, counted. */
export const ControlPlaneErasurePeriodResponse = z
  .object({
    generatedAt: z.iso.datetime().describe("When this Worker read the records, ISO-8601."),
    since: z.iso.datetime().describe("The window's inclusive start, ISO-8601."),
    until: z.iso.datetime().describe("The window's inclusive end, ISO-8601."),
    subjects: z
      .array(z.enum(["user", "organization"]).describe("One kind of subject."))
      .describe(
        "The kinds of subject this Worker records purges for. A kind not listed was not read, because nothing composed records it.",
      ),
    counts: z
      .object({
        scheduled: z.number().int().describe("Deleted, with the window still open."),
        inProgress: z.number().int().describe("Due, and not yet finished."),
        complete: z.number().int().describe("Finished."),
        failed: z.number().int().describe("Gave up, until the next pass."),
        overdue: z
          .number()
          .int()
          .describe("Not finished more than two days after coming due. Counted within the states above."),
      })
      .describe("How many purges in the window stand where."),
    attention: z
      .array(ErasurePeriodEntry)
      .describe("Every failed or overdue purge in the window, each with the step it stopped at."),
    purges: z.array(ErasurePeriodEntry).describe("Every purge in the window, oldest due first."),
  })
  .describe(
    "Every purge in a period: counts of complete, in-progress and failed, and each failed or overdue one named with the step it stopped at.",
  );
export type ControlPlaneErasurePeriodResponse = z.output<typeof ControlPlaneErasurePeriodResponse>;

/** One legal hold, as the holds routes answer it. */
export const LegalHoldView = z
  .object({
    id: z.string().describe("The hold's id. Name it to release the hold."),
    subjectType: z
      .enum(["user", "organization", "audit"])
      .describe("What the hold preserves: a user, an organization, or a tenant's audit trail."),
    subjectId: z
      .string()
      .nullable()
      .describe(
        "The held user's or organization's id, or the tenant whose trail is held. Null for the untenanted trail.",
      ),
    reason: z.string().describe("Why it was placed."),
    placedBy: z.string().describe("The management client's user id that placed it."),
    placedAt: z.iso.datetime().describe("When it was placed, ISO-8601."),
    state: z.enum(["active", "released"]).describe("`active` while it stands; `released` once lifted."),
    releasedAt: z.iso.datetime().nullable().describe("When it was released, ISO-8601, or null while it stands."),
    releasedBy: z.string().nullable().describe("Who released it, or null while it stands."),
    releaseReason: z.string().nullable().describe("Why it was released, or null while it stands."),
  })
  .describe("A legal hold on one user, one organization or one tenant's audit trail.");
export type LegalHoldView = z.output<typeof LegalHoldView>;

/** `GET /control-plane/holds`. */
export const ControlPlaneHoldsResponse = z
  .object({
    active: z.number().int().nonnegative().describe("How many holds stand, whatever the listing was narrowed to."),
    holds: z.array(LegalHoldView).describe("The holds, standing first, newest first within each."),
  })
  .describe("This Worker's legal holds.");
export type ControlPlaneHoldsResponse = z.output<typeof ControlPlaneHoldsResponse>;

/** `POST /control-plane/holds` and `POST /control-plane/holds/:holdId/release`: the hold as it now stands. */
export const ControlPlaneHoldResponse = z
  .object({ hold: LegalHoldView })
  .describe("One legal hold, as the call left it.");
export type ControlPlaneHoldResponse = z.output<typeof ControlPlaneHoldResponse>;

/** What kind of gap the processing record names. */
export const ProcessingGapKind = z
  .enum(PROCESSING_GAP_KINDS)
  .describe(
    "What is missing: `no-legal-basis` (an activity states none), `no-consent-purpose` (a consent basis names no purpose the catalog holds), `class-not-stored` (an activity claims a class nothing stores), `class-unclaimed` (a capability stores a class no activity claims), `phi-not-covered` (a stored `phi` field no consent purpose covers), or `no-standing-grant` (a purpose covering a class holds no standing grant).",
  );
export type ProcessingGapKind = z.infer<typeof ProcessingGapKind>;

/** One gap in the processing record. */
export const ProcessingGap = z
  .object({
    kind: ProcessingGapKind,
    subject: z
      .string()
      .describe(
        "What the gap is about: an activity id, a capability name, a consent purpose id, or a stored field as `<capability>/<table>.<path>`. A stored field is named only to a connection that also holds `privacy:read`; without it, the gap names the capability.",
      ),
    detail: z.string().describe("What is missing, in one sentence."),
  })
  .describe("Something the record needs and the Worker does not declare. Named, never filled in.");
export type ProcessingGap = z.infer<typeof ProcessingGap>;

/** Where a recipient in the record came from. */
export const ProcessingRecipientSource = z
  .enum(RECIPIENT_SOURCES)
  .describe(
    "Where the recipient came from: `platform`, Cloudflare, which runs every Worker; `binding`, a binding this Worker has, such as Workers AI; `declared`, an activity's own declaration, built from the resolved config.",
  );

/** One recipient of personal data. */
export const ProcessingRecipientView = z
  .object({
    name: z.string().describe("Who receives the data."),
    receives: z.string().describe("What they receive."),
    classes: z.array(z.string()).describe("The data classes in what they receive."),
    source: ProcessingRecipientSource,
  })
  .describe("One recipient: who, what it receives, the classes in it, and where the record learned of it.");
export type ProcessingRecipientView = z.infer<typeof ProcessingRecipientView>;

/** A consent-based activity's purpose, with where its subjects stand. */
export const ProcessingConsentView = z
  .object({
    purpose: z.string().describe("The consent purpose id the activity rests on."),
    noticeVersion: z
      .number()
      .int()
      .nullable()
      .describe("The purpose's current notice version. Null when no composed catalog declares the purpose."),
    explicit: z.boolean().nullable().describe("Whether the purpose needs explicit consent. Null when undeclared."),
    grants: z
      .number()
      .int()
      .nullable()
      .describe("Subjects whose latest choice is a grant. Null when the consent record could not be read."),
    withdrawals: z
      .number()
      .int()
      .nullable()
      .describe("Subjects whose latest choice is a withdrawal. Null when the consent record could not be read."),
    standing: z
      .number()
      .int()
      .nullable()
      .describe(
        "Subjects whose grant stands now: current notice, at the minimum method, unexpired. Null when the consent record could not be read.",
      ),
  })
  .describe("The consent purpose a consent-based activity rests on, and its grant counts.");
export type ProcessingConsentView = z.infer<typeof ProcessingConsentView>;

/** How long the data an activity uses is kept. */
export const ProcessingRetentionView = z
  .object({
    classAges: z
      .array(
        z
          .object({
            class: z.string().describe("The privacy class."),
            days: z.number().int().describe("The longest an account holding it may sit inactive, in days."),
          })
          .describe("One class age."),
      )
      .describe("The retention block's class ages for the classes this activity uses, strictest first."),
    purgeWindows: z
      .array(
        z
          .object({
            subject: z.enum(["user", "organization"]).describe("Whose deletion the window governs."),
            days: z.number().int().describe("How many days a deletion stays restorable before its purge."),
            source: z.enum(["policy", "capability", "floor"]).describe("Where the value came from."),
          })
          .describe("One soft-delete window."),
      )
      .describe("Every soft-delete window the Worker runs, as it takes effect."),
  })
  .describe("The effective retention behind an activity: its classes' ages and the purge windows.");
export type ProcessingRetentionView = z.infer<typeof ProcessingRetentionView>;

/** One activity in the record. */
export const ProcessingEntry = z
  .object({
    id: z.string().describe("The activity id, `<domain>.<name>`."),
    purpose: z.string().describe("Why the data is processed."),
    declaredBy: z.string().describe("The capability that declared it, or `config` for the adopter's own."),
    classes: z.array(z.string()).describe("The data classes it uses."),
    legalBasis: LegalBasis.nullable().describe("Its legal basis, or null: a gap the record names."),
    basisSource: z
      .enum(BASIS_SOURCES)
      .nullable()
      .describe("Where the basis came from: the declaring `capability`, or the `config` block. Null with no basis."),
    consent: ProcessingConsentView.nullable().describe("For a consent basis, its purpose and grant counts. Else null."),
    recipients: z
      .array(ProcessingRecipientView)
      .describe("Who receives its data: Cloudflare always, then any binding or declared recipient."),
    retention: ProcessingRetentionView.nullable().describe(
      "How long its data is kept, from the Worker's resolved retention. Null when the Worker recorded none.",
    ),
    measures: z
      .array(EvidenceControlId)
      .describe("The evidence pack's controls that protect this activity's data, by id. `measures` states each."),
    gaps: z.array(ProcessingGap).describe("What this activity is missing. Empty when nothing is."),
  })
  .describe("One processing activity, as GDPR Article 30 lists it.");
export type ProcessingEntry = z.infer<typeof ProcessingEntry>;

/** One security measure, as the evidence pack names it. */
export const ProcessingMeasure = z
  .object({
    control: EvidenceControlId,
    title: z.string().describe("What the control is."),
    soc2: z.array(z.string()).describe("Its SOC 2 Trust Services Criteria references."),
    iso27001: z.array(z.string()).describe("Its ISO/IEC 27001:2022 Annex A references."),
    state: EvidenceState.nullable().describe(
      "What the evidence pack says of it now. Null when the connection does not hold `evidence:read`.",
    ),
  })
  .describe("A technical or organizational security measure, cited from the evidence pack.");
export type ProcessingMeasure = z.infer<typeof ProcessingMeasure>;

/**
 * `GET /control-plane/processing` — the record of processing activities, behind `processing:read`. It describes
 * the processing and changes none of it.
 */
export const ControlPlaneProcessingResponse = z
  .object({
    environment: z.string().describe("The environment this Worker serves."),
    generatedAt: z.iso.datetime().describe("When the record was derived, ISO-8601."),
    version: z.string().nullable().describe("The Cloudflare version id of the build answering, or null."),
    activities: z
      .array(ProcessingEntry)
      .describe("Every activity: each capability's, in composition order, then the adopter's."),
    recipients: z
      .array(ProcessingRecipientView)
      .describe("Every recipient across the record, once each: Cloudflare first, then by binding, then declared."),
    measures: z.array(ProcessingMeasure).describe("Every security measure the activities cite."),
    gaps: z
      .array(ProcessingGap)
      .describe("Gaps about no single activity: unclaimed classes, uncovered `phi`, purposes with no standing grant."),
    notDerivable: z
      .array(z.string())
      .describe("What the record could not read, and why. Empty when it read everything it needs."),
  })
  .describe(
    "The GDPR Article 30 record this Worker derives: each activity's purpose, data classes, legal basis, recipients, retention and measures, and every gap named.",
  );
export type ControlPlaneProcessingResponse = z.infer<typeof ControlPlaneProcessingResponse>;

/** One trust's subject constraint, as a connection listing shows it: the population that may use the trust. */
export const ConnectionTrustView = z
  .object({
    trustId: z.string().describe("The trust's id."),
    issuer: z.string().describe("The `iss` the trust accepts."),
    claims: z
      .record(z.string().describe("A claim name."), z.string().describe("The value that claim must have."))
      .describe("The subject constraint: every named claim must equal its value. This is who may use the trust."),
    revokedAt: z.iso.datetime().nullable().describe("When the trust was revoked, ISO-8601, or null while it stands."),
  })
  .describe("One OIDC trust's subject constraint, on the face of the listing.");
export type ConnectionTrustView = z.output<typeof ConnectionTrustView>;

/** One connection, as `GET {basePath}/connections` lists it. No key material and no secret. */
export const ConnectionView = z
  .object({
    id: z.string().describe("The connection's id. Name it to revoke the connection."),
    environment: z.string().describe("The environment the connection is bound to."),
    actorKind: ControlPlaneActorKind.nullable().describe(
      "What kind of client the connection is for: `agent`, `dashboard` or `script`. Null for one registered before it was recorded.",
    ),
    purpose: ConnectionPurpose.nullable().describe(
      "What the client is for, in the registering operator's words. Untrusted text: render it escaped. Null for one registered before it was recorded.",
    ),
    authorizedBy: ConnectionPrincipal.nullable().describe(
      "The email of the person who sanctioned the connection. Null for one registered before principals were recorded.",
    ),
    credentialKind: ConnectionCredentialKind,
    scopes: z.array(z.string()).describe("The scopes the connection was granted."),
    trusts: z.array(ConnectionTrustView).describe("Every OIDC trust on the connection, revoked ones included."),
    live: z.boolean().describe("Whether any key or trust on the connection can verify a call now."),
    registeredAt: z.iso.datetime().describe("When the connection was registered, ISO-8601."),
    revokedAt: z.iso
      .datetime()
      .nullable()
      .describe(
        "When the connection was revoked, ISO-8601: the latest revocation once every credential was revoked. Null while anything is live, and for one whose keys merely expired.",
      ),
  })
  .describe("One connection: who authorized it, for what, with which credentials and grant, and whether it is live.");
export type ConnectionView = z.output<typeof ConnectionView>;

/** `GET /control-plane/connections`. */
export const ControlPlaneConnectionsResponse = z
  .object({
    connections: z
      .array(ConnectionView)
      .describe("Every connection with a recorded principal, matching the filter when one was given, oldest first."),
    unattributed: z
      .array(ConnectionView)
      .describe(
        "Every connection registered before principals were recorded, oldest first. Listed apart for a person to read; never matched by a principal.",
      ),
  })
  .describe("Every connection bound to this Worker's environment, attributed ones and unattributed ones apart.");
export type ControlPlaneConnectionsResponse = z.output<typeof ControlPlaneConnectionsResponse>;

/** `POST /control-plane/connections/:connectionId/revoke`. */
export const RevokeConnectionResponse = z
  .object({
    connection: ConnectionView.describe("The connection as it now stands."),
    revokedKeyIds: z
      .array(z.string())
      .describe("The keys this call revoked. Empty when every key was already revoked."),
    revokedTrustIds: z
      .array(z.string())
      .describe("The trusts this call revoked. Empty when every trust was already revoked."),
  })
  .describe("A revoked connection, and the credentials the revocation ended.");
export type RevokeConnectionResponse = z.output<typeof RevokeConnectionResponse>;
