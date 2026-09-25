// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **Which Secrets Store entries this project accounts for — and, therefore, which it does not.**
 *
 * A Cloudflare account has one Secrets Store, flat and account-wide, so the entry name is the only
 * partition there is. That is why every name provisioning writes is composed through the naming facade
 * as `<project>-<env>-<thing>`. It is also why a write that composed its name somewhere else is
 * *invisible*: the value lands under a name nothing ever asks for, the command that wrote it exits 0,
 * and the binding it was meant to fill keeps resolving to whatever was there before. In the sibling
 * outage a bare `SECRETS_CONFIG` sat beside the real `GLOBAL_SECRETS_CONFIG` holding the key that should
 * have gone into it. Ours would be a bare `SECRETS_ENCRYPTION_KEYS` beside
 * `<project>-<env>-secrets-encryption-keys`.
 *
 * So this composes the set of names the project *does* account for — through the same functions
 * provisioning composes them with, never by hand — and classifies everything else.
 *
 * ## The dangerous mistake here is a false orphan, not a missed one
 *
 * An operator reading a list of entries "nothing accounts for" deletes what is in it, and one of the
 * names in reach is the master key: deleting it makes every row in that environment's D1 permanently
 * undecryptable. A missed orphan costs another run of `pithy secrets verify`. So the classification is
 * arranged around never presenting a live entry as debris:
 *
 * - **A name outside `<project>-` is counted and never named.** It belongs to a sibling project in the
 *   same account, and this command has no standing to report it at all.
 * - **A second segment this checkout does not declare is `unknown-scope`, not an orphan.** Environments
 *   come from the root `pithy.config.ts`, which differs between branches and checkouts — running
 *   `verify` from a branch that predates `staging` must not call every staging entry dead.
 * - **Key material is never an orphan.** An entry named for a master key gets its own class and its own
 *   sentence, whatever else is true about it.
 * - **An incomplete answer withholds the orphan verdict entirely.** A Worker whose registry will not
 *   load declares secrets this census cannot see, and every one of them would read as an orphan. That is
 *   {@link StoreEntryCensusInput.registryComplete}, and it is a *withheld* answer rather than a guess.
 *
 * ## What is never withheld
 *
 * The `unscoped` class. It is a positive membership test against names this project's registry supplies
 * — it does not depend on the accounted set being complete — and it is the one check here that detects
 * the actual #647 fingerprint. A detector that went quiet exactly when a project's provisioning is
 * messiest would detect nothing.
 */

import { GLOBAL_SCOPE, isFeatureMarker } from "@pithy-sh/core/src/naming/environment";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { kebab } from "@pithy-sh/core/src/naming/resource";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { secretBindingName } from "@pithy-sh/secrets/src/env/bindingName";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/masterKeyBinding";
import { managerCfApiTokenSecretName, masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { boundSecretNames, secretStoreEntryName } from "../provision/secretBindings";

/**
 * The tail every master-key entry carries, whatever project and environment lead it.
 *
 * Declared here and pinned against {@link masterKeySecretName} by this module's test, rather than
 * re-derived: the classification has to recognize a master key in an environment this checkout does not
 * declare, which is precisely the case a composed name cannot produce.
 */
export const MASTER_KEY_ENTRY_SUFFIX = "-secrets-encryption-keys";

/** What one listed store entry is, as far as this project can tell. */
export type StoreEntryClass =
  /** A name this project composes: the entry is where something expects it. */
  | "accounted"
  /** A bare name this project's registry uses — the fingerprint of a write that skipped the facade. */
  | "unscoped"
  /** Under `<project>-`, in a declared scope, and nothing composes it. */
  | "orphan"
  /** Under `<project>-` and named like a master key. Never presented as debris. */
  | "key-material"
  /** Under `<project>-` but in a scope this checkout does not declare. Not evidence of anything. */
  | "unknown-scope"
  /** A feature's ephemeral entry — `<project>-f<issue>-…`. Owned by a branch, torn down with it. */
  | "feature"
  /** Not this project's. Counted, never named. */
  | "foreign";

/** What the census reads. Everything here is a fact about *this* project, never about the store. */
export interface StoreEntryCensusInput {
  /** The root `pithy.config.ts` name, through `requireProjectName` — the leading segment of every name. */
  project: string;
  /** Every environment the root config declares. The second segment of a scoped name, plus `global`. */
  environments: readonly ManagedEnvironment[];
  /** The project's merged secret registry. */
  registry: SecretRegistry;
  /**
   * Whether that registry is every Worker's.
   *
   * `projectSecrets` merges each Worker's registry and skips a Worker whose config will not load. That
   * is right for a listing and fatal for this: every secret the skipped Worker declared would be an
   * entry nothing accounts for. False withholds the orphan verdict.
   */
  registryComplete: boolean;
  /**
   * Every CF Secrets Store entry the project's token profiles resolve to, or `null` when they could not
   * be resolved at all — which withholds the orphan verdict for the same reason.
   */
  tokenEntries: readonly string[] | null;
}

/** The composed answer: what this project accounts for, and whether the answer is complete. */
export interface StoreEntryCensus {
  /** Every store entry name this project composes. */
  accounted: ReadonlySet<string>;
  /** Every *bare* name this project's registry supplies — a name with no project segment at all. */
  ours: ReadonlySet<string>;
  /** The leading segment every scoped name of this project carries, trailing dash included. */
  prefix: string;
  /** The environments a scoped name may name, `global` included. */
  scopes: ReadonlySet<string>;
  /** Why the orphan verdict cannot be computed, in the operator's words, or null when it can. */
  unresolved: string | null;
}

/**
 * Compose the names this project accounts for.
 *
 * Every one of them goes through the function provisioning itself calls —
 * {@link secretStoreEntryName} over an {@link environmentScope}, {@link masterKeySecretName},
 * {@link managerCfApiTokenSecretName} — rather than through a template written here. A second namer
 * would drift, and the first symptom of drift is a live entry reported as debris.
 */
export function storeEntryCensus(input: StoreEntryCensusInput): StoreEntryCensus {
  const accounted = new Set<string>();
  for (const secret of boundSecretNames(input.registry)) {
    const entry = input.registry[secret];
    if (!entry) continue;
    if (entry.scope === GLOBAL_SCOPE) {
      // One account-level entry, the literal `global` in the environment slot. Composing it per
      // environment would leave the real one unaccounted for and invent declared ones that never exist.
      accounted.add(resourceNames(input.project).global.secretEntry(secret));
      continue;
    }
    for (const env of input.environments) {
      accounted.add(secretStoreEntryName(environmentScope(input.project, env), secret, entry));
    }
  }
  for (const env of input.environments) accounted.add(masterKeySecretName(input.project, env));
  accounted.add(managerCfApiTokenSecretName(input.project));
  for (const entry of input.tokenEntries ?? []) accounted.add(entry);

  // Every bare name this project would read a value under: the registry's own keys, the bindings they
  // derive, and the master-key binding. Each is a name something could have written unscoped.
  const ours = new Set<string>([MASTER_KEY_BINDING]);
  for (const secret of Object.keys(input.registry)) {
    ours.add(secret);
    ours.add(secretBindingName(secret));
  }

  return {
    accounted,
    ours,
    prefix: `${kebab(input.project)}-`,
    scopes: new Set<string>([...input.environments, GLOBAL_SCOPE]),
    unresolved: censusGap(input),
  };
}

/** The one sentence saying why the orphan verdict is withheld, or null. */
function censusGap(input: StoreEntryCensusInput): string | null {
  if (!input.registryComplete) {
    return "A Worker's secret registry could not be read, so some declared secrets are not in this count.";
  }
  if (input.tokenEntries === null) {
    return "The project's token profiles could not be resolved, so the entries they write are not in this count.";
  }
  return null;
}

/**
 * Classify one listed entry.
 *
 * Order is the argument. `accounted` first, because a name this project composes is never anything else.
 * `unscoped` second, because a bare name is not under the prefix and would otherwise read as somebody
 * else's. `feature` before the scope check, because `f647` is a legal second segment that no environment
 * list holds. `key-material` before `orphan`, because a master key is never debris whatever scope it
 * carries.
 */
export function classifyStoreEntry(name: string, census: StoreEntryCensus): StoreEntryClass {
  if (census.accounted.has(name)) return "accounted";
  if (census.ours.has(name)) return "unscoped";
  if (!name.startsWith(census.prefix)) return "foreign";
  const scope = name.slice(census.prefix.length).split("-")[0] ?? "";
  if (isFeatureMarker(scope)) return "feature";
  if (name.endsWith(MASTER_KEY_ENTRY_SUFFIX)) return "key-material";
  if (!census.scopes.has(scope)) return "unknown-scope";
  return "orphan";
}

/**
 * Every Secrets Store entry this project's token profiles write to — or `null` when they cannot be
 * resolved, which withholds the orphan verdict rather than turning each of them into an orphan.
 *
 * **Both imports are dynamic, and that is a gate rather than a preference.**
 * `@pithy-sh/cloudflare/src/tokens/profiles` value-imports `accountResource` out of the account-tokens
 * manager, which pulls the ~300 ms Cloudflare SDK; `tokens/engine.ts` imports the same module directly.
 * A static edge from here would put both on the import graph of `pithy secrets --help`, `create`,
 * `update`, `rotate`, `rm`, `ls` and `edit` — the regression #482 removed, and
 * `ci/lazyHeavyImports.test.ts` fails on it.
 *
 * A Worker set that cannot be read is `null` for the reason `pithy token` refuses on it (#455):
 * `resolveTokenProfiles([])` answers with `ci-system` alone and silently drops every capability's
 * profiles, so an emptied set is not a smaller answer — it is a wrong one, and here it would name live
 * entries as debris.
 */
export async function projectTokenStoreEntries(options: {
  project: string;
  environments: readonly ManagedEnvironment[];
  projectDir: string;
}): Promise<string[] | null> {
  try {
    const [{ resolveTokenProfiles }, { tokenStoreEntryName }, workerScope] = await Promise.all([
      import("@pithy-sh/cloudflare/src/tokens/profiles"),
      import("../tokens/engine"),
      import("../project/workerScope"),
    ]);
    const workers = await workerScope.resolveWorkerSet({ projectDir: options.projectDir });
    if (workerScope.isUnknown(workers)) return null;
    const entries: string[] = [];
    for (const profile of Object.values(resolveTokenProfiles(workerScope.projectCapabilities(workers)))) {
      // A `global` profile writes exactly one entry with the literal `global` in the environment slot.
      // `tokenStoreEntryName` ignores the environment it is handed in that case; passing the scope keeps
      // the call honest about which name is being asked for.
      if (profile.secretScope === GLOBAL_SCOPE) {
        entries.push(tokenStoreEntryName(options.project, GLOBAL_SCOPE, profile));
        continue;
      }
      for (const env of options.environments) entries.push(tokenStoreEntryName(options.project, env, profile));
    }
    return entries;
  } catch {
    // A withheld answer, not an empty one. Whatever went wrong — an unreadable config, a profile that
    // will not resolve — the honest report is that these names are not in the count.
    return null;
  }
}
