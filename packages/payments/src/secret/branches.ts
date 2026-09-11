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

/**
 * **The same question one level up: is the secret reachable at all (#541).**
 *
 * {@link paymentsSecretBranches} says which *blocks* of the bundle a project will be asked for. With
 * every rail off there are none — and the bundle itself is then a value nothing will ever read, because
 * every read of it is behind a rail: the checkout routes, the webhook guard, and the reconciliation
 * Workflow each refuse before they reach the store. Every toggle defaults `false`, so this is the state
 * `pithy add payments` leaves a project in until a rail is named, and `pithy doctor` listed the
 * credential as outstanding work under *"fine to leave until you need it"* for the whole of it.
 *
 * Declared here rather than derived by the CLI from an empty branch list, for
 * {@link paymentsSecretBranches}' own reason: an empty list is *no blocks to ask for*, which is not the
 * same claim as *nothing reads this*, and a reporting command that conflated the two would be right by
 * luck. The capability holds the toggles, so the capability answers.
 */
export function paymentsInapplicableSecrets(rails: PaymentsRailToggles): Record<string, string> {
  if (PAYMENTS_RAILS.some((rail) => rails[rail])) return {};
  return { [PAYMENTS_PROVIDER_SECRET]: "payments() enables no rail, so no code path reads a credential" };
}
