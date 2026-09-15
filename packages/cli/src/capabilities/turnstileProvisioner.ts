// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import { dispatchSecretWrite, type SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import { validateSecretValue } from "@pithy-sh/secrets/src/cli/validate";
import { initialDevSecret } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { TurnstileMode } from "@pithy-sh/turnstile/src/config/config";
import {
  isStrandedSitekeyVar,
  type ManagedTurnstileEnv,
  type PlannedSitekeys,
  type ProvisionedSitekeys,
  productionWidgetName,
  type StrandedSitekeyVar,
  type TurnstileDeprovisioner,
  type TurnstileProvisioner,
} from "@pithy-sh/turnstile/src/provision/provisionTurnstile";
import {
  TURNSTILE_SECRET_NAME,
  type TurnstileSecrets,
  turnstileSecretsRegistry,
} from "@pithy-sh/turnstile/src/secret/registry";
import type { CliAuditEmit } from "../audit/cliAudit";
import { answerOnConfirmedAccount, type ConfirmedAccount, unconfirmedAccount } from "../cloudflare/accountAnswer";
import { readBootstrapVars, removeBootstrapVars } from "../devSecrets/bootstrapVars";
import { writeDevVars } from "../devSecrets/devVars";
import { removeDevSecrets, writeDevSecrets } from "../devSecrets/file";
import { resolveDevSecretsFile } from "../devSecrets/location";
import { renderDevVarsNotes } from "../devSecrets/report";
import { envStanzas, type WranglerStanza } from "../project/bindingEntries";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";
import { assertTurnstileSitekeysWritable, writeTurnstileSitekeys } from "./turnstileSitekeys";

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

/**
 * The routing facts the turnstile secret carries — a `d1`, per-environment, rotatable JSON value, and
 * not a `bootstrap` one: its value is an envelope every reader decodes rather than something read
 * straight off a binding before the store is open. Stated because a request states it (#517).
 */
const SECRET_FACTS = {
  backend: "d1",
  scope: "environment",
  bootstrap: false,
  rotatable: true,
  valueType: "json",
} as const;

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
  /** The project root — owner of `apps/`, and the key the dev secrets file and `dev.json` are found by. */
  projectDir: string;
  /**
   * The web-facing Worker's directory — the `--worker` target, and the only Worker this writes. Its
   * `pithy.config.ts` is where the sitekeys are written, because that is what its front-end build projects
   * from; its `wrangler.jsonc` is where an older provisioner stranded sitekey vars. Per-Worker, because the
   * widget is bound to the domain *that* Worker serves.
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

/** The stderr sink a delivery note goes to when a caller names none. See `notes` above. */
function stderrNotes(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Remove every `TURNSTILE_SITEKEY_*` var #53's provisioner left behind, from the one Worker's `wrangler.jsonc`
 * (every stanza, the top level included) and from the project's `dev.json` — and regenerate the Worker
 * `.dev.vars` files when `dev.json` changed, so the stale line leaves the file wrangler reads.
 *
 * **Shared by provision and teardown**, because both have to leave the same state: no sitekey anywhere but
 * the registration. A var is recognized by {@link isStrandedSitekeyVar} — by prefix, so one left for a mode
 * the config has since dropped is found too.
 */
async function removeStranded(
  projectDir: string,
  workerDir: string,
  notes: (line: string) => void,
): Promise<StrandedSitekeyVar[]> {
  const removed: StrandedSitekeyVar[] = [];
  const seen = new Set<string>();
  const record = (name: string, environment: string) => {
    const key = `${environment}\u0000${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    removed.push({ name, environment });
  };

  const config = (await readWranglerConfig(workerDir)) as WranglerStanza & { vars?: Record<string, unknown> };
  let wranglerChanged = false;
  for (const { env, stanza } of envStanzas(config)) {
    const vars = (stanza as { vars?: Record<string, unknown> }).vars;
    if (vars === undefined || vars === null || typeof vars !== "object") continue;
    for (const name of Object.keys(vars).filter(isStrandedSitekeyVar)) {
      delete vars[name];
      record(name, env);
      wranglerChanged = true;
    }
  }
  if (wranglerChanged) await writeWranglerConfig(workerDir, config);

  const devNames = Object.keys(await readBootstrapVars(projectDir)).filter(isStrandedSitekeyVar);
  if (devNames.length > 0) {
    await removeBootstrapVars(projectDir, devNames);
    for (const name of devNames) record(name, "dev");
    const wrote = await writeDevVars({ projectDir, values: {} });
    for (const note of renderDevVarsNotes(wrote)) notes(note);
  }
  return removed;
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
    this.#notes = options.notes ?? stderrNotes;
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
   * The dev widget's secret, into the dev secrets file.
   *
   * **The secret is a `d1` registry secret, so it goes into the dev secrets file (#149)** — through
   * `writeDevSecrets`, the one funnel every dev secret passes through, at `<config>/<project>/` since
   * #156. `replace`, because Cloudflare issued this value: keeping an older one because a value is already
   * there leaves the project verifying against a widget it no longer has.
   *
   * **No sitekey is written here any more (#590).** This used to record the dev sitekey in `dev.json` and
   * regenerate `.dev.vars` with it, where nothing read it: the front end gets its sitekey from the build,
   * which reads `pithy.config.ts`. {@link writeSitekeys} writes it there, for every environment at once.
   */
  async writeDev(secret: TurnstileSecrets): Promise<void> {
    // Through the registry entry, like every other writer: the entry is what says whether this
    // secret's destination takes an envelope or the value itself (#323), and — since #535 — whether
    // the value inside it is validated before a byte is written. The object, never a serialization of
    // it: a `json` secret states its own structure in this file, and the seeder serializes on the way
    // out (`devSecretsFile.ts`).
    const entry: SecretRegistryEntry | undefined = turnstileSecretsRegistry[TURNSTILE_SECRET_NAME];
    const envelope = initialDevSecret(entry ?? {}, secret);
    const path = await resolveDevSecretsFile(this.#projectDir);
    await writeDevSecrets(path, { [TURNSTILE_SECRET_NAME]: envelope }, { replace: true });
  }

  /**
   * The widget secret into one deployed environment's managed store, through the validator every other
   * managed write goes through.
   *
   * **`validateSecretValue` is not decoration here — it is the write-time check this path had never
   * had (#535).** A manager Workflow is a secure-but-dumb writer: it cannot hold the schema, because a
   * brand-new secret's registry entry is not bundled into any *deployed* manager yet
   * (`management/writeSecret.ts`). So the CLI is the authoritative validator, and `pithy secrets
   * create` has always called this. This writer composed the string itself and skipped it, which is
   * how one capability shipped a value its own registry refuses.
   */
  async writeManagedSecret(env: ManagedTurnstileEnv, secret: TurnstileSecrets): Promise<void> {
    const entry: SecretRegistryEntry | undefined = turnstileSecretsRegistry[TURNSTILE_SECRET_NAME];
    // The canonical serialization, from the parsed data — what the read seam's `parseValue` expects to
    // find in the envelope, and what a hand-run `pithy secrets create` would have put there.
    const value = entry
      ? validateSecretValue(entry, TURNSTILE_SECRET_NAME, JSON.stringify(secret))
      : JSON.stringify(secret);
    // Upsert: create on first provision, update on a re-run (create rejects an existing secret) — so the
    // write is idempotent. If create fails for a real reason, the update almost always fails too; surface
    // BOTH causes (create as `cause`) so the true failure isn't masked by the fallback's error.
    const write = { name: TURNSTILE_SECRET_NAME, ...SECRET_FACTS, value, requested: env as ManagedEnvironment };
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

  /**
   * Every environment's sitekey, into the target Worker's `turnstile(...)` registration — the build input
   * its front end projects from. Through {@link writeTurnstileSitekeys}, which writes string literals only
   * and refuses unless the loaded config then resolves exactly these values.
   */
  async writeSitekeys(sitekeys: ProvisionedSitekeys): Promise<void> {
    await writeTurnstileSitekeys({ workerDir: this.#workerDir, sitekeys });
  }

  /** See {@link removeStranded}. */
  async removeStrandedSitekeyVars(): Promise<StrandedSitekeyVar[]> {
    return removeStranded(this.#projectDir, this.#workerDir, this.#notes);
  }

  /**
   * The questions {@link writeSitekeys} refuses on, asked of the target Worker's config with nothing written —
   * through {@link assertTurnstileSitekeysWritable}, the writer's own planning step.
   */
  async assertSitekeysWritable(sitekeys: PlannedSitekeys): Promise<void> {
    await assertTurnstileSitekeysWritable({ workerDir: this.#workerDir, sitekeys });
  }

  /** This project's production widget for a mode, by name, or `null`. A lookup: it creates nothing. */
  async findProductionWidget(mode: TurnstileMode): Promise<{ sitekey: string } | null> {
    const existing = await this.#cf.turnstile().getTurnstile(productionWidgetName(this.#project, mode));
    return existing ? { sitekey: existing.sitekey } : null;
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
 * deployed environment and the dev secret, blanks the production sitekeys in `pithy.config.ts`, and removes
 * any stranded sitekey var. Each step is guarded so a missing resource is a no-op: teardown is idempotent.
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
  readonly #notes: (line: string) => void;

  constructor(options: CloudflareTurnstileProvisionerOptions) {
    this.#cf = options.cf;
    this.#project = options.project;
    this.#projectDir = options.projectDir;
    this.#workerDir = options.workerDir;
    this.#dispatcher = options.dispatcher;
    this.#environments = options.environments;
    this.#audit = options.audit ?? (async () => {});
    this.#notes = options.notes ?? stderrNotes;
  }

  /** See {@link CloudflareTurnstileProvisioner.assertSitekeysWritable}. */
  async assertSitekeysWritable(sitekeys: PlannedSitekeys): Promise<void> {
    await assertTurnstileSitekeysWritable({ workerDir: this.#workerDir, sitekeys });
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
   * What {@link CloudflareTurnstileProvisioner.writeDev} wrote — the secret in the dev secrets file. Leaving
   * the value there would have the next `pithy dev` seed a key for a widget that no longer exists.
   *
   * The secret's name is still passed to the bootstrap removal, and that is deliberate: a project provisioned
   * before #153 recorded the transitional copy, and teardown is the run that should take it. A name that
   * is not recorded is a no-op. The stranded sitekey vars are {@link removeStrandedSitekeyVars}'s.
   *
   * **The adopter's own `.dev.vars` is not touched.** Each Worker's is generated from the bootstrap set,
   * so taking the names out of that set is what drops the lines — and the project root's file, if there
   * is one, is theirs. See #154.
   */
  async clearDev(_modes: TurnstileMode[]): Promise<void> {
    await removeBootstrapVars(this.#projectDir, [TURNSTILE_SECRET_NAME]);
    await writeDevVars({ projectDir: this.#projectDir, values: {} });
    await removeDevSecrets(await resolveDevSecretsFile(this.#projectDir), [TURNSTILE_SECRET_NAME]);
  }

  /** Blank each mode's production sitekey in the target Worker's registration — the widget it named is gone. */
  async clearProductionSitekeys(modes: TurnstileMode[]): Promise<void> {
    const sitekeys: Partial<Record<TurnstileMode, { prod: string }>> = {};
    for (const mode of modes) sitekeys[mode] = { prod: "" };
    await writeTurnstileSitekeys({ workerDir: this.#workerDir, sitekeys });
  }

  /** See {@link removeStranded}. */
  async removeStrandedSitekeyVars(): Promise<StrandedSitekeyVar[]> {
    return removeStranded(this.#projectDir, this.#workerDir, this.#notes);
  }
}
