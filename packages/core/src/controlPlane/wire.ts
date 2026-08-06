// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The control-plane wire contract: the names both ends of the seam must spell identically.
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
 */
export const CONTROL_PLANE_VERSION_HEADER = "pithy-worker-version";
