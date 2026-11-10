// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import { pithyCommand, workerDirOf } from "@pithy-sh/core/src/cli/command";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { parseVar, varValueFor } from "@pithy-sh/core/src/worker/vars";
import { composeFor } from "../project/composeFor";
import { allCapabilities, type WorkerConfig } from "../project/config";
import { PER_ENVIRONMENT_VARS, stanzaVarsOf } from "../project/stanzaVars";
import { discoverWorkers, type WorkerTarget } from "../project/workers";
import { copiedFromTopLevel, type DeclaredWorkerVar, declaredWorkerVars } from "../project/workerVars";
import { readWranglerConfig } from "../project/wrangler";

/**
 * **Does every stanza of every Worker's `wrangler.jsonc` carry every var it should?**
 *
 * `env.<name>.vars` replaces the top-level block rather than merging with it, so a var the top level sets and a
 * stanza leaves out deploys without it, silently. This names each one, declared with `defineVars` or written by hand,
 * with the line to add; a declared var the top level lacks; a declared var whose value its schema refuses; and a
 * declared var a stanza holds at the top level's value where the declaration gives that environment its own.
 *
 * A var the CLI writes with each stanza's own value ({@link PER_ENVIRONMENT_VARS}) is never suggested at the top
 * level's: `ENVIRONMENT` is suggested at the stanza's name, and `BASE_URL` and `VECTOR_PROVISIONED` are left to the
 * command that writes them, because the top level's is dev's address or dev's provisioning record.
 *
 * A stanza with no `vars` block at all is `environmentInheritance.ts`'s finding, and not repeated here. A var only an
 * environment sets is that environment's own. Report only: it prints, and never fails the exit. Files only, but for
 * the Worker's `pithy.config.ts`, which is loaded for its declaration; one that will not load declares nothing.
 */

/** One var one stanza lacks, or holds a value for that its declaration refuses. */
export type VarStanzaFinding =
  | {
      /** The Worker's `apps/<name>` directory. */
      worker: string;
      kind: "missing";
      /** Where: `vars` for the top level, `env.<name>` for an environment. */
      stanza: string;
      /** The var. */
      name: string;
      /** Whether the Worker or a capability it composes declares it with `defineVars`. */
      declared: boolean;
      /** The line to add to that stanza's `vars`. */
      line: string;
    }
  | {
      worker: string;
      kind: "copied";
      stanza: string;
      name: string;
      /** The value the stanza holds: the top level's. */
      value: unknown;
      /** The line that sets the environment's own value. */
      line: string;
    }
  | {
      worker: string;
      kind: "invalid";
      stanza: string;
      name: string;
      /** The value the stanza holds. */
      value: unknown;
      /** Why the declaration refuses it. */
      problem: string;
    };

/** What the check established. */
export interface VarStanzasCheck {
  /** `faulty` when a finding was made; `ok` otherwise; `could-not-check` when nothing could be read. */
  state: "ok" | "faulty" | "could-not-check";
  /** Each Worker's findings in discovery order: the top level first, then each environment. */
  findings: VarStanzaFinding[];
}

/** Seams for {@link checkVarStanzas}. */
export interface VarStanzasOptions {
  /** The Worker config loader (default: each config composed for `dev`; a declaration's values are per environment). */
  loadConfig?: (workerDir: string) => Promise<WorkerConfig>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The findings for one Worker's parsed `wrangler.jsonc`, against what it declares. */
export function varStanzaFindings(
  worker: string,
  config: unknown,
  workerConfig?: Pick<WorkerConfig, "vars" | "capabilities" | "app">,
): VarStanzaFinding[] {
  const root = asRecord(config);
  if (root === null) return [];
  let declared: Map<string, DeclaredWorkerVar>;
  try {
    declared = workerConfig
      ? declaredWorkerVars(workerConfig, allCapabilities(workerConfig as WorkerConfig))
      : new Map();
  } catch {
    declared = new Map();
  }
  const findings: VarStanzaFinding[] = [];
  const top = stanzaVarsOf(root) ?? {};

  const has = (vars: Record<string, unknown>, name: string) => Object.hasOwn(vars, name);
  const lineFor = (name: string, value: unknown) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`;
  const held = (stanza: string, env: string, vars: Record<string, unknown>) => {
    for (const [name, { entry }] of declared) {
      if (!has(vars, name)) continue;
      const value = vars[name];
      if (copiedFromTopLevel(entry, env, value, has(top, name) ? top[name] : undefined)) {
        findings.push({ worker, kind: "copied", stanza, name, value, line: lineFor(name, varValueFor(entry, env)) });
        continue;
      }
      const parsed = parseVar(entry, value);
      if (!parsed.ok) findings.push({ worker, kind: "invalid", stanza, name, value, problem: parsed.problem });
    }
  };

  for (const [name, { entry }] of declared) {
    if (!has(top, name)) {
      findings.push({
        worker,
        kind: "missing",
        stanza: "vars",
        name,
        declared: true,
        line: lineFor(name, varValueFor(entry, LOCAL_ENVIRONMENT)),
      });
    }
  }
  held("vars", LOCAL_ENVIRONMENT, top);

  for (const [env, value] of Object.entries(asRecord(root.env) ?? {})) {
    const stanza = asRecord(value);
    const vars = stanza === null ? null : stanzaVarsOf(stanza);
    if (vars === null) continue;
    const names = [...new Set([...Object.keys(top), ...declared.keys()])];
    for (const name of names) {
      if (has(vars, name)) continue;
      const own = declared.get(name);
      let value: unknown = top[name];
      if (own !== undefined) value = varValueFor(own.entry, env);
      else if (PER_ENVIRONMENT_VARS.has(name)) {
        const perEnvironment = PER_ENVIRONMENT_VARS.get(name);
        if (!perEnvironment) continue;
        value = perEnvironment(env);
      }
      findings.push({
        worker,
        kind: "missing",
        stanza: `env.${env}`,
        name,
        declared: own !== undefined,
        line: lineFor(name, value),
      });
    }
    held(`env.${env}`, env, vars);
  }
  return findings;
}

/** Read every Worker's `wrangler.jsonc` and declaration, and collect what each stanza lacks or holds wrongly. */
export async function checkVarStanzas(projectDir: string, options: VarStanzasOptions = {}): Promise<VarStanzasCheck> {
  const load = options.loadConfig ?? ((dir: string) => composeFor(LOCAL_ENVIRONMENT, (loader) => loader(dir)));
  let workers: WorkerTarget[];
  try {
    workers = await discoverWorkers(projectDir);
  } catch {
    return { state: "could-not-check", findings: [] };
  }
  const findings: VarStanzaFinding[] = [];
  let unreadable = false;
  for (const target of workers) {
    if (target.hasWrangler === false) continue;
    let config: unknown;
    try {
      config = await readWranglerConfig(target.dir);
    } catch {
      unreadable = true;
      continue;
    }
    const workerConfig = await load(target.dir).catch(() => undefined);
    findings.push(...varStanzaFindings(basename(target.dir), config, workerConfig));
  }
  if (findings.length > 0) return { state: "faulty", findings };
  return { state: unreadable ? "could-not-check" : "ok", findings: [] };
}

/** Where a finding is, as the sentence names it. */
function where(stanza: string): string {
  return stanza === "vars" ? "the top-level vars" : `${stanza}.vars`;
}

/** One sentence for one finding. */
function describeOne(finding: VarStanzaFinding): string {
  if (finding.kind === "invalid") {
    return `${finding.worker}: ${where(finding.stanza)} sets ${finding.name} to ${JSON.stringify(finding.value)}, which its declaration refuses: ${finding.problem.replace(/\.$/, "")}.`;
  }
  const sync = pithyCommand("worker sync", { flags: { "--worker": workerDirOf({ dir: finding.worker }) } });
  if (finding.kind === "copied") {
    const env = finding.stanza.replace(/^env\./, "");
    return `${finding.worker}: ${where(finding.stanza)} sets ${finding.name} to ${JSON.stringify(finding.value)}, the top level's value, where the Worker declares its own for ${env}. Set ${finding.line}, or run ${sync}.`;
  }
  const head = `${finding.worker}: ${where(finding.stanza)} has no ${finding.name}`;
  if (!finding.declared) return `${head}, which the top level sets. Add ${finding.line}.`;
  return `${head}, which the Worker declares. Add ${finding.line}, or run ${sync}.`;
}

/** One line per finding, none when there is none, and one saying so when the check could not run. */
export function describeVarStanzas(check: VarStanzasCheck): string[] {
  if (check.state === "could-not-check") return ["Could not compare the vars each Worker's stanzas set."];
  return check.findings.map(describeOne);
}

/** The remedy line under the findings. */
export const VAR_STANZAS_ACTION = "env.<name>.vars replaces the top-level block, so every stanza repeats every var.";
