// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SecretApplicability, UnresolvedEnvironment } from "../capabilities/secretApplicability";

/**
 * **Does every declared environment's `pithy.config.ts` actually load?** (#548)
 *
 * A `pithy.config.ts` is code, and the kit teaches it to read the environment it is being composed for —
 * `pithy init` scaffolds `originFor(compositionEnvironment(), DOMAINS)` into every one. So a config can
 * load under `dev` and throw under `prod`, and the project that found this did exactly that: `prod` threw
 * `Billing is not configured for this environment`, on every command that composed it, and nothing said so.
 *
 * **It is found here because something else needed the answer, and it is reported here because it is the
 * bigger fault.** `projectSecretApplicability` composes every declared environment to decide which secrets
 * apply — the one thing in the CLI that takes all three compositions — so it is the first thing in a run
 * that learns `prod` will not load. It used to feed that failure back into its own fold as *every name in
 * reach*, which turned #541 off wherever one environment was half-configured; it contributes nothing now,
 * and this is where what it found gets said.
 *
 * **Its own block, and not a line inside `Dev secrets:`.** The reader does not have a narrow secret
 * listing; they have a Worker whose configuration does not load for a deployed environment. `pithy deploy`,
 * `pithy migrate`, `pithy provision` and `pithy dev` all compose that config, and every one of them fails
 * the same way. A footnote under a list of OAuth credentials is not where that belongs.
 *
 * **And it fails the exit**, on the standard `doctorExitCode` states: only a fault the project's own
 * config or wiring positively establishes may gate CI, and this is established from the checkout's own
 * files with no account reached and nothing inferred. There is no day-one state to spare here either — a
 * freshly scaffolded project composes in every environment it declares.
 */
export interface EnvironmentConfigsCheck {
  /**
   * The declared environments whose composition threw, each with the failure's own `action` line.
   *
   * Empty is the healthy answer and prints nothing. The reasons are the configs' own sentences — never
   * prose about them, and never a `detail`, which is the throw site's alone (`CLAUDE.md` §Errors).
   */
  unresolved: readonly UnresolvedEnvironment[];
}

/**
 * Project the applicability sweep's findings into the check doctor reports.
 *
 * A projection rather than a resolution of its own, deliberately: composing every Worker under every
 * declared environment costs a fresh import per pair, and asking twice in one run would double it to learn
 * the same fact. `buildDoctorReport` resolves it once and all three readers take the answer.
 */
export function checkEnvironmentConfigs(applicability: SecretApplicability): EnvironmentConfigsCheck {
  return { unresolved: applicability.unresolved };
}

/**
 * The lines the report prints, or none at all when every declared environment composed.
 *
 * One line per environment, with the config's own action beneath it — the shape every `PithyError` renders
 * in, and the shape `Settings:` uses for the same reason: the problem and the remedy are two facts and the
 * reader acts on the second.
 */
export function describeEnvironmentConfigs(check: EnvironmentConfigsCheck): string[] {
  return check.unresolved.map(({ environment, reason }) => `${environment}: ${reason}`);
}
