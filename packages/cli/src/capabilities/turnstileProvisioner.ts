// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { dispatchSecretWrite, type SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import { encodeVersionedValue, initialVersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { DEV_SECRETS_FILE, initialDevSecret } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { TurnstileMode } from "@pithy-sh/turnstile/src/config/config";
import {
  type ManagedTurnstileEnv,
  productionWidgetName,
  sitekeyVarName,
  type TurnstileDeprovisioner,
  type TurnstileProvisioner,
} from "@pithy-sh/turnstile/src/provision/provisionTurnstile";
import { TURNSTILE_SECRET_NAME } from "@pithy-sh/turnstile/src/secret/registry";
import type { CliAuditEmit } from "../audit/cliAudit";
import { writeDevVars } from "../devSecrets/devVars";
import { removeDevSecrets, writeDevSecrets } from "../devSecrets/file";
import { removeDevVars } from "../project/devVars";
import { readWranglerConfig, type WranglerEnvVars, writeWranglerConfig } from "../project/wrangler";

/** The message of an unknown thrown value, for surfacing both legs of a failed upsert. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A Cloudflare *managed* (visible) or *invisible* widget — the CF API's terms for our two modes. */
function cloudflareMode(mode: TurnstileMode): "managed" | "invisible" {
  return mode === "visible" ? "managed" : "invisible";
}

/**
 * Every widget name this project can own — one per mode, whether or not config enables both.
 *
 * The domain guard subtracts this set rather than matching the one mode being provisioned: a project
 * running a visible *and* an invisible widget has two of its own widgets on the domain, and the second
 * pass must not read the first as a squatter. Deriving it from `TurnstileMode` keeps it whole even when
 * config later enables a mode a previous run already created.
 */
function ourWidgetNames(project: string): Set<string> {
  return new Set(TurnstileMode.options.map((mode) => productionWidgetName(project, mode)));
}

/** The routing facts the turnstile secret carries — a `d1`, per-environment, rotatable JSON value. */
const SECRET_FACTS = { backend: "d1", scope: "environment", rotatable: true, valueType: "json" } as const;

export interface CloudflareTurnstileProvisionerOptions {
  cf: CloudflareClients;
  /**
   * The project name from the root `pithy.config.ts`, resolved by `requireProjectName` and never
   * guessed. It is the leading segment of every widget name, so a wrong value here reuses — and on
   * teardown deletes — another project's widget (docs/NAMING.md).
   */
  project: string;
  /**
   * The project root — owner of the one shared `.dev.vars` every worker symlinks to, so a dev sitekey
   * written here reaches every worker at once.
   */
  projectDir: string;
  /**
   * The web-facing Worker's directory — its `wrangler.jsonc` is where the per-environment sitekey vars are
   * written. Per-Worker, because the widget is bound to the domain *that* Worker serves (`BASE_URL`).
   */
  workerDir: string;
  /** The secrets manager dispatcher — writes/deletes the secret in a deployed env's managed store. */
  dispatcher: SecretDispatcher;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}

/**
 * The live {@link TurnstileProvisioner}. The widget secret is written like any other secret — `.dev.vars`
 * for dev, the per-environment manager Workflow for staging/prod (CLAUDE.md §secrets) — and the real
 * production widget is created through `@pithy-sh/cloudflare`. dev/managed-sitekey writes are idempotent
 * file upserts; the managed secret write upserts (create, else update); widget creation reuses by name.
 */
export class CloudflareTurnstileProvisioner implements TurnstileProvisioner {
  readonly #cf: CloudflareClients;
  readonly #project: string;
  readonly #projectDir: string;
  readonly #workerDir: string;
  readonly #dispatcher: SecretDispatcher;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareTurnstileProvisionerOptions) {
    this.#cf = options.cf;
    this.#project = options.project;
    this.#projectDir = options.projectDir;
    this.#workerDir = options.workerDir;
    this.#dispatcher = options.dispatcher;
    this.#audit = options.audit ?? (async () => {});
  }

  async assertDomainAvailable(domain: string): Promise<void> {
    const ours = ourWidgetNames(this.#project);
    const claimants = await this.#cf.turnstile().listTurnstilesByDomain(domain);
    const foreign = claimants.find((widget) => !ours.has(widget.name));
    if (!foreign) return;
    throw new ValidationError({
      message: `A Turnstile widget named "${foreign.name}" already covers ${domain}.`,
      action: "Bind this project to a different domain, delete that widget, or re-run with --allow-shared-domain.",
      detail: `sitekey ${foreign.sitekey} claims ${domain}; this project's widgets are ${[...ours].join(", ")}`,
    });
  }

  /**
   * The dev widget's secret and its public sitekeys, each into the file its namespace belongs to.
   *
   * **The secret is a `d1` registry secret, so it goes into `.dev.secrets.jsonc` (#149)** — through
   * `writeDevSecrets`, which is where the guarantee lives that the file is gitignored *before* a value
   * is written into it. Writing it straight into `.dev.vars` bypassed both, and made this the fifth
   * producer of the same defect. `replace`, because Cloudflare issued this value: keeping an older one
   * because a value is already there leaves the project verifying against a widget it no longer has.
   *
   * **A refused write fails the provision.** Every other refusal in the kit is a note, because the
   * command still did most of its job; here the command's entire job is to place a credential, and
   * placing it in a file git will commit is worse than stopping with the two lines to add.
   *
   * The sitekeys are public, `UPPER_SNAKE`, and wrangler's — they stay in `.dev.vars`, along with the
   * transitional copy of the secret itself, which is where dev still resolves it from until #153.
   */
  async writeDev(secret: string, sitekeys: Record<string, string>): Promise<void> {
    const envelope = initialDevSecret(secret);
    const written = await writeDevSecrets(this.#projectDir, { [TURNSTILE_SECRET_NAME]: envelope }, { replace: true });
    if (written.refused) {
      throw new ValidationError({
        message: `The turnstile dev secret was not written. ${written.refused}`,
        action: `Add the two lines to .gitignore, then run pithy turnstile provision again.`,
        detail: `turnstile dev secret refused: ${DEV_SECRETS_FILE} is not covered by .gitignore`,
      });
    }
    // TRANSITION (#153): the envelope, injected, because dev resolves every secret from its binding
    // whatever its backend. Encoded — the same bytes the store holds — and through `writeDevVars`, so
    // the value is quoted for dotenv and reaches the Worker's own directory rather than the root alone.
    await writeDevVars({
      projectDir: this.#projectDir,
      values: { [TURNSTILE_SECRET_NAME]: encodeVersionedValue(initialVersionedValue(secret)), ...sitekeys },
    });
  }

  async writeManagedSecret(env: ManagedTurnstileEnv, secret: string): Promise<void> {
    // Upsert: create on first provision, update on a re-run (create rejects an existing secret) — so the
    // write is idempotent. If create fails for a real reason, the update almost always fails too; surface
    // BOTH causes (create as `cause`) so the true failure isn't masked by the fallback's error.
    const write = { name: TURNSTILE_SECRET_NAME, ...SECRET_FACTS, value: secret, requested: env as ManagedEnvironment };
    try {
      await dispatchSecretWrite(this.#dispatcher, { mode: "create", ...write });
    } catch (createError) {
      try {
        await dispatchSecretWrite(this.#dispatcher, { mode: "update", ...write });
      } catch (updateError) {
        throw new InternalError(
          {
            message: `Could not write the turnstile secret to ${env}.`,
            detail: `create failed: ${errorMessage(createError)}; update failed: ${errorMessage(updateError)}`,
          },
          { cause: createError },
        );
      }
    }
  }

  async writeManagedSitekeys(env: ManagedTurnstileEnv, sitekeys: Record<string, string>): Promise<void> {
    await editEnvVars(this.#workerDir, env, (vars) => Object.assign(vars, sitekeys));
  }

  async ensureProductionWidget(
    mode: TurnstileMode,
    domain: string,
  ): Promise<{ sitekey: string; secret: string | null }> {
    const name = productionWidgetName(this.#project, mode);
    const existing = await this.#cf.turnstile().getTurnstile(name);
    if (existing) return { sitekey: existing.sitekey, secret: null };
    const created = await this.#cf.turnstile().addTurnstile(name, [domain], cloudflareMode(mode));
    await this.#audit({
      action: "turnstile/widget_created",
      outcome: "success",
      severity: "info",
      resourceType: "turnstile_widget",
      resourceId: created.sitekey,
      metadata: { name, mode, domain },
    });
    return { sitekey: created.sitekey, secret: created.secret };
  }
}

/**
 * The live {@link TurnstileDeprovisioner} — deletes each production widget, the managed secret in every
 * deployed environment, and every config entry (dev-vars + managed sitekey vars). Each step is guarded so
 * a missing resource is a no-op: teardown is idempotent.
 */
export class CloudflareTurnstileDeprovisioner implements TurnstileDeprovisioner {
  readonly #cf: CloudflareClients;
  readonly #project: string;
  readonly #projectDir: string;
  readonly #workerDir: string;
  readonly #dispatcher: SecretDispatcher;
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareTurnstileProvisionerOptions) {
    this.#cf = options.cf;
    this.#project = options.project;
    this.#projectDir = options.projectDir;
    this.#workerDir = options.workerDir;
    this.#dispatcher = options.dispatcher;
    this.#audit = options.audit ?? (async () => {});
  }

  async deleteProductionWidget(mode: TurnstileMode): Promise<void> {
    const name = productionWidgetName(this.#project, mode);
    const existing = await this.#cf.turnstile().getTurnstile(name);
    if (!existing) return;
    await this.#cf.turnstile().deleteTurnstile(existing.sitekey);
    await this.#audit({
      action: "turnstile/widget_deleted",
      outcome: "success",
      severity: "warning",
      resourceType: "turnstile_widget",
      resourceId: existing.sitekey,
      metadata: { name, mode },
    });
  }

  async deleteManagedSecret(): Promise<void> {
    for (const env of ["staging", "prod"] as const) {
      // Delete is idempotent in the manager (a missing name is a no-op), so this is safe to re-run.
      await dispatchSecretWrite(this.#dispatcher, {
        mode: "delete",
        name: TURNSTILE_SECRET_NAME,
        ...SECRET_FACTS,
        requested: env,
      });
    }
  }

  /**
   * Both halves of what {@link CloudflareTurnstileProvisioner.writeDev} wrote — the secret in
   * `.dev.secrets.jsonc` as well as the `.dev.vars` lines. Leaving the value in the secrets file would
   * have the next `pithy dev` seed and re-inject a key for a widget that no longer exists.
   */
  async clearDev(modes: TurnstileMode[]): Promise<void> {
    const keys = [TURNSTILE_SECRET_NAME, ...modes.map((mode) => sitekeyVarName(mode))];
    await removeDevVars(join(this.#projectDir, ".dev.vars"), keys);
    await removeDevSecrets(this.#projectDir, [TURNSTILE_SECRET_NAME]);
  }

  async clearManagedSitekeys(modes: TurnstileMode[]): Promise<void> {
    const keys = modes.map((mode) => sitekeyVarName(mode));
    for (const env of ["staging", "prod"] as const) {
      await editEnvVars(this.#workerDir, env, (vars) => {
        for (const key of keys) delete vars[key];
      });
    }
  }
}

/** Read the Worker's `wrangler.jsonc`, mutate its `env.<env>.vars` map, and write it back comment-preserving. */
async function editEnvVars(
  workerDir: string,
  env: ManagedTurnstileEnv,
  mutate: (vars: Record<string, string>) => void,
): Promise<void> {
  const config = (await readWranglerConfig(workerDir)) as WranglerEnvVars;
  config.env ??= {};
  config.env[env] ??= {};
  const stanza = config.env[env];
  if (stanza) {
    stanza.vars ??= {};
    mutate(stanza.vars);
  }
  await writeWranglerConfig(workerDir, config);
}
