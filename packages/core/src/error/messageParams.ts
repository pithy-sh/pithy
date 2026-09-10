// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { KitErrorCode } from "./payload";

/**
 * The `params` a throw site **guarantees** for a kit error code — and therefore the only names a
 * locale may write as a `{placeholder}` in that code's sentence.
 *
 * **Why a declaration exists at all.** `params` crosses the wire with `message` so a translating
 * client can render its own wording for a code (CLAUDE.md §Errors), and `interpolate` leaves a
 * placeholder nobody supplied written out as `{apiAnswer}`. So a locale writing a placeholder is
 * making a claim about a *call site*, and a call is not a declaration — there was nothing in this
 * repository for a catalog test to read, which is why `@pithy-sh/i18n` could only pin the absence of
 * placeholders. This is that missing half: one table, in `core`, that both sides import.
 *
 * **Guaranteed means every throw, not most.** A name belongs here only when the code's throw sites
 * pass it on **every** path, including the degraded one — a Cloudflare call that never reached
 * Cloudflare still supplies `apiAnswer`, as the empty string. A param a throw site passes only
 * sometimes is still useful to a client reading `payload.params` directly, and is still stripped from
 * nothing; it simply may not be written into a sentence, because the sentence has to render on the
 * path where it is missing.
 *
 * A code absent from this table guarantees nothing, which is the honest default and the state of all
 * but one of them.
 */
export const GUARANTEED_ERROR_PARAMS: Partial<Record<KitErrorCode, readonly string[]>> = {
  // `@pithy-sh/cloudflare`'s `cloudflareRefusal` composes every Cloudflare refusal and always passes
  // `apiAnswer`: Cloudflare's own code and sentence, punctuated to append (`": 10000 Authentication
  // error"`), or `""` when the call failed without an answer. The value carries its own separator so
  // one sentence renders correctly both ways — a locale cannot write an `if`.
  "cloudflare/request_failed": ["apiAnswer"],
};

/** The names a locale may interpolate into `code`'s sentence. Empty when the code guarantees none. */
export function guaranteedErrorParams(code: string): readonly string[] {
  return GUARANTEED_ERROR_PARAMS[code as KitErrorCode] ?? [];
}
