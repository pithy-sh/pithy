import { masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { EmailTheme } from "../templates/theme";
import { emailWorkerName } from "./provisionEmail";

/**
 * The email worker's `wrangler.jsonc` template shape — only the fields provisioning resolves. The
 * committed template (`src/workflows/wrangler.jsonc`) is the source of truth for the static fields
 * (compatibility date, the every-minute cron, class names, the `send_email` binding, theme vars); this
 * resolver fills the per-environment placeholders into one standalone config.
 */
export interface EmailWorkerWranglerTemplate {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  workers_dev: boolean;
  d1_databases: Array<{ binding: string; database_name: string; database_id: string }>;
  send_email: Array<{ name: string; remote?: boolean }>;
  secrets_store_secrets: Array<{ binding: string; store_id: string; secret_name: string }>;
  workflows: Array<{ binding: string; name: string; class_name: string }>;
  triggers: { crons: string[] };
  vars: Record<string, string>;
}

/** The resolved resource ids + per-env values for one environment's email-worker deploy. */
export interface EmailConfigParams {
  env: ManagedEnvironment;
  /** The app database id for this environment — where jobs/events live. */
  appDatabaseId: string;
  /** The shared suppression database id (same in every environment). */
  suppressionDatabaseId: string;
  /** This environment's secrets database id (`pithy-secrets-<env>`) — holds the signing key. */
  secretsDatabaseId: string;
  /** The CF Secrets Store id holding the per-env master key. */
  storeId: string;
  /** The app worker's public base URL for this environment — callback links are built against it. */
  baseUrl: string;
  /** The resolved brand theme — serialized into the worker's `EMAIL_THEME` var. */
  theme: EmailTheme;
}

/**
 * Resolve the email-worker `wrangler.jsonc` template into one environment's standalone config — no
 * `[env.*]` stanzas (staging and production are genuinely separate workers, per CLAUDE.md). Fills the
 * per-env worker name, the three D1 ids (app `DB`, shared `EMAIL_SUPPRESSIONS`, per-env `SECRETS`), the
 * Secrets Store id + env-prefixed master-key entry name (matching the secrets manager's convention),
 * env-suffixed Workflow names, and the `BASE_URL`/`ENVIRONMENT` vars — leaving every static field
 * untouched. Pure: the caller parses the template and writes the result.
 */
export function resolveEmailConfig(
  template: EmailWorkerWranglerTemplate,
  params: EmailConfigParams,
): EmailWorkerWranglerTemplate {
  const { env, appDatabaseId, suppressionDatabaseId, secretsDatabaseId, storeId, baseUrl, theme } = params;
  const resolved: EmailWorkerWranglerTemplate = structuredClone(template);
  const databaseIds: Record<string, string> = {
    DB: appDatabaseId,
    EMAIL_SUPPRESSIONS: suppressionDatabaseId,
    SECRETS: secretsDatabaseId,
  };

  resolved.name = emailWorkerName(env);
  resolved.d1_databases = resolved.d1_databases.map((db) => ({
    ...db,
    database_id: databaseIds[db.binding] ?? db.database_id,
  }));
  // The master key entry is env-scoped — its name is env-prefixed, matching what the secrets manager wrote.
  resolved.secrets_store_secrets = resolved.secrets_store_secrets.map((entry) => ({
    ...entry,
    store_id: storeId,
    secret_name: entry.binding === "SECRETS_ENCRYPTION_KEYS" ? masterKeySecretName(env) : entry.secret_name,
  }));
  // Suffix every Workflow so staging and production are addressable, and never collide, in one account.
  resolved.workflows = resolved.workflows.map((wf) => ({ ...wf, name: `${wf.name}-${env}` }));
  resolved.vars = { ...resolved.vars, EMAIL_THEME: JSON.stringify(theme), BASE_URL: baseUrl, ENVIRONMENT: env };

  return resolved;
}
