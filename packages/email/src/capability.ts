// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { z } from "zod";
import { createBounceHandler } from "./bounce/handler";
import { emailSigningRegistry } from "./crypto/signingKey";
import { emailDatabase, emailSuppressionTables, emailTables } from "./data/tables";
import { registerCallbacks } from "./http/callbacks";
import { emailAdminRoutes } from "./http/guards";
import { registerEmailAdminRoutes } from "./http/routes";
import { email_0001_init } from "./migrations/0001_init";
import { email_0001_suppressions } from "./migrations/0001_suppressions";
import { type EnqueueDeps, type EnqueueInput, type EnqueueResult, enqueueEmail } from "./send/enqueue";
import { CustomTheme, type EmailTheme, resolveTheme } from "./templates/theme";
import { PACKAGE_VERSION } from "./version.generated";

/** The send Workflow binding shape — declared by `EnqueueDeps` so the capability and adopters agree. */
type SendWorkflowBinding = NonNullable<EnqueueDeps["sender"]>;

/**
 * The bindings the enqueue seam reads from the request env: the shared `DB` and the send Workflow.
 * A consumer (e.g. `@pithy-sh/auth`) forwards its worker env; it never names these bindings itself.
 */
export interface EmailEnqueueEnv {
  DB: D1Database;
  EMAIL_SENDER?: SendWorkflowBinding;
}

/**
 * Sort order of the email migrations within the app database, relative to other capabilities
 * (core low, app high). Unique per database; the migration registry composes the key
 * `0200_email_0001_init`.
 */
export const EMAIL_MIGRATION_ORDER = 200;

/** Sort order of the suppression migration within the dedicated `EMAIL_SUPPRESSIONS` database. */
export const EMAIL_SUPPRESSIONS_MIGRATION_ORDER = 100;

/**
 * Configuration for the email capability, passed in `pithy.config.ts` — the thin user-owned surface.
 * `fromAddress` and `baseUrl` are required; branding is one `theme` preset plus an optional
 * `customTheme` that deep-merges over it (so a project tweaks just an accent or a palette color, not a
 * dozen fields). Body width is intentionally *not* here — it is a property of each template (newsletters
 * render wide, transactional narrow). The resolved theme is attached to the capability and serialized
 * into the email worker's single `EMAIL_THEME` var at provision.
 */
export const EmailConfig = z
  .object({
    fromAddress: z
      .string()
      .describe("The address every email is sent from. Must use a domain onboarded onto Cloudflare Email Service."),
    fromName: z.string().default("Pithy").describe("The sender display name recipients see."),
    baseUrl: z
      .string()
      .describe("The public base URL of the app worker; tracking and unsubscribe links are built against it."),
    basePath: z
      .string()
      .startsWith("/")
      .default("/email")
      .describe(
        "Where the management routes mount (the send log and the suppression list). Not the callback links: those keep their fixed `/_pithy/email` prefix, because a tracking URL is already minted into mail sitting in somebody's inbox and moving it would break every link ever sent.",
      ),
    theme: z
      .enum(["saffron", "midnight", "forest", "rose"])
      .default("saffron")
      .describe("The off-the-shelf theme preset to start from: `saffron` (default), `midnight`, `forest`, or `rose`."),
    customTheme: CustomTheme.optional().describe(
      "A partial override deep-merged over the preset — change any theme field, inherit the rest.",
    ),
    // KNOWN DEFECT — this value never reaches the worker. `EmailConfigParams` carries no
    // `schedulerEnabled`, so `resolveEmailConfig` never writes `SCHEDULER_ENABLED` and the template's
    // hardcoded "true" always wins. Setting it false is silently ignored. Wiring it through means an
    // eighth `resolveEmailConfig` param and a new `CloudflareEmailProvisioner` option, both of which
    // are pinned by tests this change may not edit — so it is filed, not fixed here.
    schedulerEnabled: z.boolean().default(true).describe("Whether the every-minute scheduler Workflow runs."),
  })
  .describe("Configuration for the email capability.");
export type EmailConfig = z.output<typeof EmailConfig>;
export type EmailConfigInput = z.input<typeof EmailConfig>;

/** The resolved from identity, base URL, and theme — what the app's enqueue calls need. */
export interface ResolvedEmailConfig {
  fromAddress: string;
  fromName: string;
  baseUrl: string;
  schedulerEnabled: boolean;
  theme: EmailTheme;
}

/** The email capability, with its resolved config and a bound enqueue seam attached. */
export interface EmailCapability extends Capability {
  emailConfig: ResolvedEmailConfig;
  /**
   * Enqueue an email job from a request env. The capability owns the `DB`/`EMAIL_SENDER` bindings, the
   * from-identity, and the theme — a consumer passes only its worker env and the high-level input
   * (`to`, `template`, `payload`). This is the seam other capabilities depend on; they never assemble
   * `EnqueueDeps` or name the email bindings themselves.
   */
  enqueue: (env: EmailEnqueueEnv, input: EnqueueInput) => Promise<EnqueueResult>;
}

/**
 * The email capability. It contributes the three email tables to the app `DB`, mounts the
 * click/open/unsubscribe callback routes, and registers the inbound bounce/complaint `email()` handler.
 * It requires the `DB` binding and the `EMAIL_SENDER` Workflow binding (to start an immediate send at
 * enqueue). The send and scheduler Workflows and the every-minute cron live in the prebuilt email
 * worker (`workflows/worker.ts`), deployed per environment by `pithy add email`.
 */
export function email(config: EmailConfigInput): EmailCapability {
  const resolved = EmailConfig.parse(config);
  // Build the full theme from the preset, deep-merging any customTheme override.
  const theme = resolveTheme(resolved.theme, resolved.customTheme);
  const capability = defineCapability({
    name: "email",
    // The package version this capability ships at, stamped by `scripts/stampVersions.ts` — a Worker
    // cannot read its own package.json. Reported per capability by the control-plane manifest.
    version: PACKAGE_VERSION,
    // The link-signing key is read through @pithy-sh/secrets, so the secrets capability must be
    // composed; createBackend fails fast if it isn't (rather than 500-ing each link-signing request).
    dependsOn: ["secrets"],
    // The slice of secrets email reads — aggregated into the shared per-invocation accessor at startup.
    secretRegistry: emailSigningRegistry,
    // Email provisioning wires inbound bounce routing (Email Routing rules), so the CI credential that
    // provisions email needs that scope — contributed into the one `ci-system` token.
    ciPermissions: ["email:routing"],
    requiredBindings: [
      { type: "d1", name: "DB" },
      { type: "d1", name: "EMAIL_SUPPRESSIONS" },
      { type: "workflow", name: "EMAIL_SENDER" },
    ],
    databases: {
      app: {
        binding: "DB",
        tables: emailTables,
        migrationOrder: EMAIL_MIGRATION_ORDER,
        migrations: { "0001_init": email_0001_init },
      },
      emailSuppressions: {
        binding: "EMAIL_SUPPRESSIONS",
        tables: emailSuppressionTables,
        migrationOrder: EMAIL_SUPPRESSIONS_MIGRATION_ORDER,
        migrations: {
          "0001_suppressions": email_0001_suppressions,
        },
      },
    },
    /**
     * The two durable jobs email owns. Both classes live in the prebuilt email worker
     * (`workflows/worker.ts`), never in the app worker — the app only ever dispatches into `send`.
     *
     * The map keys are the wire names: `workflowScriptName("email", "send", "staging")` resolves to
     * `pithy-email-send-staging`, which is byte-for-byte what the committed template already deploys.
     * Declaring them here is what lets the CLI generate the host's `workflows` array and its cron from
     * the specs instead of a hand-maintained block that can drift from this file.
     */
    workflows: {
      send: {
        binding: "EMAIL_SENDER",
        className: "EmailSendWorkflow",
        params: z
          .object({
            jobIds: z
              .array(z.string().min(1).describe("A queued `pithy_email_jobs` row id."))
              .describe("The batch of queued job ids this instance sends — one durable step each."),
          })
          .describe("Parameters for one durable send batch."),
      },
      schedule: {
        binding: "EMAIL_SCHEDULER",
        className: "EmailSchedulerWorkflow",
        params: z.object({}).describe("The scheduler takes no parameters — it finds its own due jobs."),
        schedule: "* * * * *",
        // Optional because the binding exists only on the prebuilt email worker, which self-fires it
        // from its cron. An app worker binds EMAIL_SENDER and nothing else, so deriving a required
        // EMAIL_SCHEDULER binding would fail every app's first request.
        optional: true,
      },
    },
    /**
     * Two route trees, one hook.
     *
     * The public callbacks keep their fixed `/_pithy/email` prefix — those URLs are already minted into
     * mail nobody can recall — and the management routes mount under the configured `basePath`. They
     * are registered together here rather than being two capabilities, because they are one
     * capability's surface and `adminRoutes` below has to describe what this exact composition mounted.
     */
    routes: (app) => {
      registerCallbacks(app);
      registerEmailAdminRoutes({ basePath: resolved.basePath })(app);
    },
    /**
     * The management surface, advertised on `GET /control-plane/manifest`.
     *
     * Built from the **resolved** `basePath` — the same value `registerEmailAdminRoutes` mounts
     * against, read once. A default here and a default there is how a manifest comes to describe a
     * route tree nobody serves.
     */
    adminRoutes: emailAdminRoutes(resolved.basePath),
    email: createBounceHandler(),
  });
  const enqueue = (env: EmailEnqueueEnv, input: EnqueueInput): Promise<EnqueueResult> =>
    enqueueEmail(
      {
        db: emailDatabase(env.DB),
        fromAddress: resolved.fromAddress,
        fromName: resolved.fromName,
        theme,
        sender: env.EMAIL_SENDER,
        now: new Date(),
        newId: () => crypto.randomUUID(),
      },
      input,
    );
  return Object.assign(capability, {
    emailConfig: {
      fromAddress: resolved.fromAddress,
      fromName: resolved.fromName,
      baseUrl: resolved.baseUrl,
      schedulerEnabled: resolved.schedulerEnabled,
      theme,
    },
    enqueue,
  });
}

/** Whether a capability is the email capability — carries its resolved config. */
export function isEmailCapability(capability: Capability): capability is EmailCapability {
  return capability.name === "email" && "emailConfig" in capability;
}
