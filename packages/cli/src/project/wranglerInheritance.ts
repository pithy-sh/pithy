// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { ENVIRONMENT_VAR } from "@pithy-sh/core/src/worker/identity";

/**
 * **What an `env.<name>` stanza does not inherit from the top level of a `wrangler.jsonc`** (#581).
 *
 * Most of a `wrangler.jsonc` flows down: declare `compatibility_date`, `observability` or `triggers` once
 * at the top and every environment has it. A minority does not. Those keys are taken from the stanza
 * alone, and a key declared at the top level and omitted from an environment is simply **absent** in that
 * environment — whatever the top level says, with no error and, at deploy time, one warning in a stream
 * nobody is reading.
 *
 * ## The list is written by hand and gated against wrangler
 *
 * {@link NOT_INHERITED_BY_ENVIRONMENTS} is the one place the kit states the rule. It is not derived from
 * wrangler at runtime: doctor must answer in a checkout with no wrangler installed, and a list derived
 * from its subject is a list nothing can contradict. `wranglerInheritance.test.ts` holds it to wrangler's
 * own `notInheritable(…)` call sites and to its `EnvironmentNonInheritable` interface, and fails when they
 * diverge.
 *
 * **That gate is the point, not an accessory to it.** #581 was opened with a hand-written four-name list
 * read off a wrangler warning, and two of the four names were wrong — `observability` and `triggers` are
 * both inherited, and the real list is 41 names. The error survived a day, an issue body, and a commit in
 * the kit's first adopter. Enumerating from memory is exactly the shape this repo keeps being bitten by;
 * the fix is not a better memory, it is a comparison that runs.
 *
 * ## Why the kit repeats these rather than teaching around them
 *
 * There is no way to make an environment inherit one. `env.<name>.vars` replaces the top-level block
 * rather than merging it, and the same is true of every key here. So the mechanism is repetition, and the
 * job of this module is to make repetition checkable — by `doctor/environmentInheritance.ts`, which
 * reports what a stanza did not repeat, and by `project/scaffold.ts`, which repeats it when it writes a
 * project's stanzas.
 */

/**
 * The wrangler config keys an `env.<name>` stanza never inherits from the top level.
 *
 * In wrangler's own order, which is the order they appear in `EnvironmentNonInheritable` — so a diff
 * against a later wrangler reads as an insertion rather than a reshuffle.
 *
 * Read from `wrangler@4.125.0`. Changing this by hand without a wrangler bump is how it was wrong before;
 * `wranglerInheritance.test.ts` is what says so.
 */
export const NOT_INHERITED_BY_ENVIRONMENTS: readonly string[] = [
  "define",
  "vars",
  "secrets",
  "durable_objects",
  "workflows",
  "cloudchamber",
  "containers",
  "kv_namespaces",
  "send_email",
  "queues",
  "connect",
  "r2_buckets",
  "d1_databases",
  "vectorize",
  "ai_search_namespaces",
  "ai_search",
  "agent_memory",
  "websearch",
  "hyperdrive",
  "services",
  "analytics_engine_datasets",
  "browser",
  "ai",
  "images",
  "media",
  "stream",
  "version_metadata",
  "unsafe",
  "mtls_certificates",
  "tail_consumers",
  "streaming_tail_consumers",
  "dispatch_namespaces",
  "pipelines",
  "secrets_store_secrets",
  "artifacts",
  "unsafe_hello_world",
  "flagship",
  "ratelimits",
  "worker_loaders",
  "vpc_services",
  "vpc_networks",
];

/** One non-inherited key a stanza did not repeat, and what that environment goes without. */
export interface UnrepeatedKey {
  /** The environment whose stanza omits it — the `env.<name>` key, not a declared-environment name. */
  env: string;
  /** The wrangler key, as it is written in the file. */
  key: string;
  /**
   * The bindings or variables the environment goes without, read out of the adopter's own top-level value.
   *
   * Empty when the value's shape names nothing this can read — a `queues` block, say. The finding still
   * stands; only the cost sentence gets shorter, which is honest. Inventing a name for it would not be.
   */
  carries: readonly string[];
}

/** A `wrangler.jsonc` read far enough to answer this question, and no further. */
interface WranglerShape {
  env?: Record<string, Record<string, unknown> | undefined>;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * **Does this top-level value declare anything an environment could lose?**
 *
 * An empty array or an empty object does not. The starter ships `"d1_databases": []` and
 * `"kv_namespaces": []` at the top level, and `pithy add` leaves them empty until a capability needs one —
 * so a check that matched wrangler exactly would open on every freshly scaffolded project with two
 * findings that cost nothing, which is the fastest way to teach an adopter to skip this block.
 *
 * **This is a deliberate divergence from wrangler's warning**, which fires on any value that is not
 * `undefined`. The rule this check states is *an environment must not silently go without something the
 * top level declares*, and an empty collection is not something. What it is not is a loophole: the moment
 * one binding lands in that array, the key is reported everywhere it is not repeated.
 */
function declaresSomething(value: unknown): boolean {
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  const record = asRecord(value);
  return record === null ? true : Object.keys(record).length > 0;
}

/** The binding or variable names inside a value, where its shape says them plainly. */
function carriedNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const binding = asRecord(entry)?.binding;
      return typeof binding === "string" ? [binding] : [];
    });
  }
  const record = asRecord(value);
  if (record === null) return [];
  // `version_metadata`, `browser`, `ai`, `images` — one binding, named on the object itself.
  if (typeof record.binding === "string") return [record.binding];
  // `durable_objects`, and anything else wrangler shapes as a named bindings array.
  if (Array.isArray(record.bindings)) {
    return record.bindings.flatMap((entry) => {
      const named = asRecord(entry);
      const name = named?.name ?? named?.binding;
      return typeof name === "string" ? [name] : [];
    });
  }
  // `vars` and `define`: a flat map of names to values. The primitive test is what keeps a `queues`
  // block — whose keys are `producers` and `consumers` — from being read as a list of binding names.
  const values = Object.values(record);
  const flat = values.length > 0 && values.every((entry) => asRecord(entry) === null && !Array.isArray(entry));
  return flat ? Object.keys(record) : [];
}

/**
 * The top-level entries a stanza must repeat: every non-inherited key whose value declares something.
 *
 * Returned as a fresh deep copy, because the caller is `scaffold.ts` writing the same value into two or
 * three stanzas beside the top level it came from — and a shared reference there is one edit reaching four
 * places in the file.
 *
 * Keys come back in the config's own order, so a stanza built from this reads like the top level it
 * mirrors rather than like this module's declaration order.
 */
export function topLevelKeysToRepeat(config: unknown): Record<string, unknown> {
  const record = asRecord(config);
  if (record === null) return {};
  const repeat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!NOT_INHERITED_BY_ENVIRONMENTS.includes(key)) continue;
    if (!declaresSomething(value)) continue;
    repeat[key] = structuredClone(value);
  }
  return repeat;
}

/**
 * Every non-inherited key this config declares at the top level and one of its stanzas does not repeat.
 *
 * **Stanzas, not the project's declared environments.** An environment the project declares and the Worker
 * has no stanza for is `checkEnvironments`' finding (#241) and gets its own line there; reporting it again
 * here, once per non-inherited key, would bury that one sentence under forty.
 *
 * A stanza *mentioning* the key is enough — repeating it with a different value is the whole point, and
 * repeating it with an empty one is a deliberate "this environment has none of these".
 */
export function unrepeatedKeys(config: unknown): UnrepeatedKey[] {
  const record = asRecord(config) as WranglerShape | null;
  if (record === null) return [];
  const stanzas = asRecord(record.env);
  if (stanzas === null) return [];
  const found: UnrepeatedKey[] = [];
  for (const [env, stanza] of Object.entries(stanzas)) {
    const declared = asRecord(stanza) ?? {};
    for (const [key, value] of Object.entries(record)) {
      if (!NOT_INHERITED_BY_ENVIRONMENTS.includes(key)) continue;
      if (!declaresSomething(value)) continue;
      if (declared[key] !== undefined) continue;
      found.push({ env, key, carries: carriedNames(value) });
    }
  }
  return found;
}

/**
 * One finding, as the sentence that fits it: the key, the environment, the cost, and the remedy.
 *
 * The cost is read out of the adopter's own value rather than from a table of prose per key. A
 * forty-one-entry table of what each key is for is a second hand-written list, kept in step with nothing —
 * and this way the line names `CF_VERSION_METADATA`, the binding the adopter's code actually reads, rather
 * than a paraphrase of what version metadata is.
 */
export function describeUnrepeatedKey(found: UnrepeatedKey): string {
  const without = found.carries.length > 0 ? found.carries.join(", ") : "it";
  return `${found.key} is at the top level and not in env.${found.env}. Environments do not inherit it, so ${found.env} deploys without ${without}. Repeat it in env.${found.env}.`;
}

/**
 * **The value a brand-new stanza starts that key at** — the top level's, with every list of entries
 * emptied.
 *
 * Repeating a key is not the same as duplicating its value, and the difference is the whole of this
 * function. (The one list carried whole is {@link CARRIED_WHOLE}'s, and it says why.) `vars` and `version_metadata` say the same thing in every environment, so they come down
 * verbatim. A `d1_databases` entry does not: it names one Cloudflare database by id, and carrying dev's
 * id into a stanza for `staging` would point staging at the database dev writes to. That is a *worse*
 * defect than the absent binding this module exists to fix — an absent binding fails loudly on the first
 * request, a shared one corrupts quietly — so a list starts empty and the writer fills in this
 * environment's own entries.
 *
 * **Shape, not a table of key names.** "A list of entries is a list of this environment's resources" is
 * read off the value, so it holds for the forty-one keys wrangler has today and for the one it adds next.
 * The nested pass is for the two shapes that wrap their list in an object — `durable_objects.bindings`,
 * `queues.producers` / `.consumers` — which are lists by any other name.
 */
function seedValue(value: unknown): unknown {
  if (Array.isArray(value)) return [];
  const record = asRecord(value);
  if (record === null) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, Array.isArray(entry) ? [] : structuredClone(entry)]),
  );
}

/**
 * **The non-inherited lists whose entries are the same in every environment — carried into a new stanza whole
 * (#643).**
 *
 * {@link seedValue} empties every list, because a list's entries are almost always this environment's own
 * resources, and carrying `dev`'s database into `staging` would be the quiet corruption it exists to prevent. A
 * rate limiter is the exception, and it is one by the kit's own rule: `pithy add` derives a limiter's
 * `namespace_id` from its binding name alone (`rateLimitNamespaceId`), identical in every environment, and its
 * `simple` policy is the adopter's, stated once. Nothing in the entry names a resource an environment owns. So
 * an emptied `ratelimits` was not caution — it was a feature stanza with no `AUTH_RATE_LIMITER`, and auth
 * refusing every request on `Missing required bindings`.
 *
 * **`send_email` is the second, and it is one by the same reading (#650 review).** An entry is
 * `{ name, destination_address? }`: a binding name, and an address verified once at the Cloudflare account. No
 * environment owns a copy of an Email Sending destination — the kit's own host templates carry theirs unchanged
 * into every environment, which is that reading already in force. And `email` is in neither `isWrittenBinding`
 * nor `isProvisionedBinding`, so nothing anywhere would ever refill an emptied one: a hand-written `NOTIFY` came
 * back as `env.NOTIFY is undefined` at the first send, not even as a missing binding.
 *
 * A name table rather than a shape rule, because no shape tells a limiter's `namespace_id` — a counter label —
 * from a namespace's `id`, nor an Email Sending destination from a queue's name. Every key here must also be one
 * {@link NOT_INHERITED_BY_ENVIRONMENTS} names, which `wranglerInheritance.test.ts` holds. `workflows` is
 * deliberately not here: its entries name `dev`'s Workflows, and a scope that needs them writes its own
 * (`feature/hosts.ts`, `project/appWorkflows.ts`). `queues` and `analytics_engine_datasets` are not here either,
 * and for the opposite reason to `workflows`: each entry names a resource an environment owns, nothing derives
 * one per environment, and a feature carrying the top level's would bind production's queue.
 */
export const CARRIED_WHOLE: readonly string[] = ["ratelimits", "send_email"];

/** A config far enough to reach its stanzas. The caller casts back to whatever slice it cares about. */
interface StanzaHost {
  env?: Record<string, Record<string, unknown> | undefined>;
  [key: string]: unknown;
}

/**
 * **The one way to get at an environment's stanza — and the only place a stanza is created.**
 *
 * #581 taught two of the kit's stanza writers to repeat what an environment does not inherit and missed
 * the third, `provision/wranglerEnv.ts`, which is the one every `pithy provision` and every feature deploy
 * goes through. Its stanzas repeated nothing, so a feature's Worker deployed with no `vars` at all — and
 * four more modules had the same three lines. Six writers of one thing is the defect; this is the one
 * thing, and `ci/envStanzaWriters.test.ts` is what keeps a seventh from being written.
 *
 * A stanza that is already there is handed back untouched — **an adopter's stanza is theirs** (#142), and a
 * key they deliberately left out is a decision, not an omission. `pithy doctor` reports it; nothing here
 * writes over it. Only a stanza that did not exist a moment ago is seeded, because that one has no author
 * to disagree with.
 *
 * **`dev` is the top level.** Wrangler has no `env.dev` — the local environment *is* the outer object
 * ({@link LOCAL_ENVIRONMENT}) — so this hands it back, and a caller that loops over every environment a
 * project has needs no branch of its own. Three writers had spelled that branch out for themselves; the
 * fourth would have got it wrong.
 *
 * The seeded `ENVIRONMENT` var is this environment's own, where the top level stamps one at all. Copying
 * `ENVIRONMENT: "dev"` into `env.staging` would leave every composition in staging reporting itself as dev
 * — repeating the key while breaking the thing it is read for. Where an adopter stamps no `ENVIRONMENT`,
 * none is invented.
 *
 * Mutates `config` and returns the live stanza, so the caller goes on writing into it as it always did.
 */
export function stanzaFor(config: unknown, env: string): Record<string, unknown> {
  const host = asRecord(config) as StanzaHost | null;
  if (host === null) {
    throw new InternalError({
      message: "A wrangler.jsonc stanza could not be read.",
      detail: `stanzaFor was asked for env.${env} of a config that is not an object.`,
    });
  }
  if (env === LOCAL_ENVIRONMENT) return host;
  host.env ??= {};
  // `asRecord`, not `!== undefined`: a hand-edited `"staging": null` is a stanza in name only, and handing
  // it back would put every caller's `stanza.vars ??= {}` on a null. It is treated as the absence it is.
  const existing = asRecord(host.env[env]);
  if (existing !== null) return existing;
  const seeded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(topLevelKeysToRepeat(host))) {
    seeded[key] = CARRIED_WHOLE.includes(key) ? value : seedValue(value);
  }
  const vars = asRecord(seeded.vars);
  if (vars !== null && typeof vars[ENVIRONMENT_VAR] === "string") vars[ENVIRONMENT_VAR] = env;
  host.env[env] = seeded;
  return seeded;
}
