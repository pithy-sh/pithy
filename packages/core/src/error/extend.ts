// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MessageParams } from "../i18n/catalog";
import type { ErrorPayload, KitErrorDomain } from "./payload";
import { ExtendedErrorPayload } from "./payload";
import { InternalError } from "./pithyError";

/** How much of a rejected code the public message will quote. Enough to debug, not enough to abuse. */
const QUOTED_CODE_LIMIT = 72;

/**
 * A kit domain used in an adopter's code. The false branch is `unknown`, which intersects away; the
 * true branch is a string the caller's own `code` cannot possibly be, so the mistake surfaces at the
 * declaration with its reason spelled out in the type error rather than as `never`.
 */
type ReservedDomain<Code extends string> = Code extends `${KitErrorDomain}/${string}`
  ? { code: "That domain is the kit's. Namespace your code under a domain of your own." }
  : unknown;

/**
 * The payload behind one code, kit or adopter. `Extract` finds a kit member by its literal `code`;
 * an adopter's code is branded and so extracts to nothing, and the open member stands in with the
 * literal intersected back on. Type a vehicle class with it exactly as the kit's own subclasses are:
 * `declare readonly payload: ErrorPayloadOf<"connect/device_code_expired">`.
 */
export type ErrorPayloadOf<Code extends string> = [Extract<ErrorPayload, { code: Code }>] extends [never]
  ? ExtendedErrorPayload & { code: Code }
  : Extract<ErrorPayload, { code: Code }>;

/**
 * Narrow a caught payload to one code. `payload.code === "core/not_found"` narrows a kit member on
 * its own, but an adopter's code is branded — the brand is what keeps a kit narrow honest — so the
 * same comparison against a bare literal is a type error, and `Extract` on it is silently `never`.
 * This is the way in for both: one guard, kit codes and adopter codes alike.
 *
 * ```ts
 * catch (error) {
 *   if (error instanceof PithyError && isErrorCode(error.payload, "connect/device_code_expired")) {
 *     return restartDeviceFlow();
 *   }
 * }
 * ```
 */
export function isErrorCode<const Code extends `${string}/${string}`>(
  payload: ErrorPayload,
  code: Code,
): payload is ErrorPayloadOf<Code> {
  return payload.code === code;
}

/**
 * The one door into `ErrorPayload` for a code the kit does not define. An adopter writing a control
 * plane, a device-code flow, or a key-rotation lock has failures the kit has no word for; without
 * this they reuse a kit code that means something else, or stop throwing `PithyError` at all.
 *
 * It is a function rather than a plain object literal for the same reason `defineSecretRegistry` is:
 * the declaration is where the mistake is, so the declaration is where it should fail. A code under
 * one of the kit's domains does not compile — the kit's domains are reserved the way `pithy_` table
 * names are, so nobody redefines `auth/forbidden` with a status of their choosing, and a
 * capability's own typo stays a hard failure instead of becoming somebody's custom error. The parse
 * below is the second gate, for the grammar, the 4xx/5xx bound, and any caller who cast their way
 * past the first.
 *
 * What it does **not** do is pin a status to a code. A kit member fixes one status per code, and
 * that cannot survive a set the kit does not hold: this seam bounds the range and nothing more, so
 * throwing `connect/device_code_expired` as a 410 from one site and a 500 from another passes every
 * layer. Declare each of your codes in one vehicle class, once, and that stays true by construction.
 *
 * It does not move the security boundary either. The payload it returns carries `action` and
 * `detail` exactly like a kit member, and the HTTP codec strips both from every member alike. An
 * adopter cannot opt into leaking, because there is nothing to opt into — the wire shape has no such
 * key to fill, whoever defined the code.
 *
 * ```ts
 * export class DeviceCodeExpiredError extends PithyError {
 *   declare readonly payload: ErrorPayloadOf<"connect/device_code_expired">;
 *
 *   constructor(detail?: string) {
 *     super(defineErrorPayload({
 *       code: "connect/device_code_expired",
 *       status: 410,
 *       message: "That device code has expired.",
 *       action: "Run pithy dashboard connect again.",
 *       detail,
 *     }));
 *   }
 * }
 * ```
 */
export function defineErrorPayload<const Code extends `${string}/${string}`>(
  payload: {
    /** `domain/reason`, lower snake_case, under a domain of the adopter's own — never one the kit uses. */
    code: Code;
    /** The HTTP status this code maps to. A 4xx or a 5xx — an error is not a success. */
    status: number;
    /** Public, safe-to-expose summary. Sent to clients and shown in the terminal. */
    message: string;
    /** Operator remediation hint. Becomes the CLI action line. Never sent to a client. */
    action?: string;
    /** Internal context for logs + audit. NEVER serialized to clients — the HTTP codec strips it. */
    detail?: string;
    /**
     * Values a translating client interpolates into its own wording for this code. Client-facing:
     * these cross the boundary with `message`, unlike `action` and `detail`.
     *
     * Stated here because this parameter type is **hand-written**, not derived from the schema, and
     * the `as ErrorPayloadOf<Code>` below hides the gap from the compiler. A field left off this
     * literal is not a type error anywhere — it is simply a field an adopter cannot pass.
     */
    params?: MessageParams;
  } & ReservedDomain<Code>,
): ErrorPayloadOf<Code> {
  const parsed = ExtendedErrorPayload.safeParse(payload);
  if (!parsed.success) {
    // An author error, like a malformed secret registry — so it reads as one. The offending code and
    // status are the adopter's own source, safe to name; the caller's `detail` is not echoed back.
    // The code is quoted short because `message` is the public half, and a caller who cast their way
    // to a dynamic code must not get to choose how many of its bytes we reflect into a 500 body.
    throw new InternalError({
      message: `error payload: "${quoteCode(payload.code)}" (${payload.status}) is not a usable adopter error code.`,
      action:
        "Use `<your_domain>/<reason>` in lower snake_case, a 4xx or 5xx status, and a domain the kit does not own.",
      detail: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    });
  }
  // The parse proved the shape; it cannot prove to TypeScript that `code` survived as the literal
  // the caller passed, because the branded template literal it validates against is wider than that.
  return parsed.data as ErrorPayloadOf<Code>;
}

/** The offending code, bounded, for an author-error message that reaches a client. */
function quoteCode(code: string): string {
  return code.length <= QUOTED_CODE_LIMIT ? code : `${code.slice(0, QUOTED_CODE_LIMIT)}…`;
}
