// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The control-plane wire contract: the names both ends of the seam must spell identically, and the one
 * rule for reading what they carry.
 *
 * **This module imports nothing, and that is its whole job.** Per `docs/CONTROL-PLANE.md` §4 a browser
 * calls the adopter's Worker *directly* — the management client's server mints the token, the browser
 * sends it — so a DOM-typed module has to name the request header, and has to read the version header
 * off the response to notice a customer deploying mid-session. Reaching these constants through
 * `http/verify` drags the verifier in with them: WebCrypto, the replay guard, the seam config. A
 * program compiled against `lib.dom` then fails on `token/digest.ts` and `token/jws.ts`, where a
 * `Uint8Array<ArrayBufferLike>` is not the `BufferSource` the DOM lib declares — the Workers and DOM
 * type libraries meeting, which no amount of care at the call site resolves.
 *
 * The alternative was to let each client re-declare the strings. That is what the dashboard did, with
 * a comment and an assertion holding the copy honest, and two copies of a wire constant is exactly the
 * drift a constant exists to prevent. `wire.test.ts` asserts the module graph here stays empty, because
 * the property is only true until someone adds the first convenient import.
 *
 * {@link workerBuildChanged} is here for the same reason one level up. The dashboard did not only copy
 * the header name — it wrote its own rule for reading the value, "invalidate when the id differs", and
 * that rule was wrong in a way a copied constant could never have caught. A rule both ends must agree on
 * belongs beside the names both ends must spell.
 */

/**
 * The header a control-plane token is presented on.
 *
 * Not `Authorization`, deliberately: `@pithy-sh/auth` builds a Better Auth instance for any request
 * carrying that header, so a management call would drag the whole auth stack in. See `http/verify.ts`.
 */
export const CONTROL_PLANE_HEADER = "pithy-control-plane";

/**
 * The response header carrying the build that answered a control-plane call.
 *
 * Set on every control-plane response — allowed and denied alike, and on every capability's admin
 * routes rather than only the seam's own. A management client reads it to pin each recorded action to
 * the exact build it hit, and to notice a version changing mid-session, which is the moment a rendered
 * pane has quietly gone out of date. Absent where the `CF_VERSION_METADATA` binding is, which reads as
 * "this Worker cannot say" rather than as a value to trust.
 *
 * **Carries the id and nothing else, permanently.** Its companion below is a second header rather than
 * a second field in this one for one reason: a client already deployed compares this whole string. Fold
 * anything into it and the day the adopter upgrades the kit reads as a version change that never
 * happened — a false invalidation, which is the failure the pair exists to prevent, arriving from the
 * fix for it.
 */
export const CONTROL_PLANE_VERSION_HEADER = "pithy-worker-version";

/**
 * The response header carrying the **timestamp the platform reports for the running build** — ISO-8601,
 * verbatim, off the same `CF_VERSION_METADATA` binding as the id.
 *
 * Read beside {@link CONTROL_PLANE_VERSION_HEADER}, never folded into it, so a client can compare two
 * values separately. {@link workerBuildChanged} is the rule; do not hand-write one.
 *
 * **Which moment this names is not settled, and nothing here depends on knowing.** Cloudflare documents
 * the binding's `timestamp` as when the version was *created*; the first adopter's maintainer reports
 * seeing it move on a *rollback*, which would make it the moment of deployment. Nobody has measured it:
 * telling the two apart needs a real deploy and a real rollback against a real account, and a local
 * `wrangler dev` cannot stand in because it mints a fresh version on every restart. So this value is
 * relayed and compared, never interpreted — "it moved" is a fact, "it moved backwards, therefore a
 * rollback" is a reading of a field whose meaning is open. Settle it by observing one, then say so here.
 */
export const CONTROL_PLANE_VERSION_CREATED_HEADER = "pithy-worker-version-created";

/**
 * The pair a client reads off one control-plane response: two `headers.get()` calls, each `string | null`.
 */
export interface WorkerBuild {
  /** {@link CONTROL_PLANE_VERSION_HEADER}, or `null` where the response carried none. */
  version: string | null;
  /** {@link CONTROL_PLANE_VERSION_CREATED_HEADER}, or `null` where the response carried none. */
  createdAt: string | null;
}

/**
 * Did the Worker answering now differ from the Worker that answered before?
 *
 * **The rule, total over the pair.** A client compares field by field and only where both sides carried
 * a value; anything that differs is a change. That yields four states, and the fourth is the one this
 * function exists for:
 *
 * - nothing differs — the same build, still answering. Say nothing.
 * - `version` differs — a different build is live, and what is rendered came from one that no longer
 *   serves.
 * - `version` the same, `createdAt` differs — **the same build was deployed again.** Same consequence.
 * - either side silent on a field — that field says nothing.
 *
 * The third state is why a rule keyed on the id alone was wrong, and it is safe whichever moment
 * `createdAt` names: if it is the version's creation time the state never occurs and the branch is
 * dead; if it is the deployment's, it is precisely the redeploy #260 was filed for. Direction is *not*
 * interpreted — "earlier" and "later" have no agreed meaning until somebody measures the field.
 *
 * **Absence is never change**, in every direction: a Worker that declares no `version_metadata` sends
 * neither header, a call that failed before its headers were read has none, and a client that has not
 * looked yet holds nulls. A blank value counts as absent too — the seam never sends one, but a proxy in
 * between can blank a header it does not understand, and an empty string differs from every real id. The
 * failure this shape refuses is the one that costs an adopter trust: invalidating a rendered pane on a
 * deploy that never happened.
 */
export function workerBuildChanged(before: WorkerBuild, after: WorkerBuild): boolean {
  return differs(before.version, after.version) || differs(before.createdAt, after.createdAt);
}

/** One field of the pair: a difference only where both sides actually said something. */
function differs(before: string | null, after: string | null): boolean {
  if (typeof before !== "string" || before.trim() === "") return false;
  if (typeof after !== "string" || after.trim() === "") return false;
  return before !== after;
}
