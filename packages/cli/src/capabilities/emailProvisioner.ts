import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { email_0001_suppressions } from "@pithy-sh/email/src/migrations/0001_suppressions";
import {
  type EmailDeprovisioner,
  type EmailProvisioner,
  emailWorkerName,
  SUPPRESSION_DB_NAME,
} from "@pithy-sh/email/src/provision/provisionEmail";
import { type EmailWorkerWranglerTemplate, resolveEmailConfig } from "@pithy-sh/email/src/provision/resolveEmailConfig";
import type { EmailTheme } from "@pithy-sh/email/src/templates/theme";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { parse } from "comment-json";
import type { MigrationProvider } from "kysely/migration";
import { runWrangler } from "../project/wrangler";

/** The suppression migration set, as provisioning runs it against the shared suppression D1. */
function suppressionMigrationProvider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "emailSuppressions",
      namespace: "email",
      order: 100,
      migrations: { "0001_suppressions": email_0001_suppressions },
    },
  ]);
  const provider = registry.emailSuppressions;
  if (!provider) throw new Error("missing email suppression migration provider");
  return provider;
}

/** The per-environment resource ids + base URL the email worker deploy needs, resolved by the caller. */
export interface EmailEnvResources {
  /** The app database id for this environment — where jobs/events live. */
  appDatabaseId: string;
  /** This environment's secrets database id (`pithy-secrets-<env>`) — holds the signing key. */
  secretsDatabaseId: string;
  /** The app worker's public base URL for this environment — callback links are built against it. */
  baseUrl: string;
}

/** Resolve the per-environment resources for the email worker (from the project wrangler + name lookups). */
export type ResolveEmailEnv = (env: ManagedEnvironment) => Promise<EmailEnvResources>;

export interface CloudflareEmailProvisionerOptions {
  cf: CloudflareClients;
  accountId: string;
  /** The broad bootstrap token (`.dev.vars` `CLOUDFLARE_API_TOKEN`) that authenticates the worker deploy. */
  apiToken: string;
  /** The CF Secrets Store id holding the per-env master keys (the email worker decrypts its signing key). */
  storeId: string;
  /** The resolved brand theme (from the app's `email()` config), serialized into the worker's `EMAIL_THEME` var. */
  theme: EmailTheme;
  /** Resolve the per-env app DB id, secrets DB id, and base URL — injected so it is testable + decoupled. */
  resolveEnv: ResolveEmailEnv;
  /**
   * Optional inbound routing: the zone, the address to match, and the production app worker to deliver to.
   * Absent → the routing step is skipped (the operator wires it later, on a subdomain that won't disturb
   * the apex MX). Email Routing must already be enabled on the zone.
   */
  routing?: { zoneId: string; address: string; appWorkerName: string };
}

/**
 * The live {@link EmailProvisioner} — the CF + wrangler implementation of email provisioning. The
 * control-plane steps go through `@pithy-sh/cloudflare` (CLAUDE.md: CF API only via that client) and are
 * each idempotent; the worker deploy shells out to wrangler with the bootstrap token. No CF API token is
 * minted — the email worker sends through the `send_email` binding and reads its signing key through the
 * `SECRETS` bindings, neither of which uses a token. The live steps are exercised by the integration suite.
 */
export class CloudflareEmailProvisioner implements EmailProvisioner {
  readonly #cf: CloudflareClients;
  readonly #accountId: string;
  readonly #apiToken: string;
  readonly #storeId: string;
  readonly #theme: EmailTheme;
  readonly #resolveEnv: ResolveEmailEnv;
  readonly #routing?: { zoneId: string; address: string; appWorkerName: string };

  constructor(options: CloudflareEmailProvisionerOptions) {
    this.#cf = options.cf;
    this.#accountId = options.accountId;
    this.#apiToken = options.apiToken;
    this.#storeId = options.storeId;
    this.#theme = options.theme;
    this.#resolveEnv = options.resolveEnv;
    this.#routing = options.routing;
  }

  /** Require a registered `workers.dev` subdomain — Cloudflare needs one to deploy the Workflow-hosting worker. */
  async preflight(): Promise<void> {
    if (!(await this.#cf.workers().accountSubdomain())) {
      throw new ValidationError({
        message: "This Cloudflare account has no workers.dev subdomain, which Workflows require.",
        action: "Open Workers & Pages in the dashboard once to create one, then re-run.",
      });
    }
  }

  /** Reuse the shared suppression D1 if it exists, otherwise create it. */
  async ensureSuppressionDatabase(): Promise<{ databaseId: string }> {
    const existing = await this.#cf.d1Provisioner().findDatabaseByName(SUPPRESSION_DB_NAME);
    const db = existing ?? (await this.#cf.d1Provisioner().createDatabase(SUPPRESSION_DB_NAME));
    return { databaseId: db.uuid };
  }

  /** Run the suppression migration against the shared D1 over REST (idempotent — applied ones skip). */
  async migrateSuppression(databaseId: string): Promise<void> {
    await runMigrations(this.#cf.d1(databaseId), suppressionMigrationProvider());
  }

  /** Resolve the env's wrangler config from the committed template + provisioned ids, then `wrangler deploy`. */
  async deployWorker(env: ManagedEnvironment, suppressionDatabaseId: string): Promise<void> {
    const { appDatabaseId, secretsDatabaseId, baseUrl } = await this.#resolveEnv(env);
    const dir = emailWorkerDir();
    const template = parse(
      await readFile(join(dir, "wrangler.jsonc"), "utf8"),
    ) as unknown as EmailWorkerWranglerTemplate;
    const config = resolveEmailConfig(template, {
      env,
      appDatabaseId,
      suppressionDatabaseId,
      secretsDatabaseId,
      storeId: this.#storeId,
      baseUrl,
      theme: this.#theme,
    });
    const configPath = join(dir, `.wrangler.${env}.json`);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    try {
      await runWrangler(["deploy", "--config", configPath], {
        cwd: dir,
        env: { CLOUDFLARE_API_TOKEN: this.#apiToken, CLOUDFLARE_ACCOUNT_ID: this.#accountId },
      });
    } finally {
      await unlink(configPath).catch(() => {});
    }
  }

  /** Create the inbound routing rule (production app worker) when routing is configured; otherwise skip. */
  async ensureRoutingRule(): Promise<{ created: boolean; skipped: boolean }> {
    if (!this.#routing) return { created: false, skipped: true };
    const { created } = await this.#cf.emailRouting().ensureWorkerRoute({
      zoneId: this.#routing.zoneId,
      address: this.#routing.address,
      workerName: this.#routing.appWorkerName,
      ruleName: "pithy-email-bounce",
    });
    return { created, skipped: false };
  }
}

/** The directory of the prebuilt email worker inside the installed `@pithy-sh/email` package (holds wrangler.jsonc). */
function emailWorkerDir(): string {
  return dirname(fileURLToPath(import.meta.resolve("@pithy-sh/email/src/workflows/worker")));
}

export interface CloudflareEmailDeprovisionerOptions {
  cf: CloudflareClients;
}

/**
 * The live {@link EmailDeprovisioner} — removes each environment's email worker and, when asked, the
 * shared suppression D1, through `@pithy-sh/cloudflare`. Every step is guarded so a missing resource is a
 * no-op: teardown is idempotent. The integration suite exercises the provision → teardown round trip.
 */
export class CloudflareEmailDeprovisioner implements EmailDeprovisioner {
  readonly #cf: CloudflareClients;

  constructor(options: CloudflareEmailDeprovisionerOptions) {
    this.#cf = options.cf;
  }

  /** Delete the env's email worker if it is deployed. */
  async deleteWorker(env: ManagedEnvironment): Promise<void> {
    const name = emailWorkerName(env);
    if (await this.#cf.workers().getWorker(name)) {
      await this.#cf.workers().deleteWorker(name);
    }
  }

  /** Delete the shared suppression D1 if it exists — destructive, called only on a full destroy. */
  async deleteSuppressionDatabase(): Promise<void> {
    const db = await this.#cf.d1Provisioner().findDatabaseByName(SUPPRESSION_DB_NAME);
    if (db) {
      await this.#cf.d1Provisioner().deleteDatabase(db.uuid);
    }
  }
}
