// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ConsentPurpose } from "@pithy-sh/core/src/consent/purpose";
import { purposeDomain } from "@pithy-sh/core/src/consent/purpose";
import { type ConsentSubject, composedAddress } from "@pithy-sh/core/src/consent/reader";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { FieldKeys } from "@pithy-sh/core/src/crypto/fieldKeys";
import { InternalError, RateLimitError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { requireSameOrigin } from "@pithy-sh/core/src/http/sameOrigin";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { ConsentAuditActions } from "../audit/actions";
import { consentDatabase } from "../data/tables";
import { ConsentDocumentNotFoundError } from "../error/errors";
import { evidenceBucket, readEvidence } from "../evidence/evidence";
import { consentCounts } from "../record/counts";
import { type ConsentStore, consentStore, type OpenedRecord } from "../record/store";
import {
  ConsentAdminPurposesResponse,
  ConsentAdminSubjectResponse,
  ConsentChoiceResponse,
  ConsentPurposesResponse,
  MyConsentResponse,
} from "./responses";
import { GrantBody, HashParams, SubjectParams, WithdrawBody } from "./schemas";
import { CONSENT_READ_SCOPE } from "./scopes";
import { mergeView, purposeView, recordView, standingView } from "./views";
import { readVisitor, writeVisitor } from "./visitor";

/**
 * The consent capability's HTTP surface. The person's own routes resolve who is asking — the signed-in
 * account, or the visitor whose device-id cookie came with the request — and the management routes read the record
 * behind the control plane:
 *
 * | Method | Path                                                   | Strategy                          | Validates |
 * |--------|--------------------------------------------------------|-----------------------------------|-----------|
 * | GET    | /consent/purposes                                      | public                            | — |
 * | GET    | /consent/me                                            | bearer \| session \| visitor      | — |
 * | GET    | /consent/me/documents/:hash                            | bearer \| session \| visitor      | param `HashParams` |
 * | POST   | /consent/grants                                        | bearer \| session \| visitor, same origin | json `GrantBody` |
 * | POST   | /consent/withdrawals                                   | bearer \| session \| visitor, same origin | json `WithdrawBody` |
 * | GET    | /consent/control-plane/purposes                        | control-plane: consent:read       | — |
 * | GET    | /consent/control-plane/subjects/:kind/:subjectId       | control-plane: consent:read       | param `SubjectParams` |
 * | GET    | /consent/control-plane/documents/:hash                 | control-plane: consent:read       | param `HashParams` |
 * | GET    | /consent/control-plane/evidence/:hash                  | control-plane: consent:read       | param `HashParams` |
 *
 * **Withdrawing is the same request as granting, on the same screen**, and a click withdraws unless the purpose
 * requires a written withdrawal. The two writes wear `requireSameOrigin()`: the visitor cookie and a web session are
 * both ambient, so a cross-site form must not be able to grant or withdraw for somebody. A bearer request is exempt,
 * as the gate decides. **And they are rate-limited per client IP**, ahead of everything else, because a grant needs no
 * account and the record it writes can never be deleted: `Origin` is a header any script sets.
 */
export interface ConsentRoutesOptions {
  /** Where the routes mount. */
  readonly basePath: string;
  /** The composed catalog, read per request: `compose` fills it after the routes are defined. */
  readonly catalog: () => ReadonlyMap<string, ConsentPurpose>;
  /** Every composed capability, read per request, for the withdrawal listeners and the account's address. */
  readonly composition: () => readonly Capability[];
  /** How long an unmerged visitor's consent counts, in milliseconds. */
  readonly visitorWindowMs: number;
  /** The Workers Rate Limiting binding the two writes are held to, per client IP. */
  readonly rateLimiterBinding: string;
}

/** The app `DB` off the env, or a wiring fault naming it. */
function dbOf(c: Context<PithyHonoEnv>): D1Database {
  const binding = (c.env as Record<string, unknown> | undefined)?.DB;
  if (typeof binding !== "object" || binding === null) {
    throw new InternalError({
      message: "The consent record is not available.",
      action: "Bind the D1 database named DB to this Worker.",
      detail: "consent route found no DB binding on the env",
    });
  }
  return binding as D1Database;
}

/** The store for this request. */
export function storeFor(c: Context<PithyHonoEnv>, options: ConsentRoutesOptions): ConsentStore {
  const env = (c.env ?? {}) as Record<string, unknown>;
  return consentStore({
    db: consentDatabase(dbOf(c)),
    keys: env.PITHY_FIELD_KEYS as FieldKeys | undefined,
    bucket: evidenceBucket(env),
    purposes: options.catalog(),
    visitorWindowMs: options.visitorWindowMs,
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  });
}

/** Who is asking: the signed-in account, the visitor whose cookie came with the request, or nobody yet. */
export function subjectOf(c: Context<PithyHonoEnv>): ConsentSubject | null {
  if (c.var.auth) return { kind: "account", id: c.var.auth.userId };
  const visitor = readVisitor(c);
  return visitor === null ? null : { kind: "visitor", id: visitor };
}

/** Every purpose, and where the subject stands on each. */
async function standings(store: ConsentStore, catalog: ReadonlyMap<string, ConsentPurpose>, subject: ConsentSubject) {
  return Promise.all(
    [...catalog.values()].map(async (purpose) => standingView(purpose, await store.standingOf(subject, purpose.id))),
  );
}

/** One appended row on the trail, as `@pithy-sh/audit` chains it. Names never ride on it. */
async function audit(
  c: Context<PithyHonoEnv>,
  action: string,
  subject: ConsentSubject,
  metadata: Record<string, string | number | null>,
): Promise<void> {
  await c.var.emit({
    action,
    outcome: "success",
    severity: "info",
    actorType: subject.kind === "account" ? "user" : "anonymous",
    actorId: subject.id,
    resourceType: "consent",
    resourceId: `${subject.kind}:${subject.id}`,
    requestId: c.req.header("cf-ray"),
    ip: c.req.header("cf-connecting-ip"),
    userAgent: c.req.header("user-agent"),
    metadata,
  });
}

/** The trail's metadata for one row: what it recorded, never who signed or what they typed. */
function rowMetadata(record: OpenedRecord): Record<string, string | number | null> {
  return {
    recordId: record.id,
    purpose: record.purpose,
    noticeVersion: record.noticeVersion,
    method: record.method,
    surface: record.surface,
    documentHash: record.documentHash,
  };
}

/**
 * Tell the capability that owns a purpose of a choice, after the row is written: a withdrawal always, a grant only
 * once it stands. A listener that throws is logged and its failure stands alone: the choice is already the record.
 */
async function notifyOwner(
  c: Context<PithyHonoEnv>,
  options: ConsentRoutesOptions,
  subject: ConsentSubject,
  purpose: string,
  choice: "granted" | "withdrawn",
): Promise<void> {
  const env = (c.env ?? {}) as Record<string, unknown>;
  const capabilities = options.composition();
  const owner = capabilities.find((capability) => capability.name === purposeDomain(purpose));
  const listener = choice === "granted" ? owner?.consentGranted : owner?.consentWithdrawn;
  if (!owner || !listener) return;
  try {
    await listener({ subject, purpose, env, address: () => composedAddress(capabilities, env, subject) });
  } catch (cause) {
    c.var.log.child("consent").warn(`A ${choice === "granted" ? "grant" : "withdrawal"} listener failed; it stands.`, {
      capability: owner.name,
      purpose,
      error: cause instanceof Error ? cause.message : "unknown",
    });
  }
}

/**
 * Hold a write to a per-IP limit, under a `consent:` key of its own so it never spends the budget of the limiter's
 * other users. Skipped only where the binding is absent — a test harness; a deployed Worker is refused at boot
 * without it, because it is a required binding.
 */
function rateLimited(binding: string): MiddlewareHandler<PithyHonoEnv> {
  return async (c, next) => {
    const limiter = (c.env as Record<string, unknown> | undefined)?.[binding] as RateLimit | undefined;
    if (limiter && typeof limiter.limit === "function") {
      const ip = c.req.header("cf-connecting-ip") ?? "anonymous";
      const { success } = await limiter.limit({ key: `consent:${ip}` });
      if (!success) {
        throw new RateLimitError({ message: "Too many requests.", action: "Slow down and retry in a moment." });
      }
    }
    await next();
  };
}

export function registerConsentRoutes(options: ConsentRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath;
  const self = ["bearer", "session", "public"] as const;

  return (app) => {
    app.get(
      `${base}/purposes`,
      describeRoute({
        summary: "List every purpose this Worker asks consent for, with its current notice version.",
        verification: "public",
        responses: { 200: ConsentPurposesResponse },
      }),
      (c) =>
        c.json({ purposes: [...options.catalog().values()].map(purposeView) } satisfies ConsentPurposesResponse, 200),
    );

    app.get(
      `${base}/me`,
      describeRoute({
        summary: "Read your own consents: where you stand on each purpose, and every choice behind it.",
        verification: [...self],
        responses: { 200: MyConsentResponse },
      }),
      async (c) => {
        const subject = subjectOf(c);
        const catalog = options.catalog();
        if (subject === null) {
          const purposes = [...catalog.values()].map((purpose) => standingView(purpose, "never_granted"));
          return c.json({ subject: null, purposes, records: [] } satisfies MyConsentResponse, 200);
        }
        const store = storeFor(c, options);
        return c.json(
          {
            subject,
            purposes: await standings(store, catalog, subject),
            records: (await store.record(subject)).map(recordView),
          } satisfies MyConsentResponse,
          200,
        );
      },
    );

    app.get(
      `${base}/me/documents/:hash`,
      describeRoute({
        summary: "Read a document you agreed to, byte for byte, by its content hash.",
        verification: [...self],
        responses: { 200: { description: "The document's exact text.", contentType: "text/plain; charset=utf-8" } },
      }),
      validate("param", HashParams),
      async (c) => {
        const { hash } = c.req.valid("param");
        const subject = subjectOf(c);
        const store = storeFor(c, options);
        // Only a document this subject's own record names: a hash is not a credential, and the text may be theirs.
        const own = subject !== null && (await store.rowsOf(subject)).some(({ row }) => row.documentHash === hash);
        const document = own ? await store.document(hash) : null;
        if (document === null) throw new ConsentDocumentNotFoundError();
        return c.body(document.text, 200, { "content-type": "text/plain; charset=utf-8", etag: `"${hash}"` });
      },
    );

    app.post(
      `${base}/grants`,
      describeRoute({
        summary: "Give consent to one purpose, with the evidence its method needs.",
        verification: [...self],
        responses: { 201: ConsentChoiceResponse },
      }),
      rateLimited(options.rateLimiterBinding),
      requireSameOrigin(),
      validate("json", GrantBody),
      async (c) => {
        const subject = subjectOf(c) ?? { kind: "visitor" as const, id: crypto.randomUUID() };
        const store = storeFor(c, options);
        const record = await store.grant(subject, c.req.valid("json"));
        // The device id is held only now that a choice has been made, and only for a visitor.
        if (subject.kind === "visitor") writeVisitor(c, subject.id, options.visitorWindowMs);
        await audit(c, ConsentAuditActions.granted, subject, rowMetadata(record));
        const standing = await store.standingOf(subject, record.purpose);
        if (standing === "granted") await notifyOwner(c, options, subject, record.purpose, "granted");
        return c.json(
          { record: recordView(record), standing, granted: standing === "granted" } satisfies ConsentChoiceResponse,
          201,
        );
      },
    );

    app.post(
      `${base}/withdrawals`,
      describeRoute({
        summary: "Withdraw consent from one purpose. As easy as giving it, unless the purpose requires it in writing.",
        verification: [...self],
        responses: { 201: ConsentChoiceResponse },
      }),
      rateLimited(options.rateLimiterBinding),
      requireSameOrigin(),
      validate("json", WithdrawBody),
      async (c) => {
        const subject = subjectOf(c) ?? { kind: "visitor" as const, id: crypto.randomUUID() };
        const store = storeFor(c, options);
        const record = await store.withdraw(subject, c.req.valid("json"));
        if (subject.kind === "visitor") writeVisitor(c, subject.id, options.visitorWindowMs);
        await audit(c, ConsentAuditActions.withdrawn, subject, rowMetadata(record));
        await notifyOwner(c, options, subject, record.purpose, "withdrawn");
        const standing = await store.standingOf(subject, record.purpose);
        return c.json(
          { record: recordView(record), standing, granted: standing === "granted" } satisfies ConsentChoiceResponse,
          201,
        );
      },
    );

    // The management surface: control plane only, under `control-plane/`, which no person's route uses.

    app.get(
      `${base}/control-plane/purposes`,
      describeRoute({
        summary: "List every consent purpose, with counts of current grants and withdrawals per notice version.",
        verification: "control-plane",
        scopes: [CONSENT_READ_SCOPE],
        responses: { 200: ConsentAdminPurposesResponse },
      }),
      requireControlPlane(CONSENT_READ_SCOPE),
      async (c) => {
        const counts = await consentCounts(consentDatabase(dbOf(c)));
        const purposes = [...options.catalog().values()].map((purpose) => ({
          purpose: purposeView(purpose),
          versions: counts
            .filter((count) => count.purpose === purpose.id)
            .map(({ noticeVersion, grants, withdrawals }) => ({ noticeVersion, grants, withdrawals })),
        }));
        return c.json({ purposes } satisfies ConsentAdminPurposesResponse, 200);
      },
    );

    app.get(
      `${base}/control-plane/subjects/:kind/:subjectId`,
      describeRoute({
        summary: "Read one subject's consent record: where they stand, every row, and the merges behind it.",
        verification: "control-plane",
        scopes: [CONSENT_READ_SCOPE],
        responses: { 200: ConsentAdminSubjectResponse },
      }),
      requireControlPlane(CONSENT_READ_SCOPE),
      validate("param", SubjectParams),
      async (c) => {
        const params = c.req.valid("param");
        const subject: ConsentSubject = { kind: params.kind, id: params.subjectId };
        const store = storeFor(c, options);
        const merges =
          subject.kind === "account"
            ? await Promise.all((await store.mergedVisitors(subject.id)).map((visitor) => store.mergeOf(visitor)))
            : [await store.mergeOf(subject.id)];
        return c.json(
          {
            subject,
            purposes: await standings(store, options.catalog(), subject),
            records: (await store.record(subject)).map(recordView),
            merges: merges.filter((merge) => merge !== null).map(mergeView),
          } satisfies ConsentAdminSubjectResponse,
          200,
        );
      },
    );

    app.get(
      `${base}/control-plane/documents/:hash`,
      describeRoute({
        summary: "Read a signed document, byte for byte, by its content hash.",
        verification: "control-plane",
        scopes: [CONSENT_READ_SCOPE],
        responses: { 200: { description: "The document's exact text.", contentType: "text/plain; charset=utf-8" } },
      }),
      requireControlPlane(CONSENT_READ_SCOPE),
      validate("param", HashParams),
      async (c) => {
        const { hash } = c.req.valid("param");
        const document = await storeFor(c, options).document(hash);
        if (document === null) throw new ConsentDocumentNotFoundError();
        return c.body(document.text, 200, { "content-type": "text/plain; charset=utf-8", etag: `"${hash}"` });
      },
    );

    app.get(
      `${base}/control-plane/evidence/:hash`,
      describeRoute({
        summary: "Read a drawn signature or a provider's certificate, by its content hash.",
        verification: "control-plane",
        scopes: [CONSENT_READ_SCOPE],
        responses: { 200: { description: "The evidence object's bytes.", contentType: "application/octet-stream" } },
      }),
      requireControlPlane(CONSENT_READ_SCOPE),
      validate("param", HashParams),
      async (c) => {
        const { hash } = c.req.valid("param");
        const evidence = await readEvidence(evidenceBucket((c.env ?? {}) as Record<string, unknown>), hash);
        if (evidence === null) {
          throw new ConsentDocumentNotFoundError({ message: "That signature or certificate does not exist." });
        }
        // Bytes somebody else supplied, so never rendered on this origin: an SVG could carry script.
        return c.body(evidence.bytes, 200, {
          "content-type": evidence.contentType,
          "content-disposition": `attachment; filename="${hash}"`,
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
          etag: `"${hash}"`,
        });
      },
    );
  };
}
