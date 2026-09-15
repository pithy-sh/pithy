// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { resourceName } from "@pithy-sh/core/src/naming/resource";
import { type TurnstileConfig, type TurnstileMode, TurnstileSitekeys } from "../config/config";
import type { TurnstileSecrets } from "../secret/registry";
import { TEST_SECRET, testSitekey } from "./testKeys";

/** The widget modes a config enables, in `visible`-then-`invisible` order. */
export function enabledModes(config: TurnstileConfig): TurnstileMode[] {
  const modes: TurnstileMode[] = [];
  if (config.widgets.visible) modes.push("visible");
  if (config.widgets.invisible) modes.push("invisible");
  return modes;
}

/** The deployed environments whose secret is written to the managed store (dev is local, via the dev secrets file). */
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

/**
 * The prefix of the Worker var #53's provisioner wrote each public sitekey under — `TURNSTILE_SITEKEY_VISIBLE`,
 * `TURNSTILE_SITEKEY_INVISIBLE` — into `env.<name>.vars` and the dev `.dev.vars`.
 *
 * **Nothing ever read those vars, and nothing writes them now (#590).** The sitekey is a build input: the
 * `pithy()` Vite plugin inlines the capability's client projection, and the projection reads
 * `widgets.<mode>.sitekeys` out of `pithy.config.ts`. A runtime var cannot reach a bundle that is already
 * built. So the name survives only to find what the old writer left behind — provisioning removes it and
 * `pithy doctor` reports it.
 */
export const STRANDED_SITEKEY_VAR_PREFIX = "TURNSTILE_SITEKEY_";

/**
 * Whether a var name is one the old sitekey writer produced.
 *
 * **By prefix, never built from the modes a config declares today.** A var left for a mode the config has
 * since dropped is exactly as stranded as one for a mode it still has, and a list derived from the current
 * modes would walk past it.
 */
export function isStrandedSitekeyVar(name: string): boolean {
  return name.startsWith(STRANDED_SITEKEY_VAR_PREFIX);
}

/** One stranded sitekey var a run found, and the environment whose vars held it (`dev` for the local set). */
export interface StrandedSitekeyVar {
  /** The var's name, e.g. `TURNSTILE_SITEKEY_VISIBLE`. */
  name: string;
  /** The environment it was set for — a wrangler stanza key, or `dev` for the top level and `dev.json`. */
  environment: string;
}

/**
 * The environments a sitekey can be stated for: the keys of {@link TurnstileSitekeys}, read off the schema.
 *
 * Read rather than written out, because this is the question "can a build for this environment render a
 * widget at all?", and the schema is what answers it — `TurnstileConfig` strips any other key, so a sitekey
 * written for `live` is gone before the projection looks.
 */
export const SITEKEY_ENVIRONMENTS: readonly string[] = TurnstileSitekeys.keyof().options;

/**
 * The environments in `environments` that no sitekey can be stated for — a declared environment beyond dev,
 * staging and prod, or a feature build. **A build for one renders no widget, and sign-in there is blocked.**
 * Nothing provisions them: no test key is accepted outside dev and staging, and the one real widget is
 * prod's. Named so a caller can say so, rather than leave the projection to answer `enabled: false` quietly.
 */
export function environmentsWithoutSitekeys(environments: readonly string[]): string[] {
  return [...new Set(environments)].filter((environment) => !SITEKEY_ENVIRONMENTS.includes(environment));
}

/** Every environment's public sitekey for each widget mode provisioning acted on. */
export type ProvisionedSitekeys = Partial<Record<TurnstileMode, TurnstileSitekeys>>;

/**
 * The sitekeys a run is about to write, per mode and environment — only the ones it means to write.
 *
 * `null` is a production widget's sitekey that Cloudflare has not issued yet, because the widget is still to
 * be created. It is a real state and not a missing value: no expression in a config can already resolve to
 * a sitekey nobody has, so only a string literal can take it.
 */
export type PlannedSitekeys = Partial<Record<TurnstileMode, Partial<Record<keyof TurnstileSitekeys, string | null>>>>;

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

/**
 * The sitekeys one widget renders with in each environment the config can state one for.
 *
 * dev and staging get the documented always-pass test sitekey, because those are the two environments the
 * test *secret* is written into and the only two the gate accepts a test key's answer in
 * (`TEST_KEY_ENVIRONMENTS`). prod gets the real widget's. The keys are the whole of `TurnstileSitekeys` —
 * written out rather than mapped, so a fourth key added to that schema is a compile error here instead of
 * an environment this quietly leaves blank.
 */
function sitekeysFor<Production extends string | null>(
  mode: TurnstileMode,
  productionSitekey: Production,
): { dev: string; staging: string; prod: Production } {
  return { dev: testSitekey(mode), staging: testSitekey(mode), [REAL_WIDGET_ENV]: productionSitekey };
}

/**
 * The side-effecting steps provisioning performs, injected so the orchestration is pure and unit-testable
 * (the live implementation lives in the CLI). The secret is the one `d1`, JSON turnstile secret read by the
 * middleware through `@pithy-sh/secrets` (CLAUDE.md §secrets); dev gets it via the dev secrets file,
 * deployed environments via the manager's write Workflow. Every step is idempotent.
 *
 * **A secret crosses this seam as a {@link TurnstileSecrets} object, never as a serialization of one
 * (#535).** Each destination encodes for itself — the dev secrets file states a `json` secret's own
 * structure, a managed write states the canonical string `validateSecretValue` produces — and the two
 * do not agree. This orchestrator serialized once, for both, so the dev file held a JSON string
 * containing JSON: a value `TurnstileSecrets` refuses at the root, because it is a `z.strictObject` and
 * what was stored is a string. Handing over the object leaves no encoding for a caller to get wrong.
 */
export interface TurnstileProvisioner {
  /**
   * Refuse the run when a widget **outside this project** already claims the production domain. Cloudflare
   * permits several widgets per domain; Pithy does not, because a second widget on one domain is almost
   * always someone's forgotten first attempt, and the two are indistinguishable to a front-end holding one
   * sitekey. This project's own widgets are the expected steady state and never trip it.
   */
  assertDomainAvailable(domain: string): Promise<void>;
  /** The production widget for a mode, if it already exists — a lookup by name that creates nothing. */
  findProductionWidget(mode: TurnstileMode): Promise<{ sitekey: string } | null>;
  /**
   * Refuse, **before anything is created or written**, when {@link writeSitekeys} would refuse these values:
   * a registration it cannot find, a key that is not a string literal and does not already resolve to the
   * value. Reads only. See {@link PlannedSitekeys} for `null`.
   */
  assertSitekeysWritable(sitekeys: PlannedSitekeys): Promise<void>;
  /** dev: upsert the turnstile secret into the dev secrets file. */
  writeDev(secret: TurnstileSecrets): Promise<void>;
  /** Write the turnstile secret to a deployed environment's managed store (via the manager). */
  writeManagedSecret(env: ManagedTurnstileEnv, secret: TurnstileSecrets): Promise<void>;
  /**
   * Write every environment's public sitekey into the `turnstile(...)` registration in the Worker's
   * `pithy.config.ts` — **the input the build projects from**, and so the one place a sitekey reaches a
   * browser from. Refuses, rather than returning, when what the config then says is not what was asked for.
   */
  writeSitekeys(sitekeys: ProvisionedSitekeys): Promise<void>;
  /** Remove every `TURNSTILE_SITEKEY_*` var an older provisioner left in Worker vars, and say which. */
  removeStrandedSitekeyVars(): Promise<StrandedSitekeyVar[]>;
  /** Reuse the production widget by name, else create it bound to the domain. `secret` is null on reuse. */
  ensureProductionWidget(mode: TurnstileMode, domain: string): Promise<{ sitekey: string; secret: string | null }>;
}

/** The inverse steps, for teardown — each guarded so a missing resource is a no-op. */
export interface TurnstileDeprovisioner {
  /** Refuse, before anything is deleted, when {@link clearProductionSitekeys} would refuse. Reads only. */
  assertSitekeysWritable(sitekeys: PlannedSitekeys): Promise<void>;
  /** Delete the production widget for a mode if it exists. */
  deleteProductionWidget(mode: TurnstileMode): Promise<void>;
  /** Delete the turnstile secret from every deployed environment's managed store. */
  deleteManagedSecret(): Promise<void>;
  /** Clear the turnstile secret from the dev secrets file. */
  clearDev(modes: TurnstileMode[]): Promise<void>;
  /**
   * Blank each mode's production sitekey in `pithy.config.ts` — the one value that names a widget teardown
   * just deleted. The test sitekeys stay: they are Cloudflare's published constants, and a re-provision
   * writes the same ones.
   */
  clearProductionSitekeys(modes: TurnstileMode[]): Promise<void>;
  /** Remove every `TURNSTILE_SITEKEY_*` var an older provisioner left in Worker vars. */
  removeStrandedSitekeyVars(): Promise<StrandedSitekeyVar[]>;
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
  /** Every environment's sitekey per mode, as written into `pithy.config.ts`. Public by definition. */
  sitekeys: ProvisionedSitekeys;
  /** The `TURNSTILE_SITEKEY_*` vars an older provisioner left behind, removed this run. */
  strandedVarsRemoved: StrandedSitekeyVar[];
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
 * (written per-environment — dev to the dev secrets file, staging to its managed store); **`prod`** gets a
 * real widget per mode, bound to the domain, its secret written to the production managed store. Then
 * every environment's public sitekey is written, in one edit, into the `turnstile(...)` registration the
 * build projects from — test sitekeys for dev and staging, the widget's for prod — and any sitekey var an
 * older provisioner stranded in Worker vars is removed.
 *
 * **The sitekeys are inlined at build time**, so nothing here reaches a deployed bundle until the Worker is
 * built and deployed again. The caller says so.
 *
 * Idempotent: a re-run reuses existing production widgets and skips the production secret write (whose
 * value can't be recovered from Cloudflare), while their sitekeys — which Cloudflare does return — are
 * written again. A *mixed* production state (some widgets exist, some do not) can't compose a consistent
 * secret, so it errors with guidance rather than write a half-secret.
 *
 * **Before anything is created or written**, three refusals are decided: a production domain a *foreign*
 * widget already covers (`allowSharedDomain` opts out), a mixed production state, and a sitekey the writer
 * would refuse. A refused run leaves the account and every file as it found them.
 */
export async function provisionTurnstile(
  provisioner: TurnstileProvisioner,
  plan: TurnstilePlan,
): Promise<TurnstileProvisionResult> {
  // **Everything that can refuse the run is decided before the first write** (#590 review). A domain a
  // foreign widget covers, a mixed production state, and a sitekey the writer cannot write are all readable
  // now, and each used to be found after a real widget was minted and its secret stored.
  if (!plan.allowSharedDomain) await provisioner.assertDomainAvailable(plan.productionDomain);

  const existing = new Map<TurnstileMode, { sitekey: string } | null>();
  for (const mode of plan.modes) existing.set(mode, await provisioner.findProductionWidget(mode));
  const found = [...existing.values()].filter((widget) => widget !== null).length;
  if (found > 0 && found < plan.modes.length) throw mixedProductionState();

  const planned: PlannedSitekeys = {};
  for (const mode of plan.modes) planned[mode] = sitekeysFor(mode, existing.get(mode)?.sitekey ?? null);
  await provisioner.assertSitekeysWritable(planned);

  const testSecret = buildSecrets(plan.modes, TEST_SECRET);

  await provisioner.writeDev(testSecret);
  await provisioner.writeManagedSecret("staging", testSecret);

  const widgets: ProvisionedWidget[] = [];
  const realSecrets: TurnstileSecrets = {};
  const sitekeys: ProvisionedSitekeys = {};
  for (const mode of plan.modes) {
    const { sitekey, secret } = await provisioner.ensureProductionWidget(mode, plan.productionDomain);
    sitekeys[mode] = sitekeysFor(mode, sitekey);
    widgets.push({ mode, sitekey, created: secret !== null });
    if (secret !== null) realSecrets[mode] = { key: secret };
  }

  // Checked again after the lookups above: a widget created or deleted by someone else in between is the
  // one way a run that read a consistent state can still end in a mixed one.
  const created = widgets.filter((widget) => widget.created).length;
  if (created > 0 && created < plan.modes.length) throw mixedProductionState();
  // All new → write the freshly-composed production secret. All reused → Cloudflare won't return the
  // existing widgets' secret, so it can't be recomposed and is left as-is (the caller warns).
  const productionSecretWritten = created === plan.modes.length;
  if (productionSecretWritten) {
    await provisioner.writeManagedSecret(REAL_WIDGET_ENV, realSecrets);
  }
  await provisioner.writeSitekeys(sitekeys);
  const strandedVarsRemoved = await provisioner.removeStrandedSitekeyVars();

  return { modes: plan.modes, widgets, productionSecretWritten, sitekeys, strandedVarsRemoved };
}

/** The refusal for production widgets some of which exist and some of which do not. */
function mixedProductionState(): ValidationError {
  return new ValidationError({
    message: "Turnstile production widgets are in a mixed state — some exist, some do not.",
    action: "Run `pithy turnstile deprovision`, then provision again to write a consistent production secret.",
  });
}

/**
 * Tear down Turnstile: delete each mode's production widget and the managed secret, clear the dev secret,
 * blank the production sitekeys in `pithy.config.ts`, and remove any stranded sitekey vars.
 */
export async function deprovisionTurnstile(
  deprovisioner: TurnstileDeprovisioner,
  modes: TurnstileMode[],
): Promise<{ modes: TurnstileMode[] }> {
  // Before the first delete, for the reason provisioning checks first: a refusal after the widgets and
  // secrets are gone leaves the prod sitekey naming a deleted widget and the stranded vars in place.
  const blanked: PlannedSitekeys = {};
  for (const mode of modes) blanked[mode] = { [REAL_WIDGET_ENV]: "" };
  await deprovisioner.assertSitekeysWritable(blanked);
  for (const mode of modes) {
    await deprovisioner.deleteProductionWidget(mode);
  }
  await deprovisioner.deleteManagedSecret();
  await deprovisioner.clearDev(modes);
  await deprovisioner.clearProductionSitekeys(modes);
  await deprovisioner.removeStrandedSitekeyVars();
  return { modes };
}
