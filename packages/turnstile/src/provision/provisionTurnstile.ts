// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { resourceName } from "@pithy-sh/core/src/naming/resource";
import type { TurnstileConfig, TurnstileMode } from "../config/config";
import type { TurnstileSecrets } from "../secret/registry";
import { TEST_SECRET, testSitekey } from "./testKeys";

/** The widget modes a config enables, in `visible`-then-`invisible` order. */
export function enabledModes(config: TurnstileConfig): TurnstileMode[] {
  const modes: TurnstileMode[] = [];
  if (config.widgets.visible) modes.push("visible");
  if (config.widgets.invisible) modes.push("invisible");
  return modes;
}

/** The deployed environments whose secret is written to the managed store (dev is local, via `.dev.vars`). */
export const MANAGED_ENVIRONMENTS = ["staging", "prod"] as const;
export type ManagedTurnstileEnv = (typeof MANAGED_ENVIRONMENTS)[number];

/**
 * The one environment a real widget is created for, named once rather than spelled at four call sites.
 *
 * It appears in the widget's own name, in the secret write, and in the sitekey write, and those three
 * have to agree: a widget provisioned under one environment and a secret written under another is a
 * production login page verifying against a key nobody holds.
 */
const REAL_WIDGET_ENV = "prod" satisfies ManagedTurnstileEnv;

/** The Worker var the public sitekey for a mode is surfaced under, for the front-end to render with. */
export function sitekeyVarName(mode: TurnstileMode): string {
  return `TURNSTILE_SITEKEY_${mode.toUpperCase()}`;
}

/**
 * The production widget's name: `<project>-prod-turnstile-<mode>` (docs/NAMING.md).
 *
 * Stable per project and mode, because provisioning is reuse-or-create **by name** — which is exactly
 * why the project segment is not optional. Turnstile widgets are account-scoped and the account's widget
 * list is flat, so an unscoped name means a second Pithy project in one account adopts the first's widget
 * and `turnstile deprovision` deletes it out from under them.
 *
 * `prod` sits in the environment slot because that is the environment this widget serves, and it is the
 * only one: dev and staging wire Cloudflare's documented test keys and create no widget at all. If a real
 * staging widget ever lands, it takes `staging` in the same slot and nothing else moves.
 *
 * **The generic composer rather than the facade**, and for the one reason the facade allows: a Turnstile
 * widget is not a namespace `@pithy-sh/core/src/naming/limits` carries a verified Cloudflare cap for.
 * The facade's premise is that a kind of thing brings its own number; inventing one here would be the
 * flaw it was built to remove. So this takes the conservative default until that namespace lands.
 */
export function productionWidgetName(project: string, mode: TurnstileMode): string {
  return resourceName({ project, env: REAL_WIDGET_ENV, thing: `turnstile-${mode}` });
}

/** Build the combined secret object for the enabled modes, all set to one key value. */
function buildSecrets(modes: TurnstileMode[], key: string): TurnstileSecrets {
  const secrets: TurnstileSecrets = {};
  for (const mode of modes) secrets[mode] = { key };
  return secrets;
}

/** The public test sitekeys for the enabled modes, keyed by their Worker var name. */
function testSitekeyVars(modes: TurnstileMode[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const mode of modes) vars[sitekeyVarName(mode)] = testSitekey(mode);
  return vars;
}

/**
 * The side-effecting steps provisioning performs, injected so the orchestration is pure and unit-testable
 * (the live implementation lives in the CLI). The secret is the one `d1`, JSON turnstile secret read by the
 * middleware through `@pithy-sh/secrets` (CLAUDE.md §secrets); dev gets it via `.dev.vars`, deployed
 * environments via the manager's write Workflow. Every step is idempotent.
 */
export interface TurnstileProvisioner {
  /**
   * Refuse the run when a widget **outside this project** already claims the production domain. Cloudflare
   * permits several widgets per domain; Pithy does not, because a second widget on one domain is almost
   * always someone's forgotten first attempt, and the two are indistinguishable to a front-end holding one
   * sitekey. This project's own widgets are the expected steady state and never trip it.
   */
  assertDomainAvailable(domain: string): Promise<void>;
  /** dev: upsert the turnstile secret (JSON) and the public sitekey vars into `.dev.vars`. */
  writeDev(secret: string, sitekeys: Record<string, string>): Promise<void>;
  /** Write the turnstile secret (JSON) to a deployed environment's managed store (via the manager). */
  writeManagedSecret(env: ManagedTurnstileEnv, secret: string): Promise<void>;
  /** Write the public sitekey vars into a deployed environment's worker vars. */
  writeManagedSitekeys(env: ManagedTurnstileEnv, sitekeys: Record<string, string>): Promise<void>;
  /** Reuse the production widget by name, else create it bound to the domain. `secret` is null on reuse. */
  ensureProductionWidget(mode: TurnstileMode, domain: string): Promise<{ sitekey: string; secret: string | null }>;
}

/** The inverse steps, for teardown — each guarded so a missing resource is a no-op. */
export interface TurnstileDeprovisioner {
  /** Delete the production widget for a mode if it exists. */
  deleteProductionWidget(mode: TurnstileMode): Promise<void>;
  /** Delete the turnstile secret from every deployed environment's managed store. */
  deleteManagedSecret(): Promise<void>;
  /** Clear the turnstile secret + sitekey vars from `.dev.vars`. */
  clearDev(modes: TurnstileMode[]): Promise<void>;
  /** Clear the sitekey vars from the deployed environments' worker vars. */
  clearManagedSitekeys(modes: TurnstileMode[]): Promise<void>;
}

/** What provisioning resolved for one widget mode. */
export interface ProvisionedWidget {
  mode: TurnstileMode;
  /** The production public sitekey. */
  sitekey: string;
  /** True if the production widget was created this run (false on idempotent reuse). */
  created: boolean;
}

export interface TurnstileProvisionResult {
  modes: TurnstileMode[];
  widgets: ProvisionedWidget[];
  /**
   * Whether the production secret was (re)written this run. False on idempotent reuse — Cloudflare never
   * returns an existing widget's secret, so it can't be recomposed; the caller should warn that an absent
   * production secret won't be healed by re-running (a deprovision + provision is needed).
   */
  productionSecretWritten: boolean;
}

/** The modes to provision and the production domain the real widget binds to. */
export interface TurnstilePlan {
  /** The enabled widget modes (from `config.widgets`). At least one. */
  modes: TurnstileMode[];
  /** The production domain the real widget is bound to (resolved from per-environment config). */
  productionDomain: string;
  /**
   * Provision even though a foreign widget already covers the domain (`--allow-shared-domain`). The
   * escape hatch for the one legitimate case: an adopter who already runs a hand-made widget on that
   * host and is not ready to retire it. Off by default — the refusal is the useful answer.
   */
  allowSharedDomain?: boolean;
}

/**
 * Provision Turnstile across environments. **dev and staging** get Cloudflare's documented test secret
 * (written per-environment — dev to `.dev.vars`, staging to its managed store); **`prod`** gets a real
 * widget per mode, bound to the domain, its secret written to the production managed store, and its public
 * sitekey to the production worker vars. Idempotent: a re-run reuses existing production widgets and skips
 * the production secret write (whose value can't be recovered from Cloudflare). A *mixed* production state
 * (some widgets new, some pre-existing) can't compose a consistent secret, so it errors with guidance
 * rather than write a half-secret. Before anything is written, a production domain a *foreign* widget
 * already covers is refused (`allowSharedDomain` opts out).
 */
export async function provisionTurnstile(
  provisioner: TurnstileProvisioner,
  plan: TurnstilePlan,
): Promise<TurnstileProvisionResult> {
  // First, before a single write: a domain already covered by a foreign widget is refused, so a refusal
  // leaves no half-wired `.dev.vars` or staging secret behind.
  if (!plan.allowSharedDomain) await provisioner.assertDomainAvailable(plan.productionDomain);

  const testSecret = JSON.stringify(buildSecrets(plan.modes, TEST_SECRET));
  const sitekeys = testSitekeyVars(plan.modes);

  await provisioner.writeDev(testSecret, sitekeys);
  await provisioner.writeManagedSecret("staging", testSecret);
  await provisioner.writeManagedSitekeys("staging", sitekeys);

  const widgets: ProvisionedWidget[] = [];
  const realSecrets: TurnstileSecrets = {};
  const prodSitekeys: Record<string, string> = {};
  for (const mode of plan.modes) {
    const { sitekey, secret } = await provisioner.ensureProductionWidget(mode, plan.productionDomain);
    prodSitekeys[sitekeyVarName(mode)] = sitekey;
    widgets.push({ mode, sitekey, created: secret !== null });
    if (secret !== null) realSecrets[mode] = { key: secret };
  }

  const created = widgets.filter((widget) => widget.created).length;
  if (created > 0 && created < plan.modes.length) {
    throw new ValidationError({
      message: "Turnstile production widgets are in a mixed state — some exist, some were just created.",
      action: "Run `pithy turnstile deprovision`, then provision again to write a consistent production secret.",
    });
  }
  // All new → write the freshly-composed production secret. All reused → Cloudflare won't return the
  // existing widgets' secret, so it can't be recomposed and is left as-is (the caller warns).
  const productionSecretWritten = created === plan.modes.length;
  if (productionSecretWritten) {
    await provisioner.writeManagedSecret(REAL_WIDGET_ENV, JSON.stringify(realSecrets));
  }
  await provisioner.writeManagedSitekeys(REAL_WIDGET_ENV, prodSitekeys);

  return { modes: plan.modes, widgets, productionSecretWritten };
}

/** Tear down Turnstile: delete each mode's production widget, the managed secret, and all config entries. */
export async function deprovisionTurnstile(
  deprovisioner: TurnstileDeprovisioner,
  modes: TurnstileMode[],
): Promise<{ modes: TurnstileMode[] }> {
  for (const mode of modes) {
    await deprovisioner.deleteProductionWidget(mode);
  }
  await deprovisioner.deleteManagedSecret();
  await deprovisioner.clearDev(modes);
  await deprovisioner.clearManagedSitekeys(modes);
  return { modes };
}
