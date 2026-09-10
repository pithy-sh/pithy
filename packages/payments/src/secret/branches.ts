// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SecretBranchSeam } from "@pithy-sh/core/src/capability/capability";
import type { PaymentsRailToggles } from "../config/config";
import { PAYMENTS_RAILS } from "../data/rail";
import { PAYMENTS_PROVIDER_SECRET } from "./registry";

/**
 * **Which rails' credentials this project will actually be asked for.**
 *
 * `PaymentsProviderCredentials` is five optional blocks, because five rails are possible. Only the
 * catalog says which are on, and a rail that is off "refuses its routes and its webhook" — so its
 * credentials are a value nothing will ever read, and `pithy secrets create
 * payments-provider-credentials` must neither offer them nor write them (#516).
 *
 * **The mapping is stated here rather than matched by name in the CLI.** `rails.paddle` and
 * `PaymentsProviderCredentials.paddle` are spelled the same today, and that is a coincidence of two
 * declarations in this package rather than a rule anything holds. A CLI keying off the spelling would
 * be guessing, in the way #513 records: two things one line apart that convention cannot tell apart.
 * This capability has the toggles and the schema in one hand at construction, so it answers.
 *
 * `PAYMENTS_RAILS` rather than `Object.keys(rails)` — one stable order for the prompts, and the same
 * order every other per-rail sweep in this package uses.
 */
export function paymentsSecretBranches(rails: PaymentsRailToggles): SecretBranchSeam {
  return { [PAYMENTS_PROVIDER_SECRET]: PAYMENTS_RAILS.filter((rail) => rails[rail]) };
}
