// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { resolveClientProjection } from "@pithy-sh/core/src/capability/client";
import { DEFAULT_ENVIRONMENTS, FEATURE_ENVIRONMENT, LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { isTurnstileCapability } from "@pithy-sh/turnstile/src/capability";
import { TURNSTILE_LOGIN_ACTION } from "@pithy-sh/turnstile/src/config/config";
import { isStrandedSitekeyVar } from "@pithy-sh/turnstile/src/provision/provisionTurnstile";
import { environmentsBuiltWithoutSitekeys } from "../capabilities/turnstileSitekeys";
import { bootstrapVarsPath, readBootstrapVars } from "../devSecrets/bootstrapVars";
import type { StatePathOptions } from "../notifier/state";
import { envStanzas, type WranglerStanza } from "../project/bindingEntries";
import { allCapabilities, loadWorkerConfig, projectEnvironments } from "../project/config";
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
 *   reach it at all: a declared environment beyond dev, staging and prod, or a feature build. Those have no
 *   remedy in the kit, and the line says what they are rather than inventing one.
 * - **A stranded `TURNSTILE_SITEKEY_*` var**, in a Worker's `wrangler.jsonc` (any stanza) or in the
 *   project's `dev.json`. #53's provisioner wrote them and nothing ever read them. `pithy turnstile
 *   provision` removes them; this names the file each one is in.
 *
 * ## What it reads, and what it does not see
 *
 * Files and one config import per Worker, no account call. **The projection is asked of the config as this
 * process composes it**, unstamped — a config that computes its sitekeys from `compositionEnvironment()` is
 * answered for whatever that returns here, not per environment. A feature build is reported only once the
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
  /** The Worker whose `wrangler.jsonc` holds it, or `null` for the project's `dev.json`. */
  worker: string | null;
  /** The var's name. */
  name: string;
  /** The stanza it is set in — `dev` for the top level and for `dev.json`. */
  environment: string;
  /** The absolute path of the file it is in. */
  file: string;
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

/** Every stranded var in one Worker's `wrangler.jsonc`, in stanza order. */
function strandedInWrangler(worker: string, file: string, config: unknown): StrandedSitekeyVarFinding[] {
  const found: StrandedSitekeyVarFinding[] = [];
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

/** Walk every Worker and the project's `dev.json`. Never throws. */
export async function checkTurnstileSitekeys(
  projectDir: string,
  options: { paths?: StatePathOptions } = {},
): Promise<TurnstileSitekeysCheck> {
  let workers: WorkerTarget[];
  try {
    workers = await discoverWorkers(projectDir);
  } catch {
    return { state: "could-not-check", stranded: [], unrendered: [] };
  }
  const declared = await projectEnvironments(projectDir).catch(() => [...DEFAULT_ENVIRONMENTS]);
  const withoutSlot = new Set(environmentsBuiltWithoutSitekeys(declared));

  const stranded: StrandedSitekeyVarFinding[] = [];
  const unrendered: UnrenderedTurnstile[] = [];
  let unreadable = false;

  for (const target of workers) {
    const worker = basename(target.dir);
    if (target.hasWrangler !== false) {
      const file = join(target.dir, "wrangler.jsonc");
      try {
        stranded.push(...strandedInWrangler(worker, file, await readWranglerConfig(target.dir)));
      } catch {
        unreadable = true;
      }
    }

    let capabilities: ReturnType<typeof allCapabilities>;
    try {
      capabilities = allCapabilities(await loadWorkerConfig(target.dir));
    } catch {
      // A Worker with no config, or one that throws: the health block names that. It costs this Worker its
      // widget verdict and nothing else — its stranded vars above were read off a different file.
      if (target.hasWrangler === true) unreadable = true;
      continue;
    }
    const turnstile = capabilities.find(isTurnstileCapability);
    // No login gate, no blocked sign-in: a Worker that protects only its own forms renders what it renders.
    if (turnstile?.turnstileConfig.protect[TURNSTILE_LOGIN_ACTION] === undefined) continue;
    for (const environment of await builtEnvironments(target, declared)) {
      if (withoutSlot.has(environment)) {
        unrendered.push({ worker, environment, slot: false });
        continue;
      }
      // The build's own resolver, so this answers what a bundle for this environment would inline.
      if (!resolveClientProjection(turnstile, { environment }).enabled) {
        unrendered.push({ worker, environment, slot: true });
      }
    }
  }

  const devJson = await bootstrapVarsPath(projectDir, options.paths ?? {}).catch(() => null);
  if (devJson !== null) {
    const recorded = await readBootstrapVars(projectDir, options.paths ?? {}).catch(() => ({}));
    for (const name of Object.keys(recorded).filter(isStrandedSitekeyVar)) {
      stranded.push({ worker: null, name, environment: LOCAL_ENVIRONMENT, file: devJson });
    }
  }

  if (stranded.length > 0 || unrendered.length > 0) return { state: "findings", stranded, unrendered };
  return { state: unreadable ? "could-not-check" : "ok", stranded: [], unrendered: [] };
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
        `${worker}: ${listed(unreachable)} ${unreachable.length === 1 ? "has" : "have"} no sitekey. Turnstile covers dev, staging and prod, so sign-in there is blocked.`,
      );
    }
  }
  const files = [...new Set(check.stranded.map((found) => found.file))];
  for (const file of files) {
    const here = check.stranded.filter((found) => found.file === file);
    const names = here.map((found) => `${found.name} (${found.environment})`).join(", ");
    lines.push(
      `${file}: ${names}. Nothing reads ${here.length === 1 ? "it" : "them"}: the build reads the sitekey from pithy.config.ts. pithy turnstile provision writes it there and removes ${here.length === 1 ? "this" : "these"}.`,
    );
  }
  return lines;
}
