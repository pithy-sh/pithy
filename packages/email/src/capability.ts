import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { z } from "zod";
import { createBounceHandler } from "./bounce/handler";
import { emailSigningRegistry } from "./crypto/signingKey";
import { emailSuppressionTables, emailTables } from "./data/tables";
import { registerCallbacks } from "./http/callbacks";
import { email_0001_init } from "./migrations/0001_init";
import { email_0001_suppressions } from "./migrations/0001_suppressions";
import { CustomTheme, type EmailTheme, resolveTheme } from "./templates/theme";

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
    theme: z
      .enum(["saffron", "midnight", "forest", "rose"])
      .default("saffron")
      .describe("The off-the-shelf theme preset to start from: `saffron` (default), `midnight`, `forest`, or `rose`."),
    customTheme: CustomTheme.optional().describe(
      "A partial override deep-merged over the preset — change any theme field, inherit the rest.",
    ),
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

/** The email capability, with its resolved config attached for the app's enqueue calls. */
export interface EmailCapability extends Capability {
  emailConfig: ResolvedEmailConfig;
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
    // The link-signing key is read through @pithy-sh/secrets, so the secrets capability must be
    // composed; createBackend fails fast if it isn't (rather than 500-ing each link-signing request).
    dependsOn: ["secrets"],
    // The slice of secrets email reads — aggregated into the shared per-invocation accessor at startup.
    secretRegistry: emailSigningRegistry,
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
        migrations: { "0001_suppressions": email_0001_suppressions },
      },
    },
    routes: registerCallbacks,
    email: createBounceHandler(),
  });
  return Object.assign(capability, {
    emailConfig: {
      fromAddress: resolved.fromAddress,
      fromName: resolved.fromName,
      baseUrl: resolved.baseUrl,
      schedulerEnabled: resolved.schedulerEnabled,
      theme,
    },
  });
}

/** Whether a capability is the email capability — carries its resolved config. */
export function isEmailCapability(capability: Capability): capability is EmailCapability {
  return capability.name === "email" && "emailConfig" in capability;
}
