import type {
  HostD1Binding,
  HostSecretsStoreBinding,
  HostSendEmailBinding,
  HostWorkflowBinding,
  WorkflowHostTemplate,
} from "@pithy-sh/core/src/workflow/host";
import { resolveWorkflowHost } from "@pithy-sh/core/src/workflow/host";
import { masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { EmailTheme } from "../templates/theme";

/**
 * The email worker's `wrangler.jsonc` template shape. Email invented the prebuilt-host convention;
 * `@pithy-sh/core`'s {@link WorkflowHostTemplate} is the generalization of it, so this is now that
 * contract with the fields email's committed template always carries narrowed to required. The
 * committed template (`src/workflows/wrangler.jsonc`) stays the source of truth for the static fields
 * (compatibility date, the every-minute cron, class names, the `send_email` binding, theme vars).
 */
export interface EmailWorkerWranglerTemplate extends WorkflowHostTemplate {
  compatibility_date: string;
  compatibility_flags: string[];
  workers_dev: boolean;
  d1_databases: HostD1Binding[];
  send_email: HostSendEmailBinding[];
  secrets_store_secrets: HostSecretsStoreBinding[];
  workflows: HostWorkflowBinding[];
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
  // No `schedulerEnabled`. `EmailConfig.schedulerEnabled` is parsed and exposed but never arrives
  // here, so the template's hardcoded SCHEDULER_ENABLED="true" always wins — a known defect, filed
  // rather than fixed, because closing it changes this signature and the provisioner's option bag,
  // both of which are pinned by tests.
}

/**
 * Resolve the email-worker `wrangler.jsonc` template into one environment's standalone config — no
 * `[env.*]` stanzas (staging and production are genuinely separate workers, per CLAUDE.md).
 *
 * The mechanics are `@pithy-sh/core`'s {@link resolveWorkflowHost}: this is the email-shaped face of
 * it, mapping email's seven inputs onto the generic host params. What stays here is the part that is
 * genuinely email's — which binding takes which database id, and the `@pithy-sh/secrets` import that
 * names the env-scoped master key. Core must never depend on `@pithy-sh/secrets`, so the resolved
 * string is passed in rather than the naming rule being hoisted.
 *
 * `database_name` is deliberately left alone. `pithy-app` and `pithy-email-suppressions` are the same
 * resources in every environment, and the secrets manager owns the name of `pithy-secrets`; only the
 * ids differ per environment.
 */
export function resolveEmailConfig(
  template: EmailWorkerWranglerTemplate,
  params: EmailConfigParams,
): EmailWorkerWranglerTemplate {
  const { env, appDatabaseId, suppressionDatabaseId, secretsDatabaseId, storeId, baseUrl, theme } = params;
  const resolved = resolveWorkflowHost(template, {
    capability: "email",
    env,
    databaseIds: {
      DB: appDatabaseId,
      EMAIL_SUPPRESSIONS: suppressionDatabaseId,
      SECRETS: secretsDatabaseId,
    },
    secretsStoreId: storeId,
    // The master key entry is env-scoped — its name is env-prefixed, matching what the secrets manager wrote.
    masterKeySecretName: masterKeySecretName(env),
    vars: { EMAIL_THEME: JSON.stringify(theme), BASE_URL: baseUrl },
  });
  // The resolver fills fields; it never drops one. So every field this template narrows to required
  // survives — knowledge the generic return type cannot express, restored here.
  return resolved as EmailWorkerWranglerTemplate;
}
