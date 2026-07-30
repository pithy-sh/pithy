// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The request schemas for the email callback routes. Validation happens at the HTTP boundary
 * (CLAUDE.md §Zod), declared on the route line with `zValidator(target, Schema, validationHook)` — so
 * reading `callbacks.ts` tells you what each route accepts without opening a handler.
 *
 * Both schemas bound a value that already reaches the handler as free-form text. Neither tries to
 * *authenticate* anything: the token's signature is still the only gate, checked by `verifyToken`, and
 * a well-formed but forged or expired token still answers `email/invalid_token` (400).
 */

/**
 * The characters a callback token path segment may contain: the base64url alphabet, plus `.` — the
 * token's own `<payload>.<signature>` separator, and the `.png` suffix mail clients append to an
 * open-pixel URL (which `handleOpen` strips before verifying). Deliberately not a strict base64url
 * check: that would 400 every tracking pixel.
 */
const TOKEN_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The `:token` path parameter every callback route carries. A shape and size bound only — the ceiling
 * is generous enough for a click token whose signed claims embed a long destination URL, so no link we
 * mint can exceed it, while an unbounded segment can no longer reach the verifier.
 */
export const CallbackTokenParam = z
  .object({
    token: z
      .string()
      .min(1)
      .max(4096)
      .regex(TOKEN_SEGMENT)
      .describe("The signed callback token from the path, optionally with the open-pixel `.png` suffix."),
  })
  .describe("The path parameter carrying a click/open/unsubscribe callback token.");
export type CallbackTokenParam = z.output<typeof CallbackTokenParam>;

/**
 * The optional `?reason=` on the unsubscribe callback — supplied by the app's own preferences flow.
 * The bound is a ceiling, not the storage limit: the handler still truncates to 200 characters before
 * writing, so every real value keeps behaving exactly as it did and only an absurd one is refused.
 */
export const UnsubscribeQuery = z
  .object({
    reason: z
      .string()
      .max(2000)
      .optional()
      .describe("Why the recipient opted out; truncated to 200 characters before it is stored."),
  })
  .describe("The optional query parameters accepted by the unsubscribe callback.");
export type UnsubscribeQuery = z.output<typeof UnsubscribeQuery>;
