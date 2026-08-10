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
 * The response header carrying **when the running version was uploaded** — ISO-8601, verbatim, off the
 * same `CF_VERSION_METADATA` binding as the id.
 *
 * Read beside {@link CONTROL_PLANE_VERSION_HEADER}, never folded into it, so a client can compare two
 * values separately. {@link workerBuildChanged} is the rule; do not hand-write one.
 *
 * **Cloudflare has two objects, and this is the first of them.** A *version* is an immutable upload of
 * code and config — id, created timestamp, tag, fixed at upload and never again. A *deployment* points
 * at one or more versions with traffic percentages, and is its own object with its own id and time. The
 * `CF_VERSION_METADATA` binding reports the version, and **the runtime hands a Worker no binding for the
 * deployment**. So this header is the upload moment, and it is fixed for as long as that version exists.
 *
 * That mechanism predicts the behaviour rather than merely recording it: **a rollback creates a new
 * deployment aimed at an existing version, so nothing here moves** — the binding is not stale and not
 * ambiguous, the thing that changed was a different object. It answers the next question too. A traffic
 * split, a gradual rollout, which deployment is serving: none of it is visible from inside a Worker.
 *
 * Measured on a real account, 2026-08-10, which is what made it a fact rather than a reading of the
 * docs: version `A` uploaded at `22:28:56.762349Z`, `B` four seconds later, `wrangler rollback` to `A`
 * at ~`22:29:20`. Reading at `22:31:37` returned `A`'s id **and `A`'s original timestamp**, unmoved,
 * while wrangler's own output named the new deployment's version list. Two details from the same run
 * that a client will meet:
 *
 * - **Every `wrangler deploy` mints a new version**, even for a one-character change — that is why `B`
 *   exists. An ordinary redeploy therefore always moves the id, and is never invisible.
 * - **Propagation lags.** Twenty seconds after wrangler reported the rollback at 100%, the URL still
 *   answered from the older version. A client watching closely sees the pair flip and settle; that is
 *   the platform converging, not two deploys.
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
 * a value; anything that differs is a change. Four states:
 *
 * 1. nothing differs — the same build, still answering. Say nothing.
 * 2. `version` differs — a different build is live, and what is rendered came from one that no longer
 *    serves.
 * 3. `version` the same, `createdAt` differs — **the same build was deployed again.** Same consequence.
 * 4. either side silent on a field — that field says nothing.
 *
 * **State 3 is not reachable on today's platform, and it stays anyway.** A version's timestamp
 * is fixed at upload and a rollback only makes a new deployment, so the pair cannot show a moved time
 * against an unmoved id (see {@link CONTROL_PLANE_VERSION_CREATED_HEADER}). It is here because a total
 * comparison over the pair is the correct shape, not because a rollback was expected to trip it — **a
 * comparison that enumerates which fields are allowed to move is wrong the day the platform moves a
 * different one**, and it is wrong silently, as "nothing changed". It costs one branch.
 *
 * Direction is *not* interpreted. A time that moved is a fact; "it moved backwards, therefore a
 * rollback" is not, and would be wrong twice over — a rollback moves neither field, and propagation lag
 * makes an older version answer for a while after a deploy.
 *
 * **What no state here reaches: a deployment.** Rollbacks, traffic splits, gradual rollouts — a Worker
 * has no binding for the object that carries them, so this is a boundary of what the runtime exposes
 * rather than a gap in the seam. A client that needs a deployment reads Cloudflare's deployments API.
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
