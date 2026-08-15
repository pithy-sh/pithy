// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import { dispatchSecretWrite, type SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import { initialDevSecret } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { TurnstileMode } from "@pithy-sh/turnstile/src/config/config";
import {
  type ManagedTurnstileEnv,
  productionWidgetName,
  sitekeyVarName,
  type TurnstileDeprovisioner,
  type TurnstileProvisioner,
} from "@pithy-sh/turnstile/src/provision/provisionTurnstile";
import { TURNSTILE_SECRET_NAME, turnstileSecretsRegistry } from "@pithy-sh/turnstile/src/secret/registry";
import type { CliAuditEmit } from "../audit/cliAudit";
import { answerOnConfirmedAccount, type ConfirmedAccount, unconfirmedAccount } from "../cloudflare/accountAnswer";
import { removeBootstrapVars } from "../devSecrets/bootstrapVars";
import { writeDevVars } from "../devSecrets/devVars";
import { removeDevSecrets, writeDevSecrets } from "../devSecrets/file";
import { resolveDevSecretsFile } from "../devSecrets/location";
import { renderDevVarsNotes } from "../devSecrets/report";
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
   * The account the production widget is created in, and what vouches for it (#378).
   *
   * `assertDomainAvailable` reads an empty listing as "the domain is free" and provisioning then mints a
   * real widget. Against an account nothing claims, that listing is empty because the widgets it would
   * have named are somewhere else — so the guard passes for the wrong reason and a live widget lands in a
   * stranger's account.
   */
  account: ConfirmedAccount;
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
  /**
   * Where a delivery note goes. Defaults to **stderr**, one line at a time.
   *
   * `writeDev` returns `void` — the interface in `@pithy-sh/turnstile` says so — and that is precisely
   * how the report got dropped: there was nowhere to return it to, so it was discarded and the provision
   * reported a delivery that had not happened. A seam, so a test can read the lines; stderr by default,
   * because the alternative to a default is silence, and because `--json` writes its one line to stdout
   * and a diagnostic must not land in the middle of it.
   *
   * Never a value. See `renderDevVarsNotes`.
   */
  notes?: (line: string) => void;
  /** Every environment this project declares, from the root `pithy.config.ts` — the fan-out set for a `global` secret. */
  environments: DeclaredEnvironments | readonly string[];
}

/**
 * The live {@link TurnstileProvisioner}. The widget secret is written like any other secret — `.dev.vars`
 * for dev, the per-environment manager Workflow for staging/prod (CLAUDE.md §secrets) — and the real
 * production widget is created through `@pithy-sh/cloudflare`. dev/managed-sitekey writes are idempotent
 * file upserts; the managed secret write upserts (create, else update); widget creation reuses by name.
 */
export class CloudflareTurnstileProvisioner implements TurnstileProvisioner {
  readonly #cf: CloudflareClients;
  readonly #account: ConfirmedAccount;
  readonly #project: string;
  readonly #projectDir: string;
  readonly #workerDir: string;
  readonly #dispatcher: SecretDispatcher;
  /**
   * The project's declared environments (#241) — what a `global` secret write fans out across. Carried
   * rather than assumed, so a shared secret reaches every environment the project deploys to.
   */
  readonly #environments: DeclaredEnvironments | readonly string[];
  readonly #audit: CliAuditEmit;
  readonly #notes: (line: string) => void;

  constructor(options: CloudflareTurnstileProvisionerOptions) {
    this.#cf = options.cf;
    this.#account = options.account;
    this.#project = options.project;
    this.#projectDir = options.projectDir;
    this.#workerDir = options.workerDir;
    this.#dispatcher = options.dispatcher;
    this.#environments = options.environments;
    this.#audit = options.audit ?? (async () => {});
    this.#notes = options.notes ?? ((line: string) => void process.stderr.write(`${line}\n`));
  }

  /**
   * Refuse the domain if a widget that is not ours already covers it — and refuse the *question* if the
   * account that would answer it is one nothing claims (#378).
   *
   * The two failures are opposite in shape and identical on the wire. A foreign widget is a listing with
   * an entry in it; an unconfirmed account is a listing with nothing in it, which is the same thing "the
   * domain is free" looks like. Only one of those two empties is a fact, and the other one ends with a
   * live production widget in an account this project never named.
   */
  async assertDomainAvailable(domain: string): Promise<void> {
    const ours = ourWidgetNames(this.#project);
    const answer = await answerOnConfirmedAccount({
      ...this.#account,
      what: `Turnstile widgets covering ${domain}`,
      find: () => this.#cf.turnstile().listTurnstilesByDomain(domain),
    });
    if (answer.state === "unconfirmed")
      throw unconfirmedAccount(answer.accountId, `Turnstile widgets covering ${domain}`);
    const claimants = answer.state === "found" ? answer.value : [];
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
   * **The secret is a `d1` registry secret, so it goes into the dev secrets file (#149)** — through
   * `writeDevSecrets`, the one funnel every dev secret passes through, at `<config>/<project>/` since
   * #156. Writing it straight into `.dev.vars` bypassed the format and the mode both, and made this the
   * fifth producer of the same defect. `replace`, because Cloudflare issued this value: keeping an older
   * one because a value is already there leaves the project verifying against a widget it no longer has.
   *
   * The sitekeys are public, `UPPER_SNAKE`, and wrangler's — they stay in `.dev.vars`, and they are now
   * the only thing this writes there. The secret itself was copied alongside them until #153, because
   * dev resolved every secret from its binding whatever its backend; dev reads the seeded row now, so
   * the copy is gone and a public sitekey no longer shares a file with a widget secret.
   *
   * **And what that write says is said, not dropped.** This call took no result at all, so a provision
   * announced a delivery that may never have happened: a Worker with a `.dev.vars` of its own gets no
   * sitekey and no secret, and `pithy turnstile provision` still printed "Test secret wired for dev".
   * The same defect fixed at `pithy add`'s two call sites, in the third one nobody checked — three
   * producers again, so it goes through the one renderer they share.
   */
  async writeDev(secret: string, sitekeys: Record<string, string>): Promise<void> {
    // Through the registry entry, like every other writer: the entry is what says whether this
    // secret's destination takes an envelope or the value itself (#323).
    const entry: SecretRegistryEntry | undefined = turnstileSecretsRegistry[TURNSTILE_SECRET_NAME];
    const envelope = initialDevSecret(entry ?? {}, secret);
    const path = await resolveDevSecretsFile(this.#projectDir);
    await writeDevSecrets(path, { [TURNSTILE_SECRET_NAME]: envelope }, { replace: true });
    // The sitekeys alone, through `writeDevVars` — so each is quoted for dotenv and reaches the Worker's
    // own directory rather than the project root alone. The secret goes to the store, on the next seed.
    const wrote = await writeDevVars({ projectDir: this.#projectDir, values: { ...sitekeys } });
    for (const note of renderDevVarsNotes(wrote)) this.#notes(note);
  }

  async writeManagedSecret(env: ManagedTurnstileEnv, secret: string): Promise<void> {
    // Upsert: create on first provision, update on a re-run (create rejects an existing secret) — so the
    // write is idempotent. If create fails for a real reason, the update almost always fails too; surface
    // BOTH causes (create as `cause`) so the true failure isn't masked by the fallback's error.
    const write = { name: TURNSTILE_SECRET_NAME, ...SECRET_FACTS, value: secret, requested: env as ManagedEnvironment };
    try {
      await dispatchSecretWrite(this.#dispatcher, { mode: "create", ...write }, this.#environments);
    } catch (createError) {
      try {
        await dispatchSecretWrite(this.#dispatcher, { mode: "update", ...write }, this.#environments);
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
  /**
   * The project's declared environments (#241) — what a `global` secret write fans out across. Carried
   * rather than assumed, so a shared secret reaches every environment the project deploys to.
   */
  readonly #environments: DeclaredEnvironments | readonly string[];
  readonly #audit: CliAuditEmit;

  constructor(options: CloudflareTurnstileProvisionerOptions) {
    this.#cf = options.cf;
    this.#project = options.project;
    this.#projectDir = options.projectDir;
    this.#workerDir = options.workerDir;
    this.#dispatcher = options.dispatcher;
    this.#environments = options.environments;
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
    // The project's declaration, not a hardcoded pair: a project that deploys to `live` had its secret
    // written there and would have kept it forever, because teardown only ever looked at two names.
    for (const env of this.#environments) {
      // Delete is idempotent in the manager (a missing name is a no-op), so this is safe to re-run.
      await dispatchSecretWrite(
        this.#dispatcher,
        {
          mode: "delete",
          name: TURNSTILE_SECRET_NAME,
          ...SECRET_FACTS,
          requested: env,
        },
        this.#environments,
      );
    }
  }

  /**
   * Both halves of what {@link CloudflareTurnstileProvisioner.writeDev} wrote — the secret in the dev
   * secrets file, and the sitekeys in `.dev.vars`. Leaving the value in the secrets file would have the
   * next `pithy dev` seed a key for a widget that no longer exists.
   *
   * The secret's name is still passed to the removal, and that is deliberate: a project provisioned
   * before #153 recorded the transitional copy, and teardown is the run that should take it. A name that
   * is not recorded is a no-op.
   *
   * **The adopter's own `.dev.vars` is not touched.** Each Worker's is generated from the bootstrap set,
   * so taking the names out of that set is what drops the lines — and the project root's file, if there
   * is one, is theirs. See #154.
   */
  async clearDev(modes: TurnstileMode[]): Promise<void> {
    const keys = [TURNSTILE_SECRET_NAME, ...modes.map((mode) => sitekeyVarName(mode))];
    await removeBootstrapVars(this.#projectDir, keys);
    await writeDevVars({ projectDir: this.#projectDir, values: {} });
    await removeDevSecrets(await resolveDevSecretsFile(this.#projectDir), [TURNSTILE_SECRET_NAME]);
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
