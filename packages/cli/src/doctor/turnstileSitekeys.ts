// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { resolveClientProjection } from "@pithy-sh/core/src/capability/client";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { DEFAULT_ENVIRONMENTS, FEATURE_ENVIRONMENT, LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { isTurnstileCapability } from "@pithy-sh/turnstile/src/capability";
import { TURNSTILE_LOGIN_ACTION } from "@pithy-sh/turnstile/src/config/config";
import { isStrandedSitekeyVar } from "@pithy-sh/turnstile/src/provision/provisionTurnstile";
import { environmentsBuiltWithoutSitekeys } from "../capabilities/turnstileSitekeys";
import { bootstrapVarsPath, readBootstrapVars } from "../devSecrets/bootstrapVars";
import { readDevVarsSource } from "../devSecrets/devVars";
import type { StatePathOptions } from "../notifier/state";
import { envStanzas, type WranglerStanza } from "../project/bindingEntries";
import { resolveWorkersFor } from "../project/composeFor";
import { projectEnvironments } from "../project/config";
import { discoverWorkers, type WorkerTarget } from "../project/workers";
import { readWranglerConfig } from "../project/wrangler";
import { featureConfigPath } from "../provision/featureConfig";

/**
 * **Where does this project's Turnstile render no widget — and what did an older provisioner leave behind?**
 * (#590)
 *
 * A Turnstile sitekey is a build input. The `pithy()` Vite plugin inlines the capability's client projection,
 * and the projection reads `widgets.<mode>.sitekeys.<environment>` out of `pithy.config.ts`. Where that is
 * blank, the bundle renders no widget, `@pithy-sh/auth` still stacks the gate on sign-in, and the gate fails
 * closed: **nobody can sign in**, and nothing else in the kit says so. `enabled: false` is a quiet answer.
 *
 * ## Two findings
 *
 * - **An environment that renders no widget**, per Worker that gates `login`. Either its sitekey is blank —
 *   a step not yet taken, and `pithy turnstile provision` then a redeploy is the remedy — or no sitekey can
 *   reach it at all: a declared environment beyond the names `TurnstileSitekeys` carries. Those have no
 *   remedy in the kit, and the line says what they are rather than inventing one. A feature build is named
 *   by neither any more: it resolves Cloudflare's always-pass test key by default (#656), so it renders,
 *   unless the config states a blank sitekey for it — which is an adopter's deliberate "no widget here".
 * - **A stranded `TURNSTILE_SITEKEY_*` var**, in a Worker's `wrangler.jsonc` (any stanza), in the project's
 *   `dev.json`, or in the project root's `.dev.vars` — the three files a provisioner ever wrote one into.
 *   Nothing ever read them. This names the file each one is in, and the remedy only where one exists.
 *
 * ## A remedy is named only where it clears the line (#590 review)
 *
 * `pithy turnstile provision --worker <w>` removes stranded vars from `w`'s `wrangler.jsonc` and from
 * `dev.json`, and refuses a `w` that does not compose turnstile. The old split wrote vars into exactly such a
 * Worker. So each finding carries `removedBy`: the Worker whose provision clears it, or `null`. `null` is a
 * Worker that composes no turnstile, and the root `.dev.vars`, which is the adopter's file (#154) and which
 * no command edits. Those lines say to delete the var by hand. `doctor/turnstileSitekeys.test.ts` runs every
 * named remedy and checks the line is gone.
 *
 * ## What it reads, and what it does not see
 *
 * Files and one composition per Worker per environment, no account call. Stranded vars are looked for in the
 * three files a provisioner wrote them into. A Worker's generated `.dev.vars` is not read: it is rebuilt from
 * `dev.json`, which is. A `.dev.vars.local` is not read either: it is the adopter's override, and no provisioner
 * wrote one.
 *
 * **Each environment's widget is asked of the composition for that environment** (#595), the one its build
 * inlines. A config that computes a sitekey, or composes turnstile at all, from `compositionEnvironment()` is
 * answered as that environment's bundle would be; asked once, unstamped, it named a prod that renders and
 * missed a staging where nobody can sign in. `pithy doctor` hands in the compositions its report already took,
 * so none is composed twice. Which Workers a provision accepts is read the same way: a Worker composing
 * turnstile in any environment checked is one. A feature build is looked at only once the
 * Worker has a generated feature config (`featureConfigPath`): before that, nothing has built one, and a
 * line every Turnstile project carried forever would be noise rather than a finding.
 *
 * ## It reports and never fails the exit
 *
 * Every project that ran `pithy turnstile provision` before this landed has stranded vars and blank staging
 * and prod sitekeys by construction. The same verdict `environmentInheritance` and `devVars` take, for the
 * same reason: a green `pithy doctor` turned red in CI by an upgrade is a surprise, not a diagnosis.
 */

/** What this check established. Listed positively, so an inconclusive read never reads as a pass. */
export type TurnstileSitekeysState = "ok" | "could-not-check" | "findings";

/** One `TURNSTILE_SITEKEY_*` var nothing reads. */
export interface StrandedSitekeyVarFinding {
  /** The Worker whose `wrangler.jsonc` holds it, or `null` for the project's `dev.json` and root `.dev.vars`. */
  worker: string | null;
  /** The var's name. */
  name: string;
  /** The stanza it is set in — `dev` for the top level and for `dev.json`. */
  environment: string;
  /** The absolute path of the file it is in. */
  file: string;
  /**
   * The Worker `pithy turnstile provision --worker <name>` clears it for, or `null` when no command does: a
   * Worker that composes no turnstile, which provision refuses, and the project root's `.dev.vars`.
   */
  removedBy: string | null;
}

/** One environment a Worker's front end renders no Turnstile widget in. */
export interface UnrenderedTurnstile {
  /** The Worker's `apps/<name>` directory name. */
  worker: string;
  /** The environment a build for which renders no widget. */
  environment: string;
  /**
   * Whether a sitekey could be stated for it. `true` is a blank sitekey — provisioning fills it. `false` is an
   * environment no sitekey can reach, so nothing the kit runs will make the widget render there.
   */
  slot: boolean;
}

/** What `doctor` learned about this project's Turnstile sitekeys. */
export interface TurnstileSitekeysCheck {
  state: TurnstileSitekeysState;
  stranded: StrandedSitekeyVarFinding[];
  unrendered: UnrenderedTurnstile[];
}

/** A stranded var as read off a file, before anyone has decided what removes it. */
type StrandedRead = Omit<StrandedSitekeyVarFinding, "removedBy">;

/** Every stranded var in one Worker's `wrangler.jsonc`, in stanza order. */
function strandedInWrangler(worker: string, file: string, config: unknown): StrandedRead[] {
  const found: StrandedRead[] = [];
  if (config === null || typeof config !== "object") return found;
  for (const { env, stanza } of envStanzas(config as WranglerStanza)) {
    const vars = (stanza as { vars?: unknown }).vars;
    if (vars === null || typeof vars !== "object") continue;
    for (const name of Object.keys(vars).filter(isStrandedSitekeyVar)) {
      found.push({ worker, name, environment: env, file });
    }
  }
  return found;
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** The environments one Worker's front end is built for, as far as this checkout shows. */
async function builtEnvironments(target: WorkerTarget, declared: readonly string[]): Promise<string[]> {
  const built = [LOCAL_ENVIRONMENT, ...declared];
  if (await exists(featureConfigPath(target.dir))) built.push(FEATURE_ENVIRONMENT);
  return built;
}

/** One Worker composed for one environment — the capabilities a build for it composes. */
export type ComposeWorkerFor = (
  worker: { name: string; dir: string },
  environment: string,
) => Promise<{ capabilities: readonly Capability[] }>;

/** Options for {@link checkTurnstileSitekeys}. */
export interface TurnstileSitekeysOptions {
  /** Where the project's `dev.json` is looked for. */
  paths?: StatePathOptions;
  /**
   * The composition for one Worker in one environment. `pithy doctor` hands in the ones its report already
   * took; the default composes each through {@link resolveWorkersFor}, narrowed to the Worker by name and
   * picked by directory.
   */
  composeWorker?: ComposeWorkerFor;
}

/** Compose one Worker for one environment through the primitive, narrowed by name and picked by directory. */
function composeThroughPrimitive(projectDir: string): ComposeWorkerFor {
  return async (worker, environment) => {
    const found = await resolveWorkersFor(environment, { projectDir, worker: worker.name });
    const match = found.find((candidate) => candidate.dir === worker.dir);
    if (match === undefined)
      throw new ValidationError({ message: `${worker.name} did not resolve for ${environment}.` });
    return match;
  };
}

/** Walk every Worker and the project's `dev.json`. Never throws. */
export async function checkTurnstileSitekeys(
  projectDir: string,
  options: TurnstileSitekeysOptions = {},
): Promise<TurnstileSitekeysCheck> {
  const composeWorker = options.composeWorker ?? composeThroughPrimitive(projectDir);
  let workers: WorkerTarget[];
  try {
    workers = await discoverWorkers(projectDir);
  } catch {
    return { state: "could-not-check", stranded: [], unrendered: [] };
  }
  const declared = await projectEnvironments(projectDir).catch(() => [...DEFAULT_ENVIRONMENTS]);
  const withoutSlot = new Set(environmentsBuiltWithoutSitekeys(declared));

  const read: StrandedRead[] = [];
  const unrendered: UnrenderedTurnstile[] = [];
  /** The Workers composing turnstile — the only targets `pithy turnstile provision` accepts. */
  const composing: string[] = [];
  let unreadable = false;

  for (const target of workers) {
    const worker = basename(target.dir);
    if (target.hasWrangler !== false) {
      const file = join(target.dir, "wrangler.jsonc");
      try {
        read.push(...strandedInWrangler(worker, file, await readWranglerConfig(target.dir)));
      } catch {
        unreadable = true;
      }
    }

    for (const environment of await builtEnvironments(target, declared)) {
      let capabilities: readonly Capability[];
      try {
        capabilities = (await composeWorker(target, environment)).capabilities;
      } catch {
        // A Worker with no config, or one that throws for this environment: `Environment configs:` and the
        // health block name that. It costs this Worker this environment's widget verdict and nothing else —
        // its stranded vars above were read off a different file.
        if (target.hasWrangler === true) unreadable = true;
        continue;
      }
      const turnstile = capabilities.find(isTurnstileCapability);
      if (turnstile !== undefined && !composing.includes(worker)) composing.push(worker);
      // No login gate, no blocked sign-in: a Worker that protects only its own forms renders what it renders.
      if (turnstile?.turnstileConfig.protect[TURNSTILE_LOGIN_ACTION] === undefined) continue;
      if (withoutSlot.has(environment)) {
        unrendered.push({ worker, environment, slot: false });
        continue;
      }
      // The build's own resolver, over the build's own composition, so this answers what a bundle for this
      // environment would inline.
      if (!resolveClientProjection(turnstile, { environment }).enabled) {
        unrendered.push({ worker, environment, slot: true });
      }
    }
  }

  const devJson = await bootstrapVarsPath(projectDir, options.paths ?? {}).catch(() => null);
  if (devJson !== null) {
    const recorded = await readBootstrapVars(projectDir, options.paths ?? {}).catch(() => ({}));
    for (const name of Object.keys(recorded).filter(isStrandedSitekeyVar)) {
      read.push({ worker: null, name, environment: LOCAL_ENVIRONMENT, file: devJson });
    }
  }

  // #53's writer put the dev sitekey here. Nothing reads this file — wrangler runs in `apps/<w>` — and it is
  // the adopter's, so it is read and never edited.
  const rootDevVars = join(projectDir, ".dev.vars");
  const rootSource = await readDevVarsSource(rootDevVars).catch(() => {
    unreadable = true;
    return null;
  });
  for (const name of Object.keys(parseDevVars(rootSource ?? "")).filter(isStrandedSitekeyVar)) {
    read.push({ worker: null, name, environment: LOCAL_ENVIRONMENT, file: rootDevVars });
  }

  const stranded = read.map((found) => ({ ...found, removedBy: removedBy(found, rootDevVars, composing) }));
  if (stranded.length > 0 || unrendered.length > 0) return { state: "findings", stranded, unrendered };
  return { state: unreadable ? "could-not-check" : "ok", stranded: [], unrendered: [] };
}

/**
 * The Worker whose `pithy turnstile provision` clears one stranded var, or `null` — decided by what that
 * command reaches. It edits its target's `wrangler.jsonc` and the project's `dev.json`, and it accepts only a
 * target that composes turnstile.
 */
function removedBy(found: StrandedRead, rootDevVars: string, composing: readonly string[]): string | null {
  if (found.file === rootDevVars) return null;
  if (found.worker === null) return composing[0] ?? null;
  return composing.includes(found.worker) ? found.worker : null;
}

/** An environment list for a sentence: `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * One line per Worker per kind of finding, then one per file holding stranded vars — or none at all. The
 * block is the finding.
 */
export function describeTurnstileSitekeys(check: TurnstileSitekeysCheck): string[] {
  const lines: string[] = [];
  const workers = [...new Set(check.unrendered.map((found) => found.worker))];
  for (const worker of workers) {
    const blank = check.unrendered.filter((found) => found.worker === worker && found.slot).map((f) => f.environment);
    const unreachable = check.unrendered
      .filter((found) => found.worker === worker && !found.slot)
      .map((found) => found.environment);
    if (blank.length > 0) {
      lines.push(
        `${worker}: no widget renders in ${listed(blank)}, so sign-in there is blocked. Run pithy turnstile provision --worker ${worker}, then redeploy.`,
      );
    }
    if (unreachable.length > 0) {
      lines.push(
        `${worker}: ${listed(unreachable)} ${unreachable.length === 1 ? "has" : "have"} no sitekey. Turnstile covers dev, staging, prod and a feature build, so sign-in there is blocked.`,
      );
    }
  }
  const files = [...new Set(check.stranded.map((found) => found.file))];
  for (const file of files) {
    const here = check.stranded.filter((found) => found.file === file);
    const names = here.map((found) => `${found.name} (${found.environment})`).join(", ");
    const them = here.length === 1 ? "it" : "them";
    const remover = here.find((found) => found.removedBy !== null)?.removedBy ?? null;
    lines.push(
      remover === null
        ? `${file}: ${names}. Nothing reads ${them}: the build reads the sitekey from pithy.config.ts. No pithy command edits this file for ${them}, so delete ${them} by hand.`
        : `${file}: ${names}. Nothing reads ${them}: the build reads the sitekey from pithy.config.ts. pithy turnstile provision --worker ${remover} writes it there and removes ${here.length === 1 ? "this" : "these"}.`,
    );
  }
  return lines;
}
