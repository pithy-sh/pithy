// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ConsentPurpose } from "@pithy-sh/core/src/consent/purpose";
import type { FieldKeys } from "@pithy-sh/core/src/crypto/fieldKeys";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Context } from "hono";
import { consentDatabase } from "../data/tables";
import { evidenceBucket } from "../evidence/evidence";
import { type ConsentStore, consentStore } from "../record/store";

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
 * | GET    | /consent/control-plane/expiring                        | control-plane: consent:read       | query `ExpiringGrantsQuery` |
 * | GET    | /consent/control-plane/subjects/:kind/:subjectId       | control-plane: consent:read       | param `SubjectParams` |
 * | GET    | /consent/control-plane/documents/:hash                 | control-plane: consent:read       | param `HashParams` |
 * | GET    | /consent/control-plane/evidence/:hash                  | control-plane: consent:read       | param `HashParams` |
 *
 * **Withdrawing is the same request as granting, on the same screen**, and a click withdraws unless the purpose
 * requires a written withdrawal. The two writes wear `requireSameOrigin()`: the visitor cookie and a web session are
 * both ambient, so a cross-site form must not be able to grant or withdraw for somebody. A bearer request is exempt,
 * as the gate decides, and so is a phone's: a request that names its device in the header and carries no cookie has
 * nothing ambient to forge, and a cross-site form cannot set a header. **And they are rate-limited per client IP**,
 * ahead of everything else, because a grant needs no account and the record it writes can never be deleted: `Origin`
 * is a header any script sets.
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
export function dbOf(c: Context<PithyHonoEnv>): D1Database {
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
