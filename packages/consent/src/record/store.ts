// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { R2Bucket } from "@cloudflare/workers-types";
import { type ConsentPurpose, meetsMethod } from "@pithy-sh/core/src/consent/purpose";
import type { ConsentSubject } from "@pithy-sh/core/src/consent/reader";
import type { FieldKeys } from "@pithy-sh/core/src/crypto/fieldKeys";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { type Opened, sealed } from "@pithy-sh/core/src/privacy/sealed";
import { sql } from "kysely";
import type { z } from "zod";
import { ConsentDocument, ConsentMerge, ConsentRecord } from "../data/record";
import type { ConsentDatabase } from "../data/tables";
import {
  ConsentEvidenceMissingError,
  ConsentExpiryPassedError,
  ConsentMethodBelowMinimumError,
  ConsentStaleNoticeError,
  ConsentUnknownPurposeError,
  ConsentWithdrawalBelowGrantError,
} from "../error/errors";
import { decodeBase64, documentHash, keepEvidence } from "../evidence/evidence";
import type { GrantBody, WithdrawBody } from "../http/schemas";
import { type AnswerRow, type ConsentStanding, standing, standingGrant } from "./answer";

/**
 * The consent record, read and written. Every write is one append; nothing here updates or deletes a row,
 * and the table's triggers refuse it if anything tried.
 */

/** A record row with its two names opened. */
export type OpenedRecord = Opened<typeof ConsentRecord>;

/** What the store is built over, per request. */
export interface ConsentStoreDeps {
  readonly db: ConsentDatabase;
  /** The field key the two names are sealed under: `env.PITHY_FIELD_KEYS`. */
  readonly keys: FieldKeys | undefined;
  /** The evidence bucket, or `undefined` where none is bound — a drawn or provider grant then refuses. */
  readonly bucket: R2Bucket | undefined;
  /** The composed catalog: every purpose by id. */
  readonly purposes: ReadonlyMap<string, ConsentPurpose>;
  /** How long an unmerged visitor's consent counts. */
  readonly visitorWindowMs: number;
  readonly now: () => Date;
  readonly newId: () => string;
}

/** A row as the answer reads it, from a stored row and whether it came through a merge. */
function answerRow(row: ConsentRecord, merged: boolean): AnswerRow {
  return {
    subjectKind: row.subjectKind,
    action: row.action,
    noticeVersion: row.noticeVersion,
    method: row.method,
    expiresAt: row.expiresAt,
    recordedAt: row.recordedAt,
    merged,
  };
}

/** The store over one request's database, bucket and catalog. */
export function consentStore(deps: ConsentStoreDeps) {
  const records = sealed(ConsentRecord, { keys: deps.keys });

  const purposeOf = (id: string): ConsentPurpose => {
    const purpose = deps.purposes.get(id);
    if (!purpose) throw new ConsentUnknownPurposeError({ detail: `no purpose "${id}" in the composed catalog` });
    return purpose;
  };

  /** The visitors merged into an account. */
  const mergedVisitors = async (userId: string): Promise<string[]> => {
    const rows = await deps.db
      .selectFrom("pithyConsentMerges")
      .select("visitorId")
      .where("userId", "=", userId)
      .execute();
    return rows.map((row) => row.visitorId);
  };

  /** Whether a visitor has been merged into an account. */
  const mergeOf = async (visitorId: string) => {
    const row = await deps.db
      .selectFrom("pithyConsentMerges")
      .selectAll()
      .where("visitorId", "=", visitorId)
      .executeTakeFirst();
    return row ? ConsentMerge.parse(row) : null;
  };

  /**
   * Every row about the subject, in the order written — and for an account, every row of the visitors merged into
   * it, flagged as merged. Optionally narrowed to one purpose.
   */
  const rowsOf = async (
    subject: ConsentSubject,
    purpose?: string,
  ): Promise<{ raw: z.input<typeof ConsentRecord>; row: ConsentRecord; merged: boolean }[]> => {
    const visitors = subject.kind === "account" ? await mergedVisitors(subject.id) : [];
    const visitorMerged = subject.kind === "visitor" ? (await mergeOf(subject.id)) !== null : false;
    let query = deps.db
      .selectFrom("pithyConsentRecords")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb.and([eb("subjectKind", "=", subject.kind), eb("subjectId", "=", subject.id)]),
          ...(visitors.length > 0
            ? [eb.and([eb("subjectKind", "=", "visitor"), eb("subjectId", "in", visitors)])]
            : []),
        ]),
      );
    if (purpose !== undefined) query = query.where("purpose", "=", purpose);
    const rows = await query.orderBy("recordedAt", "asc").orderBy(sql`rowid`, "asc").execute();
    return rows.map((raw) => {
      const row = ConsentRecord.parse(raw);
      const merged = subject.kind === "account" ? row.subjectKind === "visitor" : visitorMerged;
      return { raw, row, merged };
    });
  };

  /** The subject's standing on one purpose now. */
  const standingOf = async (subject: ConsentSubject, purposeId: string): Promise<ConsentStanding> => {
    const purpose = deps.purposes.get(purposeId);
    if (!purpose) return "unknown_purpose";
    const rows = await rowsOf(subject, purposeId);
    return standing(
      purpose,
      rows.map(({ row, merged }) => answerRow(row, merged)),
      deps.now(),
      deps.visitorWindowMs,
    );
  };

  /** Keep a document once per hash, and answer its hash. */
  const keepDocument = async (text: string): Promise<string> => {
    const hash = await documentHash(text);
    const document = ConsentDocument.encode({ hash, text, keptAt: deps.now() });
    await deps.db
      .insertInto("pithyConsentDocuments")
      .values(document)
      .onConflict((c) => c.doNothing())
      .execute();
    return hash;
  };

  /**
   * The document's hash, and its text kept only behind a signature. A click — a grant or a withdrawal — records which
   * notice it answered by hash alone: it signs nothing, and the person's own routes take one without an account, so
   * keeping its text would let anybody fill an append-only table that can never be cleaned.
   */
  const documentOf = async (choice: GrantBody | WithdrawBody): Promise<string | null> => {
    if (choice.document === undefined) return null;
    return choice.method === "click" ? documentHash(choice.document) : keepDocument(choice.document);
  };

  /** The evidence a method names, checked and kept; the fields of the row it fills. */
  const evidenceFor = async (choice: GrantBody | WithdrawBody, signed: boolean) => {
    const documentHashValue = await documentOf(choice);
    if (signed && documentHashValue === null) {
      throw new ConsentEvidenceMissingError({
        message: "A signed consent needs the document it was given against.",
        detail: `method ${choice.method} with no document`,
      });
    }
    const empty = {
      typedName: null,
      drawnImageHash: null,
      drawnImageType: null,
      provider: null,
      providerEnvelopeId: null,
      providerCertificateHash: null,
    };
    switch (choice.method) {
      case "click":
        return { documentHash: documentHashValue, ...empty };
      case "typed": {
        if (choice.typedName === undefined) {
          throw new ConsentEvidenceMissingError({ message: "A typed signature needs the typed name." });
        }
        return { documentHash: documentHashValue, ...empty, typedName: choice.typedName };
      }
      case "drawn": {
        const bytes = choice.drawn ? decodeBase64(choice.drawn.image) : null;
        if (!choice.drawn || bytes === null || bytes.length === 0) {
          throw new ConsentEvidenceMissingError({ message: "A drawn signature needs the drawn image, in base64." });
        }
        const hash = await keepEvidence(deps.bucket, "drawn", bytes, choice.drawn.type);
        return { documentHash: documentHashValue, ...empty, drawnImageHash: hash, drawnImageType: choice.drawn.type };
      }
      case "provider": {
        if (!choice.provider) {
          throw new ConsentEvidenceMissingError({ message: "A provider's signature needs the provider and envelope." });
        }
        let certificate: string | null = null;
        if (choice.provider.certificate !== undefined) {
          const bytes = decodeBase64(choice.provider.certificate);
          if (bytes === null || bytes.length === 0) {
            throw new ConsentEvidenceMissingError({ message: "The provider's certificate is not base64." });
          }
          certificate = await keepEvidence(deps.bucket, "certificate", bytes, "application/pdf");
        }
        return {
          documentHash: documentHashValue,
          ...empty,
          provider: choice.provider.name,
          providerEnvelopeId: choice.provider.envelopeId,
          providerCertificateHash: certificate,
        };
      }
    }
  };

  /** How identity was verified: what the flow declared, or the default for the subject's kind. */
  const identityOf = (subject: ConsentSubject, declared: GrantBody["identity"]) => {
    if (subject.kind === "visitor" && declared === "session") {
      throw new ValidationError({
        message: "A visitor has no session to verify identity by.",
        action: "Send `none`, or a check your flow actually made.",
      });
    }
    return declared ?? (subject.kind === "account" ? "session" : "none");
  };

  /** Append one row, sealed. */
  const append = async (value: OpenedRecord): Promise<OpenedRecord> => {
    await deps.db
      .insertInto("pithyConsentRecords")
      .values(await records.seal(value))
      .execute();
    return value;
  };

  return {
    purposeOf,
    rowsOf,
    standingOf,
    mergeOf,
    mergedVisitors,

    /** Whether the subject holds consent to the purpose now. */
    async hasConsent(subject: ConsentSubject, purposeId: string): Promise<boolean> {
      return (await standingOf(subject, purposeId)) === "granted";
    },

    /** Record a grant. Refused below the purpose's minimum, against a stale notice, or missing its evidence. */
    async grant(subject: ConsentSubject, body: GrantBody): Promise<OpenedRecord> {
      const purpose = purposeOf(body.purpose);
      if (body.noticeVersion !== purpose.noticeVersion) {
        throw new ConsentStaleNoticeError({
          params: { current: purpose.noticeVersion },
          detail: `grant for ${purpose.id} under notice ${body.noticeVersion}, current ${purpose.noticeVersion}`,
        });
      }
      if (!meetsMethod(body.method, purpose.minimumMethod)) {
        throw new ConsentMethodBelowMinimumError({
          params: { minimum: purpose.minimumMethod },
          detail: `grant for ${purpose.id} by ${body.method}, minimum ${purpose.minimumMethod}`,
        });
      }
      const now = deps.now();
      const expiresAt = body.expiresAt === undefined ? null : new Date(body.expiresAt);
      if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) throw new ConsentExpiryPassedError();
      const evidence = await evidenceFor(body, body.method !== "click");
      return append({
        id: deps.newId(),
        subjectKind: subject.kind,
        subjectId: subject.id,
        purpose: purpose.id,
        action: "grant",
        noticeVersion: purpose.noticeVersion,
        method: body.method,
        surface: body.surface,
        identity: identityOf(subject, body.identity),
        ...evidence,
        expiresAt,
        representativeName: body.representative?.name ?? null,
        representativeRelationship: body.representative?.relationship ?? null,
        recordedAt: now,
      } as OpenedRecord);
    },

    /**
     * Record a withdrawal. A purpose requiring a written withdrawal refuses one below the grant it withdraws; any
     * other is withdrawn by a click. A withdrawal with nothing standing behind it is still recorded: it is the
     * person's choice, and the next ask reads it.
     */
    async withdraw(subject: ConsentSubject, body: WithdrawBody): Promise<OpenedRecord> {
      const purpose = purposeOf(body.purpose);
      if (purpose.writtenWithdrawal) {
        const grant = standingGrant((await rowsOf(subject, purpose.id)).map(({ row }) => row));
        if (grant && !meetsMethod(body.method, grant.method)) {
          throw new ConsentWithdrawalBelowGrantError({
            params: { minimum: grant.method },
            detail: `withdrawal of ${purpose.id} by ${body.method}, grant by ${grant.method}`,
          });
        }
      }
      const evidence = await evidenceFor(body, false);
      return append({
        id: deps.newId(),
        subjectKind: subject.kind,
        subjectId: subject.id,
        purpose: purpose.id,
        action: "withdraw",
        noticeVersion: purpose.noticeVersion,
        method: body.method,
        surface: body.surface,
        identity: identityOf(subject, body.identity),
        ...evidence,
        expiresAt: null,
        representativeName: null,
        representativeRelationship: null,
        recordedAt: deps.now(),
      } as OpenedRecord);
    },

    /**
     * Merge a visitor into the account they signed in as. Once per visitor: a second merge of the same device id
     * answers the first, so a retried sign-in records nothing new. Answers the merge and whether it was new.
     */
    async merge(visitorId: string, userId: string): Promise<{ merge: ConsentMerge; created: boolean }> {
      const existing = await mergeOf(visitorId);
      if (existing) return { merge: existing, created: false };
      const merge: ConsentMerge = { id: deps.newId(), visitorId, userId, mergedAt: deps.now() };
      const inserted = await deps.db
        .insertInto("pithyConsentMerges")
        .values(ConsentMerge.encode(merge))
        .onConflict((c) => c.column("visitorId").doNothing())
        .executeTakeFirst();
      if (Number(inserted.numInsertedOrUpdatedRows ?? 0n) === 0) {
        const raced = await mergeOf(visitorId);
        if (raced) return { merge: raced, created: false };
      }
      return { merge, created: true };
    },

    /** Every row about the subject, opened, oldest first. */
    async record(subject: ConsentSubject): Promise<OpenedRecord[]> {
      const rows = await rowsOf(subject);
      return Promise.all(rows.map(({ raw }) => records.open(raw)));
    },

    /** A kept document by hash, or `null`. */
    async document(hash: string): Promise<ConsentDocument | null> {
      const row = await deps.db
        .selectFrom("pithyConsentDocuments")
        .selectAll()
        .where("hash", "=", hash)
        .executeTakeFirst();
      return row ? ConsentDocument.parse(row) : null;
    },
  };
}

/** The store, as {@link consentStore} builds it. */
export type ConsentStore = ReturnType<typeof consentStore>;
