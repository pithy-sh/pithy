// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SecretScope } from "@pithy-sh/secrets/src/registry";

/**
 * **One sentence about a missing `cf-secrets-store` entry, written once and printed by both reports.**
 *
 * Two commands report the same fact about the same project. `pithy provision` prints it as it writes each
 * Worker's stanza — *this binding has no store entry yet* — and `pithy doctor` prints it afterwards from
 * the files. They are the same finding with the same remedy, and each had its own renderer: a reviewer ran
 * both to completion and found doctor's line corrected and provision's still naming the dead end that four
 * rounds of #517 were about. Two renderers of one sentence is how they came to disagree, so there is one.
 *
 * ## Why the sentence can name a command again
 *
 * For four rounds it could not. `pithy secrets create` accepted a `cf-secrets-store` secret, dispatched a
 * request carrying no backend, and wrote an encrypted D1 row nothing reads — so a line naming it was a
 * line whose remedy left the complaint byte-identical, and the honest report named the account action
 * instead. The write path knows its backend now (`SecretWriteRequest.backend`) and
 * `storeSecretWriter` performs the write against the account's Secrets Store, at the entry name
 * `secretsStoreBindings` will ask for. So the command works, and the report names it.
 *
 * **The `--env` flag is on the command only where the scope permits one**, which is not a nicety:
 * `secretWriteTargets` refuses `--env` for a `global` secret, because a global value is one entry every
 * environment binds and narrowing it is a category error. A remedy carrying the flag anyway is a remedy
 * that fails on the third attempt at this issue's own line. The scope is therefore an input here rather
 * than something a caller renders around.
 */
export interface MissingStoreEntry {
  /** The binding name, which is the registry key and the name the command takes. */
  binding: string;
  /** The declared scope — the whole of what decides whether the command carries `--env`. */
  scope: SecretScope;
  /** The declared environment whose stanza is short of it. Plural across a group. */
  env: string;
  /**
   * **May `pithy secrets provision` create this entry?** — `isProvisionableSecret`'s answer, carried
   * rather than re-derived, and the axis that decides *which* remedy this entry gets.
   *
   * It is on the entry because it is the fact that splits the two sentences, and a report that carried
   * only the scope could not ask for the right one. Provisioning's own report did not carry it and
   * therefore never asked: it called {@link supplyStoreEntriesRemedy} for **every** unbound secret,
   * including the mintable ones and the master key, and told an operator to hand-write a random value
   * `pithy secrets provision` would have generated. Sharing the renderer is not sharing the answer.
   */
  provisionable: boolean;
}

/**
 * **The whole remedy for a group of missing entries — the one function both reports ask** (#517).
 *
 * There are exactly two answers to *what writes a Secrets Store entry*, and which one an entry gets is
 * `isProvisionableSecret`'s decision, carried on {@link MissingStoreEntry.provisionable}:
 *
 * - **`pithy secrets provision`**, for an entry the kit composes a value for — a mintable one, through
 *   the `mint` callback inside `secretsStoreBindings`, and the master key, in `ensureMasterKey` a step
 *   ahead of the binding pass.
 * - **`pithy secrets create`, then `pithy secrets provision`**, for every other entry: the value is one
 *   a human holds, so no command may invent it, and the stanza is a second act.
 *
 * **Both reports call this, and that is the fix rather than the tidying.** `pithy doctor` and
 * `pithy provision` report the same finding about the same project, and #517 gave them one *renderer* —
 * `supplyStoreEntriesRemedy` — while leaving each to decide for itself which of the two answers to
 * render. Provisioning never asked: it rendered the supplied-value sentence for every unbound secret,
 * so a run that could not reach the account told the operator to hand-write the master key. A shared
 * renderer that is handed the wrong question is a shared way of being wrong.
 *
 * A group with both kinds in it — which doctor's own grouping never produces, since it splits on this
 * axis first — reads as the supplied sentence, and is still right: that sentence ends by naming the
 * provision the mintable half needs anyway.
 */
export function storeEntryRemedy(entries: readonly MissingStoreEntry[]): string {
  const supplied = entries.filter((entry) => !entry.provisionable);
  if (supplied.length === 0) return PROVISION_REMEDY;
  return supplyStoreEntriesRemedy(supplied);
}

/**
 * The sentence for values the kit composes — a random string nobody chooses, or the master key
 * `ensureMasterKey` mints. One command creates every one of them and writes the stanza in the same pass,
 * so there is nothing to compose per entry and it is a constant.
 */
const PROVISION_REMEDY = "Run pithy secrets provision — it creates the store entries and writes the stanza.";

/**
 * The command that puts an operator's value into one missing entry.
 *
 * `--env` for an `environment` secret, which has one entry per environment; nothing for a `global` one,
 * which has exactly one entry and refuses to be narrowed.
 */
export function supplyStoreEntryCommand(entry: MissingStoreEntry): string {
  const env = entry.scope === "global" ? "" : ` --env ${entry.env}`;
  return `pithy secrets create ${entry.binding}${env}`;
}

/**
 * The whole remedy for one or more missing entries: supply each value, then write the stanza.
 *
 * **Two commands, because it is two acts.** `pithy secrets create` writes the store entry and nothing
 * else — it has no Worker set and no stanza to write. `pithy secrets provision` binds on `exists`, so an
 * entry written a moment earlier is bound exactly like one it minted itself. Naming only the first leaves
 * the complaint standing; naming only the second is the original defect.
 *
 * The commands are de-duplicated, which is what collapses a `global` secret named by three short stanzas
 * into the one write it actually is. The stanza clause counts the environments rather than the entries,
 * for the same reason: an operator following the line does the account work once and the provision once.
 */
export function supplyStoreEntriesRemedy(entries: readonly MissingStoreEntry[]): string {
  const commands = [...new Set(entries.map(supplyStoreEntryCommand))];
  const values = commands.length === 1 ? "its value" : "their values";
  return `Run ${commands.join(", ")} to supply ${values}, then pithy secrets provision to write ${stanzas(entries)}.`;
}

/**
 * **How many stanzas the following `pithy secrets provision` writes — a fact about the secret, not about
 * who is asking.**
 *
 * A `global` entry is one account-level value that **every** stanza binds, so supplying it once clears
 * all of them however many the caller happened to hand over. That is why the clause reads the scope
 * rather than counting environments: `pithy doctor` groups a global secret across every environment at
 * once and `pithy provision` reports one environment per run, so a count would have the two reports
 * printing different sentences about one entry — which is the disagreement this module exists to end.
 */
function stanzas(entries: readonly MissingStoreEntry[]): string {
  if (entries.some((entry) => entry.scope === "global")) return "every stanza";
  return new Set(entries.map((entry) => entry.env)).size === 1 ? "the stanza" : "every stanza";
}

/**
 * **What `pithy secrets rm` leaves behind on a store-backed secret, said rather than left to be found.**
 *
 * The entry is gone — that is the revocation, and it is the half the command performs. The Worker's
 * `wrangler.jsonc` still carries a `secrets_store_secrets` entry naming it, and `applySecretBindings` is
 * additive: `pithy secrets provision` writes bindings and never removes one, so nothing in the kit will
 * take that line out. Wrangler refuses a config naming an absent entry, so the next deploy of that Worker
 * fails until the binding goes or the entry comes back.
 *
 * Printed with the success line rather than instead of it. The revocation happened; this is the cost of it,
 * and an operator revoking a leaked credential at 2am needs both facts in the order they matter.
 */
export function removedStoreEntryNote(binding: string, environments: readonly string[]): string {
  const stanzas = environments.map((env) => `env.${env}`).join(", ");
  return `The store entry is gone. Each Worker's wrangler.jsonc still binds ${binding} under ${stanzas} — remove that entry, or the next deploy of it fails.`;
}
