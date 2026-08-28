// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a running Worker knows about itself — the three vars every Pithy Worker is scaffolded with, and
 * the one reader for them.
 *
 * The Cloudflare runtime hands a script **nothing** about its own identity. `TraceItem.scriptName` is
 * what a *tail consumer* sees about someone else, `version_metadata` carries an id, a tag and a
 * creation time but no name, and `navigator.userAgent` is the constant `"Cloudflare-Workers"` in every
 * Worker alive. So
 * identity is stamped, not derived: `pithy init` and `pithy worker add` write `PROJECT`, `ENVIRONMENT`,
 * and `WORKER` into every environment stanza of the Worker's own `wrangler.jsonc`.
 *
 * Stamping also beats deriving even where a value looks recoverable. A host's script name leads with
 * its project, but `<project>-<env>-<capability>` cannot be parsed back into its parts once a project
 * name contains a hyphen — and wrangler appends `-staging`/`-prod` at deploy, so the script name is not
 * even stable across environments while `apps/<name>/` is.
 *
 * The names live here because they had already been copied: `ENVIRONMENT_VAR` was declared privately in
 * both `workflow/host.ts` and `controlPlane/capability.ts`, character for character. A third copy for
 * `WORKER` would have made the drift structural — the arrangement where a rule stops being one rule.
 */

/** The var naming the owning project: the root `pithy.config.ts` `name`, kebabed. */
export const PROJECT_VAR = "PROJECT";

/** The var naming the environment this deployment serves — `dev`, `staging`, or `prod`. */
export const ENVIRONMENT_VAR = "ENVIRONMENT";

/**
 * The var carrying a Worker's **own** dev origin, from `pithy dev` to whatever launches that Worker.
 *
 * Not stamped into `wrangler.jsonc` like the three above, and that is the whole point of it. A dev port
 * is *allocated* — every checkout reserves its own block — so this is the one identity value a file in
 * the repository cannot state: written down, it is right in the first checkout on a machine and wrong
 * in every other one (#462).
 *
 * It lives here for the reason the others do. `pithy dev` writes it and `@pithy-sh/vite` reads it, and
 * those two packages cannot import each other — the CLI depends on vite's package, and vite's may not
 * depend on the CLI. A privately declared copy on each side is the arrangement where one rule quietly
 * becomes two.
 *
 * **A carrier, not a binding.** It reaches a *process*, not a Worker: `process.env` inside workerd is
 * that script's own vars and nothing else. `@pithy-sh/vite`'s `devWorkerConfig()` is what turns it into
 * the Worker's `BASE_URL`, which is the binding anything at runtime actually reads.
 */
export const WORKER_ORIGIN_VAR = "PITHY_WORKER_ORIGIN";

/**
 * The var naming the Worker itself: its `apps/<name>` **directory** name, not its deploy name.
 *
 * The directory name is the identity everything else already keys on — the `apps/*` registry, the
 * `--worker` flag, the `.dev.config.json` port block. The deploy name (`<project>-<name>`) would
 * re-encode the project as noise beside a `project` column that already carries it, and the deployed
 * script's real name varies by environment where the directory does not.
 */
export const WORKER_VAR = "WORKER";

/**
 * The version-metadata binding Cloudflare injects, naming the exact build that is running.
 *
 * Not a var — a binding, declared as `"version_metadata": { "binding": "CF_VERSION_METADATA" }` and
 * populated by the platform rather than by the scaffold. It belongs beside the three vars anyway,
 * because it answers the same question they do and is read on the same path: this is what a Worker knows
 * about itself.
 *
 * **The name is the join.** It is what `pithy init` and `pithy worker add` write and what this module
 * reads; binding a differently-named one creates a binding nothing consumes, which is the failure this
 * whole thread is repairing — the reader shipped, the template never declared it, and the field was
 * silently absent in every scaffolded project.
 */
export const VERSION_METADATA_BINDING = "CF_VERSION_METADATA";

/** Where a Worker is running, as it can state about itself. Every field is `null` when unstamped. */
export interface WorkerIdentity {
  /** The owning project, or `null` when the Worker carries no `PROJECT` var. */
  project: string | null;
  /** The environment this deployment serves, or `null` when unstamped. */
  environment: string | null;
  /** The Worker's `apps/<name>` directory name, or `null` when unstamped. */
  worker: string | null;
  /**
   * The deployed build's Cloudflare version id, or `null` off-platform and wherever the
   * `CF_VERSION_METADATA` binding is absent.
   *
   * Opaque and per-deploy: it identifies *exactly which build* is running, which is the right answer for
   * forensics, for reproducing a report, and for pinning what an audited action ran against. It carries
   * no version semantics, so it says nothing about which features a Worker has — that is what the
   * composed package versions in the control-plane manifest are for.
   */
  version: string | null;
}

/**
 * Everything the `CF_VERSION_METADATA` binding carries about the build that is running.
 *
 * **Measured, not read off the docs.** A `wrangler dev` (4.120.1 / miniflare 4) against a Worker
 * declaring `version_metadata` hands the binding as `{ id, tag, timestamp }` — three own keys, every
 * value a string, `timestamp` an ISO-8601 instant. Every field is independently `null` here, because a
 * partial binding is what a platform change looks like from inside a Worker and losing the id over a
 * renamed sibling would be the worse trade.
 *
 * **It names a *version*, never a deployment.** That distinction is the whole ceiling on what a client
 * can conclude from it — see {@link workerVersionMetadata}.
 */
export interface WorkerVersionMetadata {
  /** The version id: opaque, per version, and the answer to "which build". `null` where the binding is. */
  id: string | null;
  /**
   * The version tag, set only by `wrangler versions upload --tag`, or `null`.
   *
   * Empty in every local dev and in every deploy nobody tagged, so `""` reads as absent rather than as a
   * tag to compare against. Read here so this reader mirrors the binding; deliberately **not** stamped
   * on the control-plane header — it is adopter-authored free text, and the two questions a management
   * client asks are answered without it.
   */
  tag: string | null;
  /**
   * When this **version was uploaded**, ISO-8601, verbatim as the platform issued it — or `null`.
   *
   * **Cloudflare has two objects here, and this binding describes one of them.** A *version* is an
   * immutable upload of code and config: an id, a created timestamp and a tag, fixed at upload and never
   * again. A *deployment* points at one or more versions with traffic percentages, and is its own object
   * with its own id and its own time. `CF_VERSION_METADATA` reports the **version**, faithfully — and
   * the runtime hands a script **no binding for the deployment at all**.
   *
   * Everything else follows from that. A rollback creates a *new deployment* aimed at an *existing
   * version*, so nothing in this binding moves: not staleness, not ambiguity, a different object. The
   * same answer covers the next question and the one after — a traffic split, a gradual rollout, which
   * deployment is serving: a Worker cannot see any of it. An ordinary redeploy is not affected, because
   * every `wrangler deploy` uploads and so mints a new version, id and all, even for a one-character
   * change.
   *
   * Measured, 2026-08-10, which is what turned that from a reading of the docs into a fact: a probe
   * Worker on a real account, version `A` uploaded, `B` four seconds later, then a real `wrangler
   * rollback` to `A`. Two minutes on, the Worker reported `A`'s id **and `A`'s original timestamp**,
   * unmoved — while wrangler's own rollback output named the new deployment's version list.
   *
   * The value is relayed for comparison and never interpreted. A consumer's rule is
   * `workerBuildChanged` in `controlPlane/wire.ts`: anything that moved is a change, and a direction is
   * not a meaning — propagation lag alone can make an older version answer for a while after a deploy.
   *
   * `null` for anything that is not a parseable instant. That is the one place this reader refuses
   * rather than relays, and the consumer is the reason: a client does `Date.parse` on it and compares,
   * an unparseable string is `NaN`, and every `NaN` comparison is false — so garbage would read as
   * "not newer", which is silently indistinguishable from "unchanged".
   */
  createdAt: string | null;
}

/** One binding field, or `null` for anything that is not a non-empty string. */
function carried(meta: Record<string, unknown>, field: string): string | null {
  const value = meta[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** One var, trimmed, or `null` for anything that is not a non-empty string. */
function stamped(env: Record<string, unknown>, name: string): string | null {
  const value = env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Read a Worker's stamped identity off its `env`.
 *
 * **Never throws, and never guesses.** Both matter on the one call path this exists for: the audit
 * recorder stamps origin onto every event, and the recorder is contractually non-fatal — a throw here
 * would turn "this row has no origin" into "there is no row", which is the strictly worse failure. An
 * absent var is an ordinary, permanent state: a Worker scaffolded before these vars existed carries
 * none of them and nothing back-fills it, so `null` is reported rather than inferred. An invented
 * origin would be indistinguishable from a real one for as long as the trail is kept.
 */
export function workerIdentity(env: unknown): WorkerIdentity {
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    return { project: null, environment: null, worker: null, version: null };
  }
  const vars = env as Record<string, unknown>;
  return {
    project: stamped(vars, PROJECT_VAR),
    environment: stamped(vars, ENVIRONMENT_VAR),
    worker: stamped(vars, WORKER_VAR),
    version: workerVersion(env),
  };
}

/**
 * Read the whole `CF_VERSION_METADATA` binding: which build is running, and when that build was made.
 *
 * **The one reader of the binding**, which is why it returns all of it. The seam used to take the id and
 * drop the rest, and the module docstring above described a two-field binding — so the field this
 * function exists for was discarded by a reader that did not know it was there.
 *
 * ## What a client can conclude
 *
 * Holding the last `(id, createdAt)` it saw, and comparing field by field only where both sides carried
 * a value: anything that differs is a change. Absence on either side is silence, never change.
 * `workerBuildChanged` in `controlPlane/wire.ts` is that rule, written once so no client hand-rolls it.
 *
 * ## What it cannot see, and why that is a boundary rather than a gap
 *
 * **This binding describes a version. Nothing inside a Worker can observe a deployment** — see
 * {@link WorkerVersionMetadata.createdAt} for the two objects and the measurement. So a rollback, a
 * traffic split, a gradual rollout: all invisible here, and no field the seam could add would change
 * that, because the runtime hands a script no binding for the object that carries them. A client that
 * needs a deployment reads Cloudflare's deployments API, in the customer's own account.
 *
 * The temptation is to synthesise one. Isolate boot time is the only in-Worker candidate and it is
 * worse than nothing: it changes on every cold start, so it would report a redeploy dozens of times a
 * day, and a false change costs more than a missed one for a client that invalidates a rendered pane on
 * it. Nothing is stamped.
 *
 * Same never-throws, never-guesses contract as {@link workerIdentity}.
 */
export function workerVersionMetadata(env: unknown): WorkerVersionMetadata {
  const absent: WorkerVersionMetadata = { id: null, tag: null, createdAt: null };
  if (typeof env !== "object" || env === null || Array.isArray(env)) return absent;
  const meta = (env as Record<string, unknown>)[VERSION_METADATA_BINDING];
  if (typeof meta !== "object" || meta === null) return absent;
  const fields = meta as Record<string, unknown>;
  const createdAt = carried(fields, "timestamp");
  return {
    id: carried(fields, "id"),
    tag: carried(fields, "tag"),
    // Relayed verbatim, never re-encoded — but only once it is a time at all.
    createdAt: createdAt !== null && Number.isFinite(Date.parse(createdAt)) ? createdAt : null,
  };
}

/**
 * The deployed build's version id, off the `CF_VERSION_METADATA` binding, or `null`.
 *
 * Kept on its own because four callers want the id and nothing else: the request logger's `version`
 * correlation field, `/health`, the control-plane manifest, and the seam's response header. Its shape
 * is unchanged and deliberately so — every one of those compares or records a single opaque string, and
 * widening it would have rewritten an audit column and a wire field to carry something none of them
 * asked for. {@link workerVersionMetadata} is where the rest of the binding lives.
 */
export function workerVersion(env: unknown): string | null {
  return workerVersionMetadata(env).id;
}
