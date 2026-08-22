// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import * as audit from "@pithy-sh/audit/src/http/schemas";
import * as auth from "@pithy-sh/auth/src/http/schemas";
import * as email from "@pithy-sh/email/src/http/schemas";
import * as leaderboard from "@pithy-sh/leaderboard/src/http/schemas";
import * as ledger from "@pithy-sh/ledger/src/http/schemas";
import * as matchmaking from "@pithy-sh/matchmaking/src/http/schemas";
import * as media from "@pithy-sh/media/src/http/schemas";
import * as multiplayer from "@pithy-sh/multiplayer/src/http/schemas";
import * as payments from "@pithy-sh/payments/src/http/schemas";
import * as rating from "@pithy-sh/rating/src/http/schemas";
import * as secrets from "@pithy-sh/secrets/src/http/schemas";
import * as storage from "@pithy-sh/storage/src/http/schemas";
import * as support from "@pithy-sh/support/src/http/schemas";
import * as testers from "@pithy-sh/testers/src/http/schemas";
import * as vector from "@pithy-sh/vector/src/http/schemas";

/**
 * The rule, stated once more: **a module a browser may import reaches no module that needs the Workers
 * runtime.**
 *
 * `client.ts` states it for control-plane scopes and `responses.ts` for the response schemas. This file
 * states it for the third family on the same route line: the request contracts. §HTTP puts both halves
 * of a route's declaration in the same place — "how a caller is verified and what a caller may send are
 * two halves of one declaration" — and a management client composing a call against a customer's Worker
 * needs the second half in the browser, exactly as it needs the first to read the answer.
 *
 * #430 is the case, and it was latent rather than live: nothing imported a request schema from a browser
 * yet, so `leaderboard`'s reached `croner` through a board-key regex and `support`'s reached a Kysely
 * reader through a page cap, and every gate stayed green. That is a hazard with a date on it — the first
 * client to validate a request body against the schema that defines it would have found it the way #419
 * was found, in `pithy-sh/dashboard`, on a file nobody edited.
 *
 * **Namespace imports, deliberately.** Naming a handful of schemas would gate the modules those schemas
 * happen to reach and leave the rest of each file untested — and #419 arrived through a single import at
 * the top of a file, not through any particular export. `import * as` puts the whole module in the
 * program, which is what the adopter's bundler does with it anyway.
 *
 * `browserSurface.test.ts` is what stops this being a list: it derives the modules from the tree and
 * holds this file to all of them.
 *
 * Names only. There is nothing to assert about a Zod object that `tsc` has not already proven by
 * compiling the module that builds it.
 */
export const EVERY_REQUEST_SCHEMA_MODULE: readonly object[] = [
  audit,
  auth,
  email,
  leaderboard,
  ledger,
  matchmaking,
  media,
  multiplayer,
  payments,
  rating,
  secrets,
  storage,
  support,
  testers,
  vector,
];
