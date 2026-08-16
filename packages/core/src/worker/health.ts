// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **Where every Pithy Worker answers liveness — written once, read by everyone who needs it.**
 *
 * `createBackend` mounts this route, the CLI's route allowlist keeps it worker-first, `pithy deploy`
 * probes it after a release, and the bare home screen a no-auth scaffold ships fetches it. Four sites,
 * one path, and until #400 each of them wrote it out.
 *
 * The failure that earned this module is the quietest one in the front end. `home.bare.tsx` is the
 * **only** screen a project with no auth composed gets, and its entire content is that one request. A
 * rename here without a matching edit there renders *"The worker says: unknown."* — a 200, no error, no
 * failed build, nothing in a log. The adopter's first screen showing a word that is not a status, for a
 * reason nowhere on the page.
 *
 * A gate comparing the copies would have watched that. This removes it instead: the template imports
 * the constant, so a rename moves the screen with it, and there is no second string left to disagree
 * with. `docs/CONVENTIONS.md` § *Seeded files* is the general form — **removing the class beats
 * watching it** — and #377, #366, #393 and #394 are the same move made earlier.
 *
 * ## Why a module of its own
 *
 * Because a client bundle imports it. Everything else in `@pithy-sh/core` that a route path could sit
 * beside pulls Hono, the Workers types, or both, and the scaffolded SPA is a browser program that must
 * import neither. This file declares one string and imports nothing, so the seeded screen can read it
 * without dragging a server runtime into the client's program.
 */

/**
 * `GET /health` — public, and deliberately so.
 *
 * It reads nothing about the caller, so there is no session to send it. That is what makes it the one
 * request the bare home screen can make with no auth capability in the project, and why
 * `sameOrigin.test.ts` exempts that screen's `fetch` rather than routing it through a credentialed
 * primitive.
 *
 * The leading slash is part of the value. Hono mounts it, `firstSegment` splits it, and `verifyDeploy`
 * appends it to a declared origin — all three want the same string, and a bare `health` would make two
 * of them concatenate wrongly in silence.
 */
export const HEALTH_PATH = "/health";
