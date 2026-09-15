// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import {
  assertSharedLeavesLast,
  type ManagedEnvironment,
  otherEnvironmentsRunning,
  type SharedPart,
} from "@pithy-sh/secrets/src/scope";

/**
 * **A teardown's limits, held by the CLI rather than by whichever orchestrator runs it (#591).**
 *
 * `pithy support`, `storage` and `media` load their orchestrator from the project's own install; `email` and
 * `secrets` from the CLI's dependency. Either copy can predate the rules the CLI was released with. Support's
 * before #591 removed the inbound routing rule first and asked nothing after, so `--env staging --routing-zone`
 * stopped production's inbound mail. Every copy before #254 took no environment at all and walked the enum.
 *
 * So the CLI does not hand the orchestrator its deprovisioner. It hands it this: the same methods, each under a
 * rule the command wrote from what the operator typed.
 *
 * - `"read"` — a lookup. Any environment.
 * - `"environment"` — deletes one environment's resource. Only the target's; any other is refused and not made.
 * - `"refused"` — a delete the operator did not ask for. Every call is refused.
 * - a {@link SharedPart} — what every environment shares, asked for by its flag. Checked by `assertSharedLeavesLast`
 *   **here, before this returns**, so no orchestrator has been called when it refuses.
 * - `"last"` — a shared credential that is kept rather than refused: skipped while another environment runs.
 *
 * **What it does not hold.** Order within the target (a copy that deletes the worker before counting retained rows
 * is not caught here; the delete-time budget is the floor under that). A method a copy calls that the CLI's
 * deprovisioner does not have fails as it always did. A refusal mid-run leaves what the copy already deleted for the
 * target deleted.
 */
export type TeardownRule = "read" | "environment" | "refused" | "last" | SharedPart;

/** One rule per method of the deprovisioner — every method, so a new one cannot go unclassified. */
export type TeardownRules<D> = {
  [K in keyof D as D[K] extends (...args: never[]) => unknown ? K : never]-?: TeardownRule;
};

/** What {@link confineTeardown} confines. */
export interface TeardownConfinement<D> {
  /** The package whose orchestrator runs the teardown — what a refusal names. */
  kit: string;
  /** The one environment being torn down. */
  target: ManagedEnvironment;
  /** Every environment the project declares. */
  declared: DeclaredEnvironments | readonly string[];
  /** Whether an environment still runs the capability's Worker. Required when any rule is shared or `"last"`. */
  runs?: (env: ManagedEnvironment) => Promise<boolean>;
  /** The CLI's own deprovisioner. */
  deprovisioner: D;
  /** How each of its methods may be used. */
  rules: TeardownRules<D>;
}

/**
 * The deprovisioner an orchestrator is handed, confined to what the operator asked for — or a refusal, before any
 * orchestrator runs, when a shared part may not go yet. See {@link TeardownRule}.
 */
export async function confineTeardown<D extends object>(confinement: TeardownConfinement<D>): Promise<D> {
  const { kit, target, declared, runs, deprovisioner } = confinement;
  const rules = Object.entries(confinement.rules) as [string, TeardownRule][];
  const shared = rules.flatMap(([, rule]) => (typeof rule === "object" ? [rule] : []));
  const needsRuns = shared.length > 0 || rules.some(([, rule]) => rule === "last");
  if (needsRuns && runs === undefined) {
    throw new InternalError({
      message: "A teardown was confined without a way to ask which environments still run.",
      detail: `${kit}: a shared or last-only rule needs \`runs\`.`,
    });
  }
  if (runs !== undefined) await assertSharedLeavesLast(target, declared, runs, shared);
  const last =
    runs !== undefined && rules.some(([, rule]) => rule === "last")
      ? (await otherEnvironmentsRunning(target, declared, runs)).length === 0
      : false;

  const methods = deprovisioner as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const confined: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [name, rule] of rules) {
    confined[name] = async (...args) => {
      if (rule === "last" && !last) return undefined;
      if (rule === "refused" || (rule === "environment" && args[0] !== target)) {
        throw new ValidationError({
          message: `${kit} asked for ${name}(${args.map((arg) => JSON.stringify(arg)).join(", ")}) while tearing down ${target}. Refused.`,
          action: `Update ${kit} to match this CLI, then run it again.`,
          detail: `The rule for ${name} is ${JSON.stringify(rule)}.`,
        });
      }
      return methods[name]?.apply(deprovisioner, args);
    };
  }
  return confined as D;
}
