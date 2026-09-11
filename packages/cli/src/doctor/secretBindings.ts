// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { isProvisionableSecret, type SecretRegistryEntry, type SecretScope } from "@pithy-sh/secrets/src/registry";
import { projectSecretApplicability, type SecretApplicability } from "../capabilities/secretApplicability";
import { resolveDevSecretsTargets } from "../devSecrets/targets";
import { loadProject, projectEnvironments, requireProjectName } from "../project/config";
import { readOptionalWranglerConfig } from "../project/wrangler";
import { boundSecretNames } from "../provision/secretBindings";
import { storeEntryRemedy } from "../provision/secretEntryRemedy";

/**
 * **Does every deployed environment bind the `cf-secrets-store` secrets its Workers read?** (#238)
 *
 * The safety net for a project that predates the stanza existing at all — which is every project
 * scaffolded before it, including the adopter who found this by reading their own `wrangler.jsonc` and
 * asking where the binding was. `pithy add` deliberately cannot write a `secret` binding (the entry needs
 * a `store_id` and a `secret_name` that do not exist until an account has been reached) and
 * `pithy secrets provision` is the step that comes back and writes it. Nothing said so. A Worker deployed
 * without `SECRETS_ENCRYPTION_KEYS` boots and answers its first request with
 * `Missing required bindings: secret:SECRETS_ENCRYPTION_KEYS`, and until this line the only thing that
 * reported it was that response.
 *
 * **Files only, and it never asks the store.** Whether an *entry* exists is a question for the account,
 * and provisioning is what asks it — a declared secret whose entry has not been written is reported
 * rather than bound, because wrangler refuses a config naming an absent entry and binding one would turn
 * a single missing value into a failed deploy of the whole Worker. So this reports the stanza against the
 * registry and names what reconciles both.
 *
 * ## What the remedy is, and how #517 got it wrong four times
 *
 * Every secret reported here is `cf-secrets-store` — {@link boundSecretNames} filters on exactly that —
 * so the whole question is **what writes a Secrets Store entry**. There are two answers and no third:
 *
 * - **`pithy secrets provision`**, for the entries it can compose a value for: a mintable one, through
 *   the `mint` callback inside `secretsStoreBindings`, and the master key, in `ensureMasterKey` a step
 *   ahead of the binding pass. {@link isProvisionableSecret} is that pair, and it is the predicate here.
 * - **`pithy secrets create`**, for every other entry — an adopter's own `bootstrap` secret, an OAuth
 *   client secret, a payment rail's key. The value is one a human holds, so no command may invent it, and
 *   what the operator needed was a way to hand one over.
 *
 * **The second answer is new, and for four rounds it was a lie.** `pithy secrets create` accepted these
 * and wrote them into the wrong store: `SecretWriteRequest` carried no `backend`, so a write of any shape
 * was dispatched to that environment's manager Workflow and `runWriteSecret` put it in
 * `SystemSecretsStore`, which is D1. The command exited 0, printed a success line, created no store entry,
 * and the complaint that named it came back byte-identical. Each of the first three attempts corrected
 * *which* command was printed — mintability was the wrong predicate, then the master key by name was the
 * right one, then the `--env` flag was refused by the write rule for a `global` secret — without asking
 * whether **any** command worked. The fourth stopped naming one at all and told the operator to create the
 * entry in the account's Secrets Store by hand, which was honest and was a dead end with better manners.
 *
 * The write path knows its backend now (`SecretWriteRequest.backend`) and `capabilities/storeSecretWrites`
 * performs the write against the account's Secrets Store, at the entry name `secretsStoreBindings` will
 * ask for. So the command is named again, and `secretBindings.test.ts` establishes that by **running it**
 * and re-reading the report — never by asserting the sentence.
 *
 * **The sentence itself is not written here.** `provision/secretEntryRemedy.ts` owns it, and
 * `pithy provision`'s report prints the same function's output for the same finding. Two renderers of one
 * sentence is how the two commands came to contradict each other on one project (#517), with doctor
 * corrected and provisioning still naming the dead end.
 *
 * **`dev` never appears, and not by being filtered.** The environments walked are the ones the project
 * declares, and `dev` is not among them. Local dev materializes every `cf-secrets-store` secret into the
 * generated `.dev.vars` (#179), so a stanza there would name store entries a local run never reads.
 *
 * **Which secrets need a binding is not decided here.** {@link boundSecretNames} is the one predicate,
 * shared with the writer in `provision/secretBindings.ts` — so a check that reported a binding the writer
 * would never write, or missed one it would, is not a state these two can reach.
 */

/** One `cf-secrets-store` secret a deployed environment declares and does not bind. */
export interface MissingSecretBinding {
  /** The Worker's name, as `pithy worker list` shows it. */
  worker: string;
  /** The declared environment whose stanza lacks it. */
  env: string;
  /** The binding name — the registry key, which is also the name every read site uses. */
  binding: string;
  /**
   * **May `pithy secrets provision` create this entry?** {@link isProvisionableSecret} answers it, here as
   * everywhere — never re-derived from `devValue`, `bootstrap` or `origin`, so the remedy this report
   * names cannot disagree with what the command does.
   *
   * `false` means **the operator supplies the value**, through `pithy secrets create`. It is not a
   * statement that nothing can create the entry — that was true for as long as the write path was
   * backend-blind, and the remedy line said so; it is not true now.
   */
  provisionable: boolean;
  /**
   * **The entry's declared scope, because it decides how many entries there are.**
   *
   * A `global` secret resolves to one account-level `<project>-global-<secret>` entry that every
   * environment binds, so creating it once clears every short stanza; an `environment` one needs an entry
   * per environment. That is what the report groups on. It is carried rather than folded into a
   * pre-rendered string so `describeSecretBindings` and the namer can be run against each other in a
   * test, which is the only way this stays true.
   */
  scope: SecretScope;
  /**
   * **The Secrets Store entry provisioning will look for**, composed through {@link environmentScope} —
   * the same call `pithy secrets provision` makes.
   *
   * The remedy line names a command rather than this string, because a command that composes the name
   * itself cannot mistype it. The field stays because it is the one thing that says *where the value went*
   * — it is in `--json`, and `secretBindings.test.ts` runs it against the namer, so the address a write
   * lands at and the address provisioning looks for are pinned to each other rather than to a sentence.
   */
  entry: string;
}

/** What this check established. Listed positively, so an inconclusive read says so. */
export type SecretBindingsState =
  /** Every declared environment binds every `cf-secrets-store` secret its Worker reads. */
  | "ok"
  /** A `wrangler.jsonc` would not parse, the declared set would not load, or the project has no name. */
  | "could-not-check"
  /** A deployed environment declares a secret it does not bind. */
  | "unbound";

/** What `doctor` learned about this project's Secrets Store bindings. */
export interface SecretBindingsCheck {
  state: SecretBindingsState;
  missing: MissingSecretBinding[];
}

/** The `wrangler.jsonc` slice this reads: each environment stanza's `secrets_store_secrets` array. */
interface RawWrangler {
  env?: Record<string, { secrets_store_secrets?: { binding?: string }[] } | undefined>;
}

/** What {@link checkSecretBindings} needs. Every seam defaults to the real project's. */
export interface CheckSecretBindingsOptions {
  /** The project root. */
  projectDir: string;
  /** The Workers whose registries declare the secrets. Defaults to every one composing `secrets`. */
  targets?: { name: string; dir: string; registry: Record<string, unknown> }[];
  /**
   * The Workers whose `pithy.config.ts` would not import. Read only when {@link targets} is supplied —
   * both halves of one resolution, so a seam cannot state one and let the other default to a lie.
   */
  unresolvable?: readonly unknown[];
  /** The environments to check. Defaults to the set the root `pithy.config.ts` declares. */
  environments?: readonly string[];
  /**
   * The project name — the leading segment of every store entry this report names.
   *
   * Defaults to {@link requireProjectName}, never `resolveProjectName`: its fallbacks differ between
   * checkouts, so a guessed name would put an operator's hand-created entry at an address provisioning
   * never looks at. A project with no name resolves to `could-not-check` rather than to a guess.
   */
  project?: string;
  /**
   * What this project's configuration cannot reach (#541), **both answers**. Defaults to the real project's,
   * which never throws.
   *
   * **A stanza is not short of a binding for a value nothing can read.** The same rule `checkDevSecrets`
   * applies one block up, and it has to be applied here too or the noise moves rather than going: a
   * `secrets_store_secrets` line for a credential behind a declined binding is a finding an operator can
   * never close. The master key is never taken out, whatever anything declares — it is what lets a
   * deployed Worker open its store at all.
   *
   * **And the answer this loop wants is the per-Worker one**, because the loop is per Worker and per
   * environment while `SecretApplicability.project` is one fact about the whole project. Where Worker A
   * declines `SUPPORT_BUCKET` and Worker B does not, `support-r2-credentials` is reachable *somewhere*, so
   * the project answer leaves it unmarked — and this check then printed a missing binding for **A's**
   * stanza, a few lines under A's own `SUPPORT_BUCKET (r2) declined in pithy.config.ts`. A finding A can
   * never close is the exact self-contradiction #541 removes, and the mixed-Worker case is where it
   * survived a round. A Worker the map does not name falls back to the project answer, which marks the
   * fewest names — an unknown composition must not take work out of the report.
   */
  inapplicable?: SecretApplicability;
}

/**
 * Compare each Worker's declared secrets against each declared environment's stanza. Never throws — a
 * diagnostic has to work in the broken environment it exists to diagnose.
 *
 * `null` means no Worker composes `secrets`, so there is no registry and no question — the same
 * discipline `checkDevSecrets` holds.
 *
 * **The unresolvable half is carried, not dropped (#199).** "This stanza binds no `X`" is a negative
 * claim about a registry, and a Worker whose `pithy.config.ts` would not import is exactly the one that
 * might have declared `X` — so one unreadable config makes the whole check `could-not-check` rather than
 * a confident `ok`. `pithy doctor`'s `Dev secrets:` block is what names the Worker and the reason; this
 * one only has to stop claiming something it could not establish.
 */
export async function checkSecretBindings(options: CheckSecretBindingsOptions): Promise<SecretBindingsCheck | null> {
  const resolved =
    options.targets === undefined
      ? await resolveDevSecretsTargets(options.projectDir).catch(() => ({ targets: [], unresolvable: [] }))
      : { targets: options.targets, unresolvable: options.unresolvable ?? [] };
  const targets = resolved.targets;
  if (targets.length === 0 && resolved.unresolvable.length === 0) return null;
  if (resolved.unresolvable.length > 0) return { state: "could-not-check", missing: [] };

  let environments: readonly string[];
  if (options.environments) {
    environments = options.environments;
  } else {
    try {
      environments = await projectEnvironments(options.projectDir);
    } catch {
      return { state: "could-not-check", missing: [] };
    }
  }

  // The entry names, composed once per environment through provisioning's own scope. A project with no
  // usable `name`, or an environment the namer refuses, cannot be told which entry to create — and a
  // remedy naming the wrong entry is worse than none, because the operator creates something and the
  // complaint stays. `Project name:` is the block that says why.
  let entryNames: Map<string, (binding: string, scope: SecretScope) => string>;
  try {
    const project = options.project ?? requireProjectName(await loadProject(options.projectDir));
    entryNames = new Map(
      environments.map((env) => {
        const scope = environmentScope(project, env);
        return [env, (binding: string, secretScope: SecretScope) => scope.secretEntry(binding, secretScope)] as const;
      }),
    );
  } catch {
    return { state: "could-not-check", missing: [] };
  }

  const applicability = options.inapplicable ?? (await projectSecretApplicability(options.projectDir));
  const missing: MissingSecretBinding[] = [];
  let unreadable = false;
  for (const target of targets) {
    const config = (await readOptionalWranglerConfig(target.dir).catch(() => undefined)) as
      | RawWrangler
      | null
      | undefined;
    if (config === undefined) {
      // A `wrangler.jsonc` that will not parse states nothing about what it binds, and "this stanza is
      // missing a binding" is a negative claim. The `Project health` block already says the file is
      // broken, and saying it again in other words is how a report starts contradicting itself.
      unreadable = true;
      continue;
    }
    // No file at all is not a Worker with a broken config — a process in the dev set with no
    // `wrangler.jsonc` declares no environments and binds nothing.
    if (config === null) continue;
    const declared = boundSecretNames(target.registry as Parameters<typeof boundSecretNames>[0]).sort();
    // This Worker's own answer. Its stanza is its own, so what another Worker can still reach says nothing
    // about whether this one is short of a binding.
    const inapplicable = applicability.byWorker.get(target.name) ?? applicability.project;
    for (const env of environments) {
      const bound = new Set(
        (config.env?.[env]?.secrets_store_secrets ?? []).map((entry) => entry.binding).filter(Boolean),
      );
      const nameFor = entryNames.get(env);
      if (!nameFor) continue;
      for (const binding of declared) {
        if (bound.has(binding)) continue;
        const entry = (target.registry as Record<string, SecretRegistryEntry>)[binding] as SecretRegistryEntry;
        // Nothing reads it, so nothing is short of it. `isProvisionableSecret` is the same guard the
        // `Dev secrets:` block uses, and here it is what keeps the master key's stanza reported.
        if (inapplicable.has(binding) && !isProvisionableSecret(binding, entry)) continue;
        missing.push({
          worker: target.name,
          env,
          binding,
          provisionable: isProvisionableSecret(binding, entry),
          scope: entry.scope,
          entry: nameFor(binding, entry.scope),
        });
      }
    }
  }

  if (missing.length > 0) return { state: "unbound", missing };
  return { state: unreadable ? "could-not-check" : "ok", missing: [] };
}

/**
 * The lines the report prints, or none at all when there is nothing to say.
 *
 * One line per Worker-and-environment rather than per binding: a project composing four
 * `cf-secrets-store` secrets would otherwise print eight sentences that differ only in a name. An
 * adopter counts lines.
 *
 * **Except where the remedy differs, which is the whole of #517.** Grouping is what makes a line
 * countable, and grouping on `worker` and `env` alone put entries with two different answers into one
 * sentence offering one. There are exactly two answers — `pithy secrets provision` creates a store entry
 * when {@link isProvisionableSecret}, and for everything else the operator supplies the value with
 * `pithy secrets create` — so a Worker-and-environment splits at most in two: provisionable line first,
 * the rest under it, adjacent, because they are one Worker's two answers rather than two reports. A group
 * with one answer is still one sentence.
 *
 * **The remedy is `storeEntryRemedy`'s and not this module's**, because `pithy provision` prints
 * the same finding as it writes each stanza and the two disagreed for a whole round of this issue. One
 * function, two callers, and a wording change lands in both or in neither.
 *
 * **A line may name a command only if running that command clears the line**, which is the standard the
 * first four rounds each failed a different way. `secretBindings.test.ts` holds it by running the remedy
 * through the real write path — `runSecretWrite`, the real routing, a recording store and a recording D1
 * — and re-reading the report, so a command that writes to the wrong store fails here rather than in an
 * adopter's terminal.
 *
 * **The unfillable line splits on scope, and the reason is not the one the third attempt used.** That one
 * split on `--env` because the write rule refuses the flag for a `global` secret and the line carried it
 * anyway. The flag is right on the command now — `supplyStoreEntryCommand` puts it there for an
 * `environment` secret and leaves it off a `global` one — and the split is about *how many entries there
 * are*: a `global` secret resolves to **one** account-level entry, `<project>-global-…`, that every
 * environment binds, so it is supplied once however many stanzas are short of it. Three declared
 * environments used to print three byte-identical remedies, and an operator following them in order did
 * the same thing twice for nothing. Every short stanza is still named in the head, because provisioning
 * writes all of them; it is the remedy that is stated once.
 */
export function describeSecretBindings(check: SecretBindingsCheck): string[] {
  const byWorker = new Map<string, MissingSecretBinding[]>();
  for (const entry of check.missing) byWorker.set(entry.worker, [...(byWorker.get(entry.worker) ?? []), entry]);
  const lines: string[] = [];
  for (const entries of byWorker.values()) {
    const perEnv = new Map<string, MissingSecretBinding[]>();
    for (const entry of entries) {
      if (isGlobalUnfillable(entry)) continue;
      perEnv.set(entry.env, [...(perEnv.get(entry.env) ?? []), entry]);
    }
    for (const group of perEnv.values()) {
      const provisionable = group.filter((entry) => entry.provisionable);
      // One answer per line stays the rule, and a group with one answer is still one sentence.
      const unfillable = group.filter((entry) => !entry.provisionable);
      if (provisionable.length > 0) lines.push(provisionableLine(provisionable));
      if (unfillable.length > 0) lines.push(unfillableLine(unfillable));
    }
    // Last, and once for the Worker: one account-level entry is one sentence.
    const everywhere = entries.filter(isGlobalUnfillable);
    if (everywhere.length > 0) lines.push(globalUnfillableLine(everywhere));
  }
  return lines;
}

/**
 * A value the operator supplies, held once for the whole project — the one line that is not per
 * environment, because the entry it names is a single account-level one.
 */
function isGlobalUnfillable(entry: MissingSecretBinding): boolean {
  return !entry.provisionable && entry.scope === "global";
}

/** The distinct members of `values`, in first-seen order. */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** What a Worker-and-environment's missing secrets share: who is short of what. The remedy follows it. */
function head(entries: MissingSecretBinding[]): string {
  const first = entries[0] as MissingSecretBinding;
  return `${first.worker} env.${first.env} binds no ${entries.map((entry) => entry.binding).join(", ")}.`;
}

/**
 * The same sentence for a secret whose remedy is not per environment: every stanza that is short of it,
 * named together, because provisioning writes all of them from the one entry.
 */
function globalHead(entries: MissingSecretBinding[]): string {
  const first = entries[0] as MissingSecretBinding;
  const environments = unique(entries.map((entry) => entry.env));
  const verb = environments.length === 1 ? "binds" : "bind";
  const stanzas = environments.map((env) => `env.${env}`).join(", ");
  return `${first.worker} ${stanzas} ${verb} no ${unique(entries.map((entry) => entry.binding)).join(", ")}.`;
}

/**
 * Values the kit composes — a random string nobody chooses, or the master key `ensureMasterKey` mints.
 * One command creates every one of them and writes the stanza in the same pass.
 */
function provisionableLine(entries: MissingSecretBinding[]): string {
  return `${head(entries)} ${storeEntryRemedy(entries)}`;
}

/**
 * **Entries whose value only the operator holds** — an OAuth client secret, a payment rail's key, an
 * adopter's own bootstrap value. The line names each one's `pithy secrets create`, then the provision
 * that writes the stanza.
 *
 * Both halves are required and neither is optional: `create` writes the store entry and has no stanza to
 * write; `provision` binds on `exists`, so an entry written a moment ago is bound exactly like one it
 * minted itself.
 */
function unfillableLine(entries: MissingSecretBinding[]): string {
  return `${head(entries)} ${storeEntryRemedy(entries)}`;
}

/**
 * The same, for a value held **once for every environment**: `global` resolves to a single
 * `<project>-global-<secret>` entry that every stanza binds, so it is supplied once however many stanzas
 * are short of it — and its command carries no `--env`, because the write rule refuses one.
 *
 * **One line for every environment short of it.** Three declared environments used to mean three
 * byte-identical remedies, and running the same command three times is the same dead end as running one
 * that cannot work: the second and third attempts achieve nothing and the operator cannot tell that from
 * a remedy that failed.
 */
function globalUnfillableLine(entries: MissingSecretBinding[]): string {
  return `${globalHead(entries)} ${storeEntryRemedy(entries)}`;
}
