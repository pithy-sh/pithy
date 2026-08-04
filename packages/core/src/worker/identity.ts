// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a running Worker knows about itself — the three vars every Pithy Worker is scaffolded with, and
 * the one reader for them.
 *
 * The Cloudflare runtime hands a script **nothing** about its own identity. `TraceItem.scriptName` is
 * what a *tail consumer* sees about someone else, `version_metadata` carries an id and a tag but no
 * name, and `navigator.userAgent` is the constant `"Cloudflare-Workers"` in every Worker alive. So
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
 * The deployed build's version id, off the `CF_VERSION_METADATA` binding, or `null`.
 *
 * Exported on its own because two callers want the id without the rest of the identity: the request
 * logger's `version` correlation field, and the control-plane manifest and response header. Same
 * never-throws, never-guesses contract as {@link workerIdentity} — an absent binding is an ordinary,
 * permanent state for any Worker scaffolded before it was declared.
 */
export function workerVersion(env: unknown): string | null {
  if (typeof env !== "object" || env === null || Array.isArray(env)) return null;
  const meta = (env as Record<string, unknown>)[VERSION_METADATA_BINDING];
  if (typeof meta !== "object" || meta === null) return null;
  const id = (meta as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
