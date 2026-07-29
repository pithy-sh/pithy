import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { hostWorkflowsFor } from "@pithy-sh/core/src/workflow/host";
import { workflowHostName } from "@pithy-sh/core/src/workflow/naming";
import type { WorkflowRegistry } from "@pithy-sh/core/src/workflow/spec";
import { readWranglerConfig, writeWranglerConfig } from "./wrangler";

/**
 * The bindings a capability's **provisioner** writes into the app's `wrangler.jsonc` — the ones
 * `pithy add` deliberately cannot write.
 *
 * Wrangler validates its config before it does anything else, and two binding kinds carry required
 * fields whose values only exist after provisioning: a `vectorize` entry must name an `index_name`,
 * and a `workflows` entry must carry a `name` and a `class_name`. `pithy add` is offline — it knows
 * neither the provisioned index name nor the per-environment Workflow script name — so an `add` that
 * emitted a partial entry would leave the adopter with a `wrangler.jsonc` that fails to load. It
 * emits nothing instead, and this module completes the entry once `pithy <capability> provision` has
 * stood the resources up. `capabilities/add.ts` states the same contract from the other side.
 *
 * `dev` writes the top-level stanza and every other environment writes its own `env.<name>` — the same
 * rule `commands/vector.ts` reads the app database id by and writes `VECTOR_PROVISIONED` by. Wrangler
 * does not inherit bindings into a named environment, and every name written here is
 * environment-scoped anyway. Upsert by binding name, comment-preserving, idempotent: re-provisioning
 * rewrites the same entries in place.
 */

/**
 * One `workflows` entry, complete. `binding` and `class_name` are code references; `name` is the
 * deployed Workflow and `script_name` the host Worker that runs it — both environment-scoped, which
 * is exactly why they arrive here rather than at add time.
 */
export interface AppWorkflowBinding {
  /** The binding name the Worker env exposes, e.g. `STORAGE_SWEEP`. */
  binding: string;
  /** The deployed Workflow name, `pithy-<capability>-<job>-<env>`. */
  name: string;
  /** The exported `WorkflowEntrypoint` subclass that runs the job. */
  class_name: string;
  /** The host Worker the class lives in, `pithy-<capability>-<env>` — this is a cross-script binding. */
  script_name: string;
}

/** One `vectorize` entry, complete. `index_name` is the provisioned index, `pithy-vector-<index>-<env>`. */
export interface AppVectorizeBinding {
  /** The binding name the Worker env exposes, e.g. `VECTORIZE`. */
  binding: string;
  /** The provisioned Vectorize index this binding addresses. */
  index_name: string;
  /** Reach the real index in local dev. Vectorize has no local emulation, so this is always true. */
  remote?: boolean;
}

/** The provisioner-owned slice of one `env.<env>` stanza. */
interface AppBindingStanza {
  workflows?: AppWorkflowBinding[];
  vectorize?: AppVectorizeBinding[];
}

/** The bindings one provisioning run wrote for one environment. Either list may be omitted. */
export interface AppBindings {
  /** Complete `workflows` entries, one per hosted job. */
  workflows?: readonly AppWorkflowBinding[];
  /** Complete `vectorize` entries, one per configured index. */
  vectorize?: readonly AppVectorizeBinding[];
}

/**
 * Upsert entries into a binding array **in place**. comment-json stores an array's comments as
 * symbol-keyed properties on the array object itself, so replacing the array with a fresh one would
 * silently delete the adopter's notes — the rule `capabilities/remove.ts` and
 * `feature/wranglerEnv.ts` both document.
 */
function upsertByBinding<Entry extends { binding: string }>(entries: Entry[], incoming: readonly Entry[]): void {
  for (const entry of incoming) {
    const index = entries.findIndex((candidate) => candidate.binding === entry.binding);
    if (index === -1) entries.push(entry);
    else entries[index] = entry;
  }
}

/**
 * The fields wrangler's config validator **requires**, per binding kind. An entry missing one of these
 * does not degrade — it fails validation, and `wrangler dev` and `wrangler deploy` both refuse to run.
 * Stated here once, so the writer and its tests check the same list.
 */
const REQUIRED_FIELDS: Record<"workflows" | "vectorize", readonly string[]> = {
  workflows: ["binding", "name", "class_name"],
  vectorize: ["binding", "index_name"],
};

/**
 * Every `workflows`/`vectorize` entry in one stanza that wrangler would reject, described. Empty means
 * the stanza loads. Exported because "does this config still load" is the property the writer promises,
 * and a promise worth making is worth asserting.
 */
export function incompleteBindings(stanza: unknown): string[] {
  if (typeof stanza !== "object" || stanza === null) return [];
  const problems: string[] = [];
  for (const [key, required] of Object.entries(REQUIRED_FIELDS)) {
    const entries = (stanza as Record<string, unknown>)[key];
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry: unknown, index: number) => {
      const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
      const missing = required.filter((field) => typeof record[field] !== "string" || record[field] === "");
      if (missing.length > 0) {
        const named = typeof record.binding === "string" ? record.binding : `#${index}`;
        problems.push(`${key}[${named}] is missing ${missing.join(", ")}`);
      }
    });
  }
  return problems;
}

/**
 * Write a capability's provisioned bindings into the project's `wrangler.jsonc`, for one environment.
 *
 * Every entry written here is complete by construction — the types demand each field wrangler
 * requires — and the stanza is checked before the file is written, so a `wrangler.jsonc` this function
 * touched always loads. Idempotent and comment-preserving.
 */
export async function applyAppBindings(projectDir: string, env: string, bindings: AppBindings): Promise<void> {
  if (!bindings.workflows?.length && !bindings.vectorize?.length) return;

  const config = (await readWranglerConfig(projectDir)) as AppBindingStanza & {
    env?: Record<string, AppBindingStanza | undefined>;
  };

  let stanza: AppBindingStanza = config;
  if (env !== "dev") {
    config.env ??= {};
    stanza = config.env[env] ?? {};
    config.env[env] = stanza;
  }

  if (bindings.workflows?.length) {
    stanza.workflows ??= [];
    upsertByBinding(stanza.workflows, bindings.workflows);
  }
  if (bindings.vectorize?.length) {
    stanza.vectorize ??= [];
    upsertByBinding(stanza.vectorize, bindings.vectorize);
  }

  // Never write a config wrangler will not load. A hand-edited entry that lost a field lands here too,
  // which is the right place to hear about it — before the next deploy.
  const problems = incompleteBindings(stanza);
  if (problems.length > 0) {
    throw new InternalError({
      message: "wrangler.jsonc would not load with these bindings.",
      action: `Fix the ${env} bindings in wrangler.jsonc by hand, then re-run provision.`,
      detail: problems.join("; "),
    });
  }

  await writeWranglerConfig(projectDir, config);
}

/**
 * The complete `workflows` entries for one capability in one environment, derived from its own
 * registry. Thin over core's {@link hostWorkflowsFor}, which already computes the deployed Workflow
 * name from the spec — the app's entry is the host's plus `script_name`, because the class lives in
 * the host Worker rather than the app's own script.
 *
 * Every job the capability owns, which is right when the app dispatches all of them (storage, vector).
 * A capability whose host self-fires a job the app must never bind — `@pithy-sh/email`'s scheduler —
 * filters the result against its manifest's `requiredBindings` before writing.
 */
export function appWorkflowBindings(registry: WorkflowRegistry, capability: string, env: string): AppWorkflowBinding[] {
  const scriptName = workflowHostName(capability, env);
  return hostWorkflowsFor(registry, capability, env).workflows.map((entry) => ({
    ...entry,
    script_name: scriptName,
  }));
}
