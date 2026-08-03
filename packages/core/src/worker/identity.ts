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

/** Where a Worker is running, as it can state about itself. Every field is `null` when unstamped. */
export interface WorkerIdentity {
  /** The owning project, or `null` when the Worker carries no `PROJECT` var. */
  project: string | null;
  /** The environment this deployment serves, or `null` when unstamped. */
  environment: string | null;
  /** The Worker's `apps/<name>` directory name, or `null` when unstamped. */
  worker: string | null;
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
    return { project: null, environment: null, worker: null };
  }
  const vars = env as Record<string, unknown>;
  return {
    project: stamped(vars, PROJECT_VAR),
    environment: stamped(vars, ENVIRONMENT_VAR),
    worker: stamped(vars, WORKER_VAR),
  };
}
