// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The request schemas for the auth routes Pithy owns. Validation happens at the HTTP boundary
 * (CLAUDE.md §Zod), declared on the route line with `zValidator(target, Schema, validationHook)` — so
 * reading `routes.ts` tells you what each route accepts without opening a handler.
 *
 * Only Pithy's own routes appear here. Everything under `basePath` that Better Auth owns validates
 * itself, behind a catch-all that must hand it an unread request body.
 */

/**
 * The body of `POST /devices/revoke`. `deviceId` is client-minted (it arrives as the
 * `x-pithy-device-id` header at sign-in), so it is bounded rather than shape-checked: a well-formed
 * id that matches no row must still reach the handler, which answers `{ revoked: 0 }`.
 */
export const RevokeDeviceBody = z
  .object({
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .describe("The id of the device to revoke — the client-generated id it registered at sign-in."),
  })
  .describe("The body identifying which of the authenticated user's devices to revoke.");
export type RevokeDeviceBody = z.output<typeof RevokeDeviceBody>;
