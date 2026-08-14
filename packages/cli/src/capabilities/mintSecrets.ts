// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import type { SecretDispatcher, SecretProbe } from "@pithy-sh/secrets/src/cli/dispatch";
import { partialWriteReport } from "@pithy-sh/secrets/src/cli/partialWrite";
import { secretWriteTargets } from "@pithy-sh/secrets/src/cli/writeTargets";
import { initialDevSecret } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { devSecretPayload } from "@pithy-sh/secrets/src/dev/seedDevSecrets";
import { mintSecretValue } from "@pithy-sh/secrets/src/mintValue";
import { isMintableSecret, type SecretRegistry, type SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { CliAuditEmit } from "../audit/cliAudit";
import type { MintStoreSecret } from "../provision/secretBindings";

/**
 * **Creating the secrets nobody chooses.**
 *
 * `pithy provision --env staging --yes` used to create three databases and then print three commands for
 * a human to run, each of which generates random bytes. `--yes` had been passed. The registry already
 * said which secrets those were — `devValue`, declared by the capability that owns each one — and only
 * local dev ever read it (#321).
 *
 * **Two creators, because there are two stores and each owns the absence check the other cannot make.**
 * A minted value is created once and never regenerated — a second session secret signs everyone out, a
 * second link key stops verifying links already in inboxes, a second key-encryption key orphans
 * everything sealed under the first — so "only if absent" is the property both have to hold.
 *
 * - {@link storeSecretMinter}, for `cf-secrets-store`. The CLI can read the account's store, so
 *   `secretsStoreBindings` asks whether the entry is there and this writes it when it is not.
 * - {@link mintDeclaredSecrets}, for `d1`. The CLI cannot read one: the value is sealed under a master
 *   key that never leaves the manager Worker. So it asks each manager (`probe`) and then writes with
 *   `create`, which refuses a name already there. See `management/writeSecret.ts`.
 *
 * #321 shipped only the first, and the kit declares no `cf-secrets-store` secret that a random string
 * could satisfy, so nothing the kit ships could reach it. `provision/mintCoverage.test.ts` is the gate
 * that now says so, against the registries the kit actually ships rather than one a test made up.
 *
 * **The value exists in one local and nowhere else.** It is never returned, never logged, never put in an
 * audit event, and never printed by the command that called this. What a run reports is that the secret
 * was created and which entry it went to.
 */

/** The slice of the Secrets Store minting needs: write an entry. Never reads, never deletes. */
export interface MintDestination {
  /** Write a value under `name`. Overwrites in place — which is why the caller checks absence first. */
  put(name: string, value: string): Promise<void>;
}

/** Build the live minter for one environment's Secrets Store. */
export function storeSecretMinter(options: {
  /** Where the value goes. */
  store: MintDestination;
  /** The environment being provisioned, for the audit trail. Never part of the entry name — the scope owns that. */
  environment: string;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}): MintStoreSecret {
  const audit = options.audit ?? (async () => {});
  return async ({ binding, secretName, entry }) => {
    // Defence in depth. `secretsStoreBindings` asks `isMintableSecret` before calling, so arriving here
    // with a supplied secret is a bug — and one that would write a random string where an OAuth client
    // secret was meant, leaving a gap that looks filled in. It refuses instead of inventing.
    if (!isMintableSecret(entry) || entry.devValue === undefined) {
      throw new InternalError({
        message: `Secret '${binding}' declares no value of its own, so nothing may mint one.`,
        detail: `mint called for ${secretName}, whose registry entry has no devValue.`,
      });
    }
    // Through `devSecretPayload`, never restating what it says. A Secrets Store entry is read by the
    // Worker straight off its binding, so what is written here is what the Worker gets — and what the
    // dev secrets file states for the same secret, byte for byte. `initialDevSecret` composes the entry
    // the file would hold; reading it back is the one materialisation every destination shares (#323).
    // This wrote an envelope unconditionally, which is the defect that wave was about, at a new producer.
    const stated = initialDevSecret(entry, mintSecretValue(entry.devValue));
    await options.store.put(secretName, devSecretPayload(entry, secretName, stated).text);
    // The name, the entry, the environment. Never the value, and nothing derived from it.
    await audit({
      environment: options.environment,
      action: "secrets/set",
      outcome: "success",
      severity: "warning",
      resourceType: "secret",
      resourceId: secretName,
      metadata: { name: secretName, binding, kind: "generated" },
    });
  };
}

/** One secret this run accounted for: where it belongs, and where this run actually created it. */
export interface MintedSecret {
  /** The secret's registry name. Never its value. */
  name: string;
  /** The environments the secret belongs in — one for an `environment` secret, all for a `global` one. */
  environments: ManagedEnvironment[];
  /**
   * The environments this run **created** it in, which is empty on every run after the first.
   *
   * Separate from {@link environments} because the two used to be one field saying only where a request
   * was sent, and "sent" is not "made". A report that cannot tell a creation from a no-op is a report an
   * operator cannot use to answer *did this run generate a production signing key*.
   */
  created: ManagedEnvironment[];
}

/**
 * What a run reports about the secrets it accounted for, one line each — names and environments, never
 * a value.
 *
 * **One renderer for the run that finishes and the run that fails part-way.** Two would let a partial
 * report be phrased as a plan: a secret whose fan-out died before prod has an empty `created` under the
 * old shape, and the line for an empty `created` reads *already in staging, prod* — a sentence about an
 * environment that never received it.
 */
export function mintReportLines(minted: readonly MintedSecret[]): string[] {
  return minted.map((secret) =>
    secret.created.length > 0
      ? `${secret.name} created in ${secret.created.join(", ")}.`
      : `${secret.name} already in ${secret.environments.join(", ")}.`,
  );
}

/**
 * **Where the report rides out of a run that failed (#324).**
 *
 * A throw part-way through a fan-out leaves environments holding a brand-new signing key, and the
 * return value that would have said so never happens. The report used to be assembled after the
 * delivery loop, so the throw took it with it: the operator was told nothing was created, arrived at
 * the next run's refusal, and had no record of what the previous run had done.
 *
 * The mechanism is `partialWriteReport`'s, not this module's. `dispatchSecretWrite` needed the same
 * thing for the same reason (#325), and a second copy of *how a report survives a throw* is the shape
 * this repository has produced four times over. What stays here is the payload: what a mint run
 * created, which is not what a dispatch run reports.
 */
const mintReport = partialWriteReport<MintedSecret[]>("pithy.cli.mintReport", (value): value is MintedSecret[] =>
  Array.isArray(value),
);

/**
 * What a failed {@link mintDeclaredSecrets} run created before it failed, in registry order. Empty when
 * the thrown thing carries no report — which is the honest answer for a throw from anywhere else.
 */
export function mintedBeforeFailure(error: unknown): MintedSecret[] {
  return mintReport.read(error) ?? [];
}

/**
 * The declared registry names this creates: every `d1` secret whose value is arbitrary. Exported so a
 * command that **cannot** create them — `pithy provision`, which runs before the managers necessarily
 * exist — can name them rather than finish quietly leaving them absent.
 */
export function managerMintedSecrets(registry: SecretRegistry): string[] {
  return Object.keys(registry)
    .sort()
    .filter((name) => isManagerMinted(registry[name]));
}

/** A registry entry this creates: `d1`, mintable, and carrying the declaration a value is minted from. */
type ManagerMintedEntry = SecretRegistryEntry & { devValue: NonNullable<SecretRegistryEntry["devValue"]> };

/** `d1`, mintable, not a keyspace. The one predicate, so the creator and the reporter cannot disagree. */
function isManagerMinted(entry: SecretRegistryEntry | undefined): entry is ManagerMintedEntry {
  if (!entry) return false;
  if (entry.backend !== "d1") return false;
  // `cf-secrets-store` is the other creator's, and `isMintableSecret` refuses both a supplied secret and
  // a keyspace. The `devValue` re-check is for the type; the predicate is what decides.
  return isMintableSecret(entry) && entry.devValue !== undefined;
}

/**
 * Create every `d1` secret the registry declares mintable, across the environments the project declares.
 *
 * **Ask every environment first, then decide once.** This is the whole shape, and it replaced a
 * per-environment `ensure` that could not hold the property it was written for. `ensure` wrote when a
 * name was absent and skipped silently when it was present — a per-environment answer to a
 * cross-environment question. Concretely, and this happened: a run wrote staging and lost prod; the
 * re-run minted a **second** value, found staging present, skipped it, and wrote the second value into
 * prod. Two environments, two values, no error, and every link signed by one refused by the other.
 *
 * So the decision moves in front of the writes, where the whole picture exists:
 *
 * - **Every target already has it** — nothing is dispatched and, just as importantly, **nothing is
 *   minted**. No key material is generated on a re-run at all.
 * - **Every target lacks it** — for a `global` secret, one value is minted and written to each; for an
 *   `environment` secret, a fresh value per environment. A staging session key that also signed prod
 *   sessions would make the environment boundary decorative.
 * - **Some have it and some do not, and the secret is `global`** — the run **fails**, naming the secret
 *   and both sides of the split. This is the state that used to be completed silently. Repairing it is a
 *   decision about a live signing key — copy the existing value across, or retire it everywhere and
 *   start again — and the consequences differ by secret, so a tool does not get to pick.
 *
 * **The writes use `create`, which raises rather than skipping.** Probing narrows the race but cannot
 * close it: two runs can both see a global secret absent. `create` closes it — the loser is refused at
 * its first write instead of fanning its own value into the environments the winner has not reached.
 * That is also why `ensure` is gone from `management/writeSecret.ts` entirely: a mode whose whole
 * behaviour is to be quiet has no safe caller here.
 *
 * `resolveWriteTargets` is the same routing `dispatchSecretWrite` applies, so where a value lands cannot
 * disagree with where `pithy secrets create` puts the same secret.
 *
 * Returns what it accounted for, in registry order. Never a value.
 */
export async function mintDeclaredSecrets(options: {
  /** The registry to read — every declared secret, of every backend. This picks its own out. */
  registry: SecretRegistry;
  /** Where a write goes: the target environment's manager write-Workflow. */
  dispatcher: SecretDispatcher;
  /** Whether a manager already holds a name. Asked of every target before anything is minted. */
  probe: SecretProbe;
  /** Every environment the project declares. Both the targets and the fan-out set. */
  environments: DeclaredEnvironments | readonly string[];
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}): Promise<MintedSecret[]> {
  const audit = options.audit ?? (async () => {});
  const declared = [...options.environments] as ManagedEnvironment[];
  const minted: MintedSecret[] = [];
  try {
    for (const name of Object.keys(options.registry).sort()) {
      const entry = options.registry[name];
      if (!isManagerMinted(entry)) continue;
      // Through the one rule (`secretWriteTargets`), the same one `dispatchSecretWrite` asks, so where a
      // minted value lands cannot disagree with where `pithy secrets create` puts the same secret.
      //
      // A `global` secret names **no** environment: it is not narrowed, and the rule refuses a narrowed
      // global write. This used to pass `declared[0]` as a placeholder the routing table ignored — a
      // value invented to satisfy a signature, which is precisely the difference the rule now turns on.
      // An `environment` secret resolves each declared environment as its own target.
      const facts = { name, backend: entry.backend, scope: entry.scope, mode: "create" as const, declared };
      const targets =
        entry.scope === "global"
          ? secretWriteTargets({ ...facts, requested: undefined })
          : declared.flatMap((env) => secretWriteTargets({ ...facts, requested: env }));

      const absent: ManagedEnvironment[] = [];
      const present: ManagedEnvironment[] = [];
      for (const env of targets) {
        ((await options.probe.probe({ env, name })) ? present : absent).push(env);
      }

      if (absent.length === 0) {
        minted.push({ name, environments: targets, created: [] });
        continue;
      }
      if (entry.scope === "global" && present.length > 0) {
        // The value itself is what disagrees, and no part of the CLI may look at it — so the report is
        // the split, by environment name, and the repair is the operator's.
        //
        // **One remedy, because there is only one.** This used to offer *"give the others the same
        // value with `pithy secrets create`"* first. For a secret this function creates that names an
        // act with no way to perform it: the value is 256 bits of `crypto.getRandomValues` sealed under
        // a master key that never leaves the manager Worker, so nobody — operator, CLI, or another
        // Worker — can read it back out of the environment that holds it. An operator who reached for
        // the first branch found no first step. The branch that works destroys a live signing key, so
        // it is stated plainly with its cost rather than offered second as the safer-looking option.
        throw new ConflictError({
          message: `Secret '${name}' is global, and only some environments have it.`,
          action: `Its value cannot be copied to ${absent.join(", ")} — it is sealed under a master key no command can read. Remove it everywhere with pithy secrets rm ${name}, then run this again. That destroys a live key: everything signed by the value ${present.join(", ")} holds stops verifying.`,
          detail: `global secret '${name}': present in ${present.join(", ")}, absent in ${absent.join(", ")}`,
        });
      }

      // Minted here and nowhere earlier. A value generated before absence is known is 256 bits of key
      // material created for a secret that already exists, handed to a Workflow, and discarded unread.
      // One value for a `global` secret, a fresh one per environment otherwise — that is what the two
      // scopes mean, and it is the whole reason this owns the environment loop rather than a caller.
      const shared = entry.scope === "global" ? mintSecretValue(entry.devValue) : undefined;
      // Grown one environment at a time, and put in the report by the first write that lands. Assembled
      // after the loop instead, a throw inside took the whole record with it — the environments already
      // written held a new secret and the run reported nothing created (#324). Pushed *before* the first
      // write it would be a plan: an entry with an empty `created` reads *already in staging, prod*,
      // which is the #321 shape exactly.
      const created: ManagedEnvironment[] = [];
      for (const env of absent) {
        // The dispatcher directly, because `targets` above already came from `resolveWriteTargets` — the
        // routing decision is made once, and this loop only delivers to the environments it found empty.
        await options.dispatcher.dispatch({
          env,
          mode: "create",
          name,
          value: shared ?? mintSecretValue(entry.devValue),
          valueType: entry.valueType,
          rotatable: entry.rotatable,
        });
        if (created.length === 0) minted.push({ name, environments: targets, created });
        created.push(env);
        await audit({
          environment: env,
          action: "secrets/set",
          outcome: "success",
          severity: "warning",
          resourceType: "secret",
          resourceId: name,
          metadata: { name, environments: [env], kind: "generated" },
        });
      }
    }
  } catch (error) {
    // Carried, never replaced: the refusal or the fault is what the operator has to read, and what this
    // run wrote is what makes the remedy in it safe to perform.
    throw mintReport.carry(error, minted);
  }
  return minted;
}
