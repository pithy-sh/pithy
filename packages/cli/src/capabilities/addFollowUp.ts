// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { type CloudflareAccountSelection, cloudflareEnv, pithyOffline } from "../cloudflare/config";
import { establishedPending } from "../migrations/pendingCount";
import { type MigrationFanOutOptions, type ProjectLedger, readProjectLedger } from "../migrations/run";
import { loadProject, loadProjectEnvironments } from "../project/config";
import {
  type BindingProvisioning,
  bindingProvisioning,
  type UnprovisionedBinding,
  unprovisionedBindings,
} from "../provision/unprovisioned";
import { addNext, type NextStep } from "../terminal/nextSteps";

/**
 * **What `pithy add` leaves an environment that was ready before it, gathered for `next` (#697).**
 *
 * The add wires one Worker and migrates `dev`, and nothing else. Two things it can leave behind in a deployed
 * environment are required before that environment works, and both are facts this module reads rather than
 * guesses at:
 *
 * - **A binding with no resource, in an environment a provision had readied before.** Deploy
 *   refuses that stanza. An environment that was never provisioned is not the add's to report — it was not
 *   deployable before either — so the comparison is before and after, and {@link readyEnvironments} is the
 *   before half, read before the add writes anything.
 * - **Migrations pending where the environment is provisioned.** Read from the ledger, for the Worker the add
 *   wired, and only when the add's own `dev` run applied something: an add that brought no migration left
 *   none pending, and reads no database to say so. The count is the ledger's whole, which is why the step's
 *   `why` does not credit it to the capability.
 *
 * **An answer nobody could establish is no step.** Offline, no credentials, a read that threw or one where no
 * database answered: the add has succeeded, and a `next` it cannot vouch for is the guess this key exists
 * not to be.
 */

/** The reads this module makes, as seams. Each defaults to the real one. */
interface Reads {
  /** The bindings `env`'s stanzas have no resource for. Defaults to {@link unprovisionedBindings}. */
  unprovisioned?: (env: string) => Promise<UnprovisionedBinding[]>;
}

/**
 * The declared environments a provision has readied, read before the add, so the add's own bindings cannot
 * hide which environments were ready. `dev` is never one: it is Miniflare and has none.
 *
 * **Ready takes evidence, not an absence.** An environment is ready when every binding has a resource and at
 * least one D1 or KV binding carries an id a provision wrote. "Nothing lacks an id" alone is also true of the
 * empty stanzas `pithy init` writes into every environment, so a project nobody provisioned would read as
 * ready everywhere, and the add's first binding would earn a provision `next` for environments nobody meant
 * to deploy.
 */
export async function readyEnvironments(options: {
  projectDir: string;
  environments?: readonly string[];
  /** One environment's binding ids. Defaults to {@link bindingProvisioning}. */
  provisioning?: (env: string) => Promise<BindingProvisioning>;
}): Promise<string[]> {
  const environments = options.environments ?? loadProjectEnvironments(await loadProject(options.projectDir));
  const provisioning = options.provisioning ?? ((env: string) => bindingProvisioning(options.projectDir, env));
  const ready: string[] = [];
  for (const env of environments) {
    if (env === LOCAL_ENVIRONMENT) continue;
    const read = await provisioning(env);
    if (read.missing.length === 0 && read.provisioned > 0) ready.push(env);
  }
  return ready;
}

/**
 * Whether a deployed database can be asked at all: not offline, and a credential pair to ask with.
 * Exported for its test: this is the gate that keeps an offline `add --json` off the network.
 */
export function accountReachable(account: CloudflareAccountSelection | null): boolean {
  if (pithyOffline()) return false;
  try {
    const vars = cloudflareEnv({ account });
    return Boolean(vars.CLOUDFLARE_ACCOUNT_ID) && Boolean(vars.CLOUDFLARE_API_TOKEN);
  } catch {
    return false;
  }
}

/** What {@link addFollowUp} is told about the add that just ran. */
export interface AddFollowUpOptions extends Reads {
  projectDir: string;
  account: CloudflareAccountSelection | null;
  /** The Worker the add wired, by its `apps/` directory. */
  worker: string;
  capability: string;
  /** {@link readyEnvironments}, read before the add. */
  ready: readonly string[];
  /** Whether the add's `dev` migration run applied anything. */
  brought: boolean;
  /**
   * The project's `seed.productionEnvironments`. An environment it names, like `prod`, gets no provision
   * step: that provision stops at a person's `--confirm` phrase (see {@link addNext}).
   */
  productionEnvironments?: readonly string[];
  /** Whether a deployed database may be asked. Defaults to offline and credentials, as the run resolves them. */
  reachable?: boolean;
  /** Read one environment's ledger. Defaults to {@link readProjectLedger}. */
  readLedger?: (options: MigrationFanOutOptions) => Promise<ProjectLedger>;
}

/** The add's `next`: provisioning for an environment it left unready, then migrations it left pending. */
export async function addFollowUp(options: AddFollowUpOptions): Promise<NextStep[] | undefined> {
  const unprovisioned = options.unprovisioned ?? ((env: string) => unprovisionedBindings(options.projectDir, env));
  const unready: string[] = [];
  const stillReady: string[] = [];
  for (const env of options.ready) {
    let missing: UnprovisionedBinding[];
    try {
      missing = await unprovisioned(env);
    } catch {
      // Unestablished: no step for this environment, neither provision nor migrate. See the module docblock.
      continue;
    }
    if (missing.length > 0) unready.push(env);
    else stillReady.push(env);
  }

  const pending: { env: string; pending: number }[] = [];
  const reachable = options.reachable ?? accountReachable(options.account);
  if (options.brought && reachable) {
    const readLedger = options.readLedger ?? readProjectLedger;
    for (const env of stillReady) {
      try {
        const count = establishedPending(
          await readLedger({ projectDir: options.projectDir, env, account: options.account, worker: options.worker }),
        );
        if (count !== undefined) pending.push({ env, pending: count });
      } catch {
        // Unestablished: no step. See the module docblock.
      }
    }
  }
  return addNext({
    capability: options.capability,
    unprovisioned: unready,
    pending,
    ...(options.productionEnvironments !== undefined ? { productionEnvironments: options.productionEnvironments } : {}),
  });
}
