// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { Context } from "hono";
import { PaymentsSubject, type PaymentsSubjectType } from "../data/subject";
import { PaymentsSubjectUnresolvedError } from "../error/errors";

/**
 * Which subject is this caller acting for — the one question this capability cannot answer itself.
 *
 * Under `billingSubject: "user"` there is nothing to ask: the caller is the holder, and the answer is the
 * authenticated user id the auth capability already put on the request. Under `"organization"` the answer
 * is a fact about the adopter's own membership model — who this person works for, which of their two
 * companies they are currently looking at, whether the seat they were invited to is still theirs. Payments
 * has no members table, no roles, and no business acquiring either. A payments capability that could
 * enumerate a company's staff is a second product grown inside a billing one, and it would be wrong about
 * every adopter whose org model is not the one it guessed.
 *
 * So the answer comes from **outside**: {@link PaymentsSubjectResolver} is a function the adopter supplies,
 * and it receives the Hono `Context` — the same request `installEntitlementResolver` already reads the
 * caller from, at gate time rather than install time, which is what keeps middleware order the adopter's.
 * For Better Auth's `organization()` plugin that function is one line reading `activeOrganizationId` off
 * the session; for anything else it is whatever that adopter's session already knows.
 *
 * **Unanswered is unentitled, in both directions.** A read holds nothing — the gate denies, exactly as it
 * does for a caller who never bought anything, and for the same reason: a gate that resolved *something*
 * when it could not tell who was asking would be granting one holder's plan to whoever asked next. A write
 * refuses outright with {@link PaymentsSubjectUnresolvedError}, because writing needs a row key and a
 * guessed key attributes real money to the wrong holder. **Nothing here ever falls back to
 * `c.var.auth.userId` under organization billing** — that fallback is the half-migrated state this whole
 * design exists to prevent, where a company's subscription silently becomes one employee's.
 *
 * There is deliberately **no default for `"organization"`**. An adopter who supplies no resolver resolves
 * nothing and holds nothing, which fails loudly on the first paid route rather than quietly keying the
 * company's plan to whoever logged in first.
 *
 * One implementation, one entry point: {@link resolvePaymentsSubject} answers the question for the gate,
 * the routes, and anything that comes next. A second place asking it is a second policy, and the two
 * disagree the day one of them is edited.
 */

/**
 * The seam: given the request, who is this caller acting for.
 *
 * Async because an adopter's answer is usually a lookup — a session row, a KV read, an organization the
 * request names and their own model must confirm. Returning `undefined` is a legitimate answer, not an
 * error: a signed-in person with no organization selected is exactly that, and the gate treats it as
 * unentitled rather than as a fault.
 */
export type PaymentsSubjectResolver = (c: Context<PithyHonoEnv>) => Promise<PaymentsSubject | undefined>;

/**
 * What the question needs to be answered: the project's billing mode, and the adopter's resolver if they
 * supplied one.
 *
 * A structural type rather than a parameter list, so a call site cannot transpose them and so
 * `PaymentsConfig` — which carries `billingSubject` — satisfies it as it stands. The mode is read from
 * config on every call rather than captured once, because it is the mode that decides both which default
 * applies and which answers are legal.
 */
export interface PaymentsSubjectSeam {
  /** The project's billing mode, from `PaymentsConfig.billingSubject`. Decided once, never per call. */
  readonly billingSubject: PaymentsSubjectType;
  /**
   * The adopter's answer. Required in practice under `"organization"` — without it nothing resolves —
   * and optional under `"user"`, where {@link authenticatedUserSubject} is the whole answer.
   */
  readonly resolveSubject?: PaymentsSubjectResolver;
}

/**
 * The default under `billingSubject: "user"`: the authenticated caller, as a user subject.
 *
 * It reads the core `AuthContext` seam and nothing else, so it works with whatever strategy verified the
 * request — bearer or cookie session — and holds nothing when none did. `c.var.auth` is `null` on an
 * unauthenticated request and `undefined` when no auth capability is composed at all; both mean the same
 * thing here, and both resolve to nobody.
 */
export const authenticatedUserSubject: PaymentsSubjectResolver = async (c) => {
  const auth = c.var.auth;
  if (!auth) return undefined;
  return { subjectType: "user", subjectId: auth.userId };
};

/**
 * Who this caller is acting for, or `undefined`. **The one implementation of that question.**
 *
 * The adopter's resolver wins whenever they supplied one, in either mode: an answer of `undefined` from it
 * is their answer, never a prompt to fall back to the caller. Only when they supplied none does the mode
 * decide — the default under `"user"`, and nobody at all under `"organization"`.
 *
 * **The answer is validated before it is believed**, because it crosses a boundary: it is a value from the
 * adopter's code, and it becomes a row key and — through `encodeSubjectReference` — a string handed to a
 * payment provider. An id longer than a store's own field would come back truncated and decode to a
 * *different* holder, so the schema's cap is enforced here rather than discovered at a refund.
 *
 * **An answer of the wrong kind for the configured mode is refused**, not half-trusted. One mode per
 * project is the decision this capability is built on; a user subject resolved under organization billing
 * would read rows the projection never writes and write rows no gate ever reads, and both halves of that
 * are invisible until somebody is refused what they paid for. Refusing leaves them unentitled, which is
 * the direction every gate in the kit already fails, and logs the mismatch where an operator finds it.
 */
export async function resolvePaymentsSubject(
  c: Context<PithyHonoEnv>,
  seam: PaymentsSubjectSeam,
): Promise<PaymentsSubject | undefined> {
  const answered = await (seam.resolveSubject ?? modeDefault(seam.billingSubject))(c);
  if (answered === undefined) return undefined;

  const parsed = PaymentsSubject.safeParse(answered);
  if (!parsed.success) {
    // Not a throw: an adopter's malformed answer must deny like any other unanswered request, or a bug in
    // their resolver becomes a 500 on a route that should simply have held nothing.
    c.var.log?.warn("payments: the subject resolver answered something the subject schema refuses.", {
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
    return undefined;
  }

  if (parsed.data.subjectType !== seam.billingSubject) {
    c.var.log?.warn("payments: the subject resolver answered the wrong kind of subject for this project.", {
      billingSubject: seam.billingSubject,
      answered: parsed.data.subjectType,
    });
    return undefined;
  }

  return parsed.data;
}

/**
 * The same question on a write path, where `undefined` is not an answer a caller can be handed a row for.
 *
 * A 403 rather than a 401: the caller may be perfectly well authenticated and simply not acting for any
 * subject this project bills — no organization selected, or none they still belong to. The `action` is
 * written for whichever mode is in force, because an operator reading this under user billing is looking
 * at a missing auth strategy and one reading it under organization billing is looking at an unwired
 * resolver, and sending either to the other's file wastes the afternoon.
 */
export async function requirePaymentsSubject(
  c: Context<PithyHonoEnv>,
  seam: PaymentsSubjectSeam,
): Promise<PaymentsSubject> {
  const subject = await resolvePaymentsSubject(c, seam);
  if (subject) return subject;

  if (seam.billingSubject === "user") {
    throw new PaymentsSubjectUnresolvedError({
      message: "Sign in to continue.",
      action: "requireAuth() must run before a payments write, and an auth capability must be composed.",
      detail: "No authenticated caller, so this write has no holder to key its row to.",
    });
  }
  throw new PaymentsSubjectUnresolvedError({
    detail: seam.resolveSubject
      ? "The subject resolver answered nothing for this request, so this write has no holder to key its row to."
      : "This project bills organizations and no subject resolver is wired, so nothing can ever be resolved.",
  });
}

/**
 * The resolver a mode falls back to when the adopter supplied none.
 *
 * `"organization"` falls back to nobody, and that is the design rather than an omission: the capability
 * has no way to know what an organization is, so the only honest answer it can produce on its own is
 * none. See this file's header.
 */
function modeDefault(billingSubject: PaymentsSubjectType): PaymentsSubjectResolver {
  return billingSubject === "user" ? authenticatedUserSubject : async () => undefined;
}
