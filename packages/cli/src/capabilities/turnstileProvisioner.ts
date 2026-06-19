import { join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { dispatchSecretWrite, type SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { TurnstileMode } from "@pithy-sh/turnstile/src/config/config";
import {
  type ManagedTurnstileEnv,
  productionWidgetName,
  sitekeyVarName,
  type TurnstileDeprovisioner,
  type TurnstileProvisioner,
} from "@pithy-sh/turnstile/src/provision/provisionTurnstile";
import { TURNSTILE_SECRET_NAME } from "@pithy-sh/turnstile/src/secret/registry";
import { removeDevVars, upsertDevVars } from "../project/devVars";
import { readWranglerConfig, type WranglerEnvVars, writeWranglerConfig } from "../project/wrangler";

/** The message of an unknown thrown value, for surfacing both legs of a failed upsert. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A Cloudflare *managed* (visible) or *invisible* widget — the CF API's terms for our two modes. */
function cloudflareMode(mode: TurnstileMode): "managed" | "invisible" {
  return mode === "visible" ? "managed" : "invisible";
}

/** The routing facts the turnstile secret carries — a `d1`, per-environment, rotatable JSON value. */
const SECRET_FACTS = { backend: "d1", scope: "environment", rotatable: true, valueType: "json" } as const;

export interface CloudflareTurnstileProvisionerOptions {
  cf: CloudflareClients;
  /** The project root — where `.dev.vars` and `wrangler.jsonc` live. */
  projectDir: string;
  /** The secrets manager dispatcher — writes/deletes the secret in a deployed env's managed store. */
  dispatcher: SecretDispatcher;
}

/**
 * The live {@link TurnstileProvisioner}. The widget secret is written like any other secret — `.dev.vars`
 * for dev, the per-environment manager Workflow for staging/production (CLAUDE.md §secrets) — and the real
 * production widget is created through `@pithy-sh/cloudflare`. dev/managed-sitekey writes are idempotent
 * file upserts; the managed secret write upserts (create, else update); widget creation reuses by name.
 */
export class CloudflareTurnstileProvisioner implements TurnstileProvisioner {
  readonly #cf: CloudflareClients;
  readonly #projectDir: string;
  readonly #dispatcher: SecretDispatcher;

  constructor(options: CloudflareTurnstileProvisionerOptions) {
    this.#cf = options.cf;
    this.#projectDir = options.projectDir;
    this.#dispatcher = options.dispatcher;
  }

  async writeDev(secret: string, sitekeys: Record<string, string>): Promise<void> {
    await upsertDevVars(join(this.#projectDir, ".dev.vars"), { [TURNSTILE_SECRET_NAME]: secret, ...sitekeys });
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
    await editEnvVars(this.#projectDir, env, (vars) => Object.assign(vars, sitekeys));
  }

  async ensureProductionWidget(
    mode: TurnstileMode,
    domain: string,
  ): Promise<{ sitekey: string; secret: string | null }> {
    const name = productionWidgetName(mode);
    const existing = await this.#cf.turnstile().getTurnstile(name);
    if (existing) return { sitekey: existing.sitekey, secret: null };
    const created = await this.#cf.turnstile().addTurnstile(name, [domain], cloudflareMode(mode));
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
  readonly #projectDir: string;
  readonly #dispatcher: SecretDispatcher;

  constructor(options: CloudflareTurnstileProvisionerOptions) {
    this.#cf = options.cf;
    this.#projectDir = options.projectDir;
    this.#dispatcher = options.dispatcher;
  }

  async deleteProductionWidget(mode: TurnstileMode): Promise<void> {
    const existing = await this.#cf.turnstile().getTurnstile(productionWidgetName(mode));
    if (existing) await this.#cf.turnstile().deleteTurnstile(existing.sitekey);
  }

  async deleteManagedSecret(): Promise<void> {
    for (const env of ["staging", "production"] as const) {
      // Delete is idempotent in the manager (a missing name is a no-op), so this is safe to re-run.
      await dispatchSecretWrite(this.#dispatcher, {
        mode: "delete",
        name: TURNSTILE_SECRET_NAME,
        ...SECRET_FACTS,
        requested: env,
      });
    }
  }

  async clearDev(modes: TurnstileMode[]): Promise<void> {
    const keys = [TURNSTILE_SECRET_NAME, ...modes.map((mode) => sitekeyVarName(mode))];
    await removeDevVars(join(this.#projectDir, ".dev.vars"), keys);
  }

  async clearManagedSitekeys(modes: TurnstileMode[]): Promise<void> {
    const keys = modes.map((mode) => sitekeyVarName(mode));
    for (const env of ["staging", "production"] as const) {
      await editEnvVars(this.#projectDir, env, (vars) => {
        for (const key of keys) delete vars[key];
      });
    }
  }
}

/** Read `wrangler.jsonc`, mutate its `env.<env>.vars` map, and write it back comment-preserving. */
async function editEnvVars(
  projectDir: string,
  env: ManagedTurnstileEnv,
  mutate: (vars: Record<string, string>) => void,
): Promise<void> {
  const config = (await readWranglerConfig(projectDir)) as WranglerEnvVars;
  config.env ??= {};
  config.env[env] ??= {};
  const stanza = config.env[env];
  if (stanza) {
    stanza.vars ??= {};
    mutate(stanza.vars);
  }
  await writeWranglerConfig(projectDir, config);
}
