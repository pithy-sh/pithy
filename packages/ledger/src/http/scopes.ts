// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * The ledger's control-plane scopes, and the admin surface a manifest advertises.
 *
 * **Separate from `guards.ts` because a scope name is a client's business** (#315). A management
 * client reads these to render what a connection may do, and `pithy-sh/dashboard`'s scope builder
 * writes the `pithy dashboard connect --scope …` command from exactly these constants — in a browser
 * program, with the DOM lib and no Workers types. While they sat beside the Hono middleware, naming
 * one compiled `PithyHonoEnv`, which reached core's `capability.ts`, which named Worker globals that
 * program has none of. **This module imports types and nothing else, and a gate holds it there**:
 * `tooling/browser-scopes` compiles a DOM-only program against every scope the kit declares.
 *
 * ## Two scopes, not one admin flag
 *
 * `scopeCovers` matches exactly, with no prefix or wildcard rule, so these two confer nothing about
 * each other — and they should not, because they disclose different things. A **balance** is a number:
 * what an account holds right now. An **entry log** is a behavioural record: every wager placed, every
 * payout taken, every purchase, in order, with whatever note the adopter's own code wrote on it. A
 * balances pane and a support tool answering "why is my chip count wrong" need different halves of
 * that, and an adopter who wants to hand out only the shallower one must have a way to say so.
 *
 * The names are constants rather than config: a configurable scope name is a way to misconfigure a
 * default-denied gate into a differently-named one, and tooling that read the docs would then hold a
 * scope nothing checks. They are also the join key with what `pithy dashboard connect` offers an
 * adopter to grant, so they must be the same strings in both places.
 *
 * ## There is no write scope, and that is the whole design
 *
 * Nothing here grants a management client the ability to move a balance. Adjusting a ledger from an
 * admin console needs the same care as any other movement — an idempotency key, an audited reason, a
 * reversal path — and shipping a `POST /adjust` that has none of them would make the console the one
 * place the ledger's guarantees do not hold. Balance movement stays server-authoritative: in-process
 * through `openLedger`, or over the existing player-facing admin routes behind the auth scope.
 */

/** Read balances: the account list, and one player's position in each currency. A number, not a story. */
export const LEDGER_ACCOUNTS_READ_SCOPE: ControlPlaneScope = "ledger:accounts:read";

/**
 * Read the append-only entry log behind a balance — every movement, in order, with its memo. Strictly
 * more disclosure than the balance itself, which is why it is granted separately.
 */
export const LEDGER_TRANSACTIONS_READ_SCOPE: ControlPlaneScope = "ledger:transactions:read";

/**
 * Every control-plane scope the ledger defines — what `pithy dashboard connect` offers for this
 * capability, and the list a manifest or a doc quotes rather than re-typing.
 */
export const LEDGER_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  LEDGER_ACCOUNTS_READ_SCOPE,
  LEDGER_TRANSACTIONS_READ_SCOPE,
];

/**
 * The ledger's management surface, as `GET /control-plane/manifest` reports it.
 *
 * Declared beside the scopes rather than in `routes.ts` so the scope a route demands and the scope a
 * manifest advertises are the same constant, read from one place. `basePath` is a parameter and never a
 * default: an adopter who mounted the ledger at `/wallet` must get a manifest naming
 * `/wallet/admin/accounts`, or a management client composing its calls from it would 404 against
 * exactly the adopters who customised anything.
 *
 * **Everything sits under an `admin/` segment because the player surface already owns the one-segment
 * space.** `GET ${basePath}/:currency` matches any single segment, so a management route mounted at
 * `${basePath}/accounts` would collide with a currency called `accounts` and, worse, would sit behind
 * whichever of the two Hono matched first. The extra segment removes the ambiguity by construction
 * rather than by registration order.
 */
export function ledgerAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/admin/accounts`,
      scope: LEDGER_ACCOUNTS_READ_SCOPE,
      summary: "Page every account holding a balance, newest first, optionally in one currency.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/accounts/:userId`,
      scope: LEDGER_ACCOUNTS_READ_SCOPE,
      summary: "What one player holds, in every currency they have an account in.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/accounts/:userId/:currency/transactions`,
      scope: LEDGER_TRANSACTIONS_READ_SCOPE,
      summary: "The entry log behind one balance — every movement, newest first, with its memo.",
    },
  ];
}
