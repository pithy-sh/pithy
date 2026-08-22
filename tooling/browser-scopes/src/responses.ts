// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import * as audit from "@pithy-sh/audit/src/http/responses";
import * as auth from "@pithy-sh/auth/src/http/responses";
import * as email from "@pithy-sh/email/src/http/responses";
import * as ledger from "@pithy-sh/ledger/src/http/responses";
import * as payments from "@pithy-sh/payments/src/http/responses";
import * as secrets from "@pithy-sh/secrets/src/http/responses";
import * as support from "@pithy-sh/support/src/http/responses";
import * as testers from "@pithy-sh/testers/src/http/responses";

/**
 * The rule, stated once: **a module a browser may import reaches no module that needs the Workers
 * runtime.**
 *
 * `client.ts` states it for control-plane scopes. This file states it for the other half of the same
 * surface, and the half a management client actually *runs*: the response schemas. §HTTP makes a
 * response a Zod object rather than an interface precisely so a client can `.parse()` what a
 * customer's Worker answered — "the client of an admin route is a management client reading a
 * *customer's* Worker across a trust boundary, so it must validate what comes back". A schema whose
 * module a browser program cannot compile is a schema that cannot do that job, whatever the Worker
 * thinks of it.
 *
 * #419 is the case. One line landed in `support/src/http/responses.ts` — a scope constant imported
 * from `link/sender.ts`, the module that queries D1 for a sender's purchases — and the whole server
 * data layer came with it. `sender.ts` reaches `@pithy-sh/auth/src/data/tables`, which named
 * `D1Database` off the global scope, so the adopter's client program stopped compiling on an error in
 * neither its own code nor the module it imported:
 *
 * ```
 * ../pithy/packages/auth/src/data/tables.ts(35,34): error TS2552: Cannot find name 'D1Database'.
 * ```
 *
 * Every kit gate stayed green, because the kit typechecks itself against its own `node_modules`,
 * where the Workers types are always present. It reached `pithy-sh/dashboard`, which is what
 * `pithy init` leaves a contributor with, and that is the only reason anybody knew.
 *
 * **Namespace imports, deliberately.** Naming a handful of schemas would gate the modules those
 * schemas happen to reach and leave the rest of each file untested — and #419 arrived through a
 * single import at the top of a file, not through any particular export. `import * as` puts the whole
 * module in the program, which is what the adopter's bundler does with it anyway.
 *
 * `browserSurface.test.ts` is what stops this being a list: it derives the modules from the tree
 * and holds this file to all of them.
 *
 * Names only. There is nothing to assert about a Zod object that `tsc` has not already proven by
 * compiling the module that builds it.
 */
export const EVERY_RESPONSE_MODULE: readonly object[] = [
  audit,
  auth,
  email,
  ledger,
  payments,
  secrets,
  support,
  testers,
];
