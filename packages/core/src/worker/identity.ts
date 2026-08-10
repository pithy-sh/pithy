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
   * The timestamp the platform reports for this build, ISO-8601, verbatim as it was issued — or `null`.
   *
   * **Which moment it names is not settled, and this reader does not decide.** The binding spells it
   * `timestamp`, which names a moment without saying which one. Cloudflare documents it as when the
   * version was *created*; the first adopter's maintainer reports seeing it move on a *rollback*, which
   * would make it the moment of deployment. Neither has been measured: telling them apart needs a real
   * deploy and a real rollback against a real account, and a local `wrangler dev` cannot stand in
   * because it mints a fresh version on every restart — its `timestamp` is the dev server's start time,
   * which is consistent with both readings and therefore evidence for neither.
   *
   * So the value is relayed for comparison and never interpreted. A consumer's rule is
   * `workerBuildChanged` in `controlPlane/wire.ts`: anything that moved is a change, and a direction is
   * not a meaning. The name is `createdAt` because the platform's own documentation says created; read
   * it as "the moment this build is stamped with", and settle it by observing a rollback.
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
 * a value: anything that differs is a change. A different `id` is a different build; the **same `id`
 * with a `createdAt` that moved is the same build deployed again**, which is the state the id alone
 * could not reach and the one #260 was filed for. Absence on either side is silence, never change.
 * `workerBuildChanged` in `controlPlane/wire.ts` is that rule, written once so no client hand-rolls it.
 *
 * **What this cannot answer is what the fields mean, and that is deliberate.** Whether `createdAt`
 * moves when an already-uploaded build is deployed again turns on which moment the platform stamps, and
 * nobody here has run the deploy-and-rollback that would settle it. The rule above holds either way:
 * under one reading the same-id case never occurs, under the other it is the whole point.
 *
 * If it turns out the platform stamps only the upload, then a redeploy of a build a client already
 * holds moves nothing and is invisible from inside the Worker. Nothing in the runtime would close that
 * gap either: the only in-Worker proxy is isolate boot time, which changes on every cold start and
 * would report a redeploy dozens of times a day, and a false change is worse than a missed one for a
 * client that invalidates a rendered pane on it. So nothing is stamped, and a client that must have
 * that answer today reads Cloudflare's deployments API.
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
