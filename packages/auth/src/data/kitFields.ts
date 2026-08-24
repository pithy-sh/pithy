// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Locale } from "@pithy-sh/core/src/i18n/locale";

/**
 * The columns Pithy adds to Better Auth's own tables, declared **once**.
 *
 * Better Auth owns every read and write to `pithy_auth_users` and `pithy_auth_sessions` through its
 * Kysely adapter, and it writes only the fields its options declare. So a column that exists in the
 * migration and in the `User` Zod object and *not* here is null forever and absent from every user
 * object the instance returns — a migration and a schema field that silently did nothing.
 *
 * ## Why one module rather than two agreeing declarations
 *
 * These have to appear in two places: `makeAuth`'s live options (`../instance/auth.ts`) and the
 * schema baseline `pluginSchemaDelta` subtracts each adopter plugin's schema from
 * (`../migrations/pluginTables.ts`). Both were written out by hand, with a comment in each saying it
 * "must match" the other and a test claiming to hold them together. The test did not: it compared the
 * baseline against the `User` schema and never imported `makeAuth` at all, so reverting the live
 * declaration left the whole suite green while Better Auth silently stopped writing the column (#441).
 *
 * `docs/CONVENTIONS.md` is explicit that removing an invariant beats watching it. There is one object
 * now, imported by both, and the two cannot disagree because there is no second thing to disagree
 * with. That is also why the consequence is worth restating rather than diluting: leave a kit column
 * out of the baseline and `pluginSchemaDelta` reports it as something an adopter's plugin brought, so
 * a plugin that also declares a user `locale` emits `ALTER TABLE … ADD COLUMN locale` against a table
 * that already has one — a duplicate-column failure part-way through a migration D1 cannot roll back,
 * because it has no transactional DDL.
 */

/**
 * The extra `pithy_auth_users` columns.
 *
 * **`locale` is `input: true`, deliberately, and that is the whole point of the column.** Every other
 * extra field the kit declares is server-set — {@link KIT_SESSION_FIELDS} is `input: false` because a
 * client that could name its own device or token family could name somebody else's. A locale is the
 * opposite: it is the reader's own preference, and the flow it exists for is a signed-in reader
 * switching language and having the choice follow them to their next device. Refusing client input
 * would leave an admin route as the only way to store a preference, which is not a thing a reader has.
 *
 * **What makes that safe is the validator, not the type.** `type: "string"` alone would let a caller
 * write any string into a column every read passes through `User.parse` — so one `updateUser` with a
 * megabyte of junk would poison that row, and the admin listing that reads a page of rows would then
 * throw for every operator rather than only for the author. Better Auth runs `validator.input` on the
 * supplied value and answers 400 on a failure (`parseInputData`), so the same schema that guards the
 * read guards the write, one hop earlier.
 *
 * **And it is `Locale.nullable()`, not `Locale`.** The column is nullable, the `User` field is
 * nullable, `AdminUserView` is nullable, and every one of those says the same thing: null is "this
 * reader has not chosen", which is what makes the server fall back to `Accept-Language`. A validator
 * that accepted a tag but refused `null` would let a reader pick a language and never take it back —
 * `updateUser({ locale: null })` answering 400 for the one state the schema calls ordinary.
 */
export const KIT_USER_FIELDS = {
  locale: { type: "string", required: false, input: true, validator: { input: Locale.nullable() } },
} as const;

/**
 * The extra `pithy_auth_sessions` columns — the bound device, and the refresh-token family carried
 * across rotations.
 *
 * `input: false` on both: these are server-set facts about a session, and a client able to name its own
 * device id or token family could name somebody else's.
 */
export const KIT_SESSION_FIELDS = {
  deviceId: { type: "string", required: false, input: false },
  familyId: { type: "string", required: false, input: false },
} as const;
