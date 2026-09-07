// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resolveDevSecretsTargets } from "../devSecrets/targets";
import { projectEnvironments } from "../project/config";
import { readOptionalWranglerConfig } from "../project/wrangler";
import { boundSecretNames } from "../provision/secretBindings";

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
 * registry and names the command that reconciles both.
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
}

/** What this check established. Listed positively, so an inconclusive read says so. */
export type SecretBindingsState =
  /** Every declared environment binds every `cf-secrets-store` secret its Worker reads. */
  | "ok"
  /** A `wrangler.jsonc` would not parse, or the declared set would not load. */
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

/** What {@link checkSecretBindings} needs. Both seams default to the real project's. */
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
    for (const env of environments) {
      const bound = new Set(
        (config.env?.[env]?.secrets_store_secrets ?? []).map((entry) => entry.binding).filter(Boolean),
      );
      for (const binding of declared) {
        if (!bound.has(binding)) missing.push({ worker: target.name, env, binding });
      }
    }
  }

  if (missing.length > 0) return { state: "unbound", missing };
  return { state: unreadable ? "could-not-check" : "ok", missing: [] };
}

/**
 * The lines the report prints, or none at all when there is nothing to say.
 *
 * One line per Worker-and-environment rather than per binding: the remedy is the same command for all of
 * them, and a project composing four `cf-secrets-store` secrets would otherwise print eight sentences
 * that differ only in a name. An adopter counts lines.
 */
export function describeSecretBindings(check: SecretBindingsCheck): string[] {
  const grouped = new Map<string, MissingSecretBinding[]>();
  for (const entry of check.missing) {
    // `\0` written as the escape, never raw: a raw NUL makes the whole file binary to git, so it
    // has no line diff and nothing in review can see what changed around it.
    const key = `${entry.worker}\0${entry.env}`;
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  return [...grouped.values()].map((entries) => {
    const first = entries[0] as MissingSecretBinding;
    const names = entries.map((entry) => entry.binding).join(", ");
    return `${first.worker} env.${first.env} binds no ${names}. Run pithy secrets provision — it creates the store entries and writes the stanza.`;
  });
}
