// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { defineHostEnv, type HostEnvProvider } from "@pithy-sh/core/src/workflow/hostEnv";
import type { SecretBinding } from "@pithy-sh/secrets/src/env/bindings";
import { z } from "zod";
import type { EmailSender } from "../send/sender";
import { defaultTheme, EmailTheme } from "../templates/theme";
import type { SendWorkflowInstances } from "./instances";

/**
 * What the prebuilt email host worker reads out of its env — declared once, validated at boot, and
 * read statically by `pithy doctor` (pithy-sh/pithy#410, #411).
 *
 * Nobody authors this Worker. `pithy email provision` resolves the committed template beside this
 * file and deploys it, so every value here arrives as a binding, a var or a Secrets Store entry that
 * a *machine* wrote — and until this module, none of it was checked. Three failures, all of them
 * discovered as mail that did not arrive:
 *
 *   - `BASE_URL` absent → every magic link in the batch pointed at `undefined/auth/…`.
 *   - `EMAIL_THEME` unparseable → a `JSON.parse` threw inside a render step, three retries deep,
 *     where the message reads as a template fault.
 *   - `SCHEDULER_BATCH_SIZE` written `"fifty"` → `Number(...)` gave `NaN`, the scheduler claimed
 *     nothing, and it did so on every tick, forever, without a line in the log.
 *
 * So the parse is the boot check: `z.output` is what the host actually runs on, which is why the
 * coercions live in the schema rather than at the call sites. `Number(env.MAX_ATTEMPTS ?? 5)` in
 * `worker.ts` was the shape of the bug — a default and a coercion restated at every reader, each free
 * to disagree with the next.
 *
 * ## Two names, deliberately
 *
 * {@link EmailHostEnv} is the schema (and the type the host runs on). {@link emailHostEnv} is the
 * *declaration*: the schema plus what fills each field, which is the object the CLI imports. The
 * second is the one an operator's report is built from — a missing field is only actionable when
 * something names the binding, var or command that writes it.
 *
 * Node-safe on purpose. No `cloudflare:` import and no filesystem, so `pithy doctor` can import this
 * without executing the Worker — the same constraint `@pithy-sh/core`'s host modules carry.
 */

/** The command that writes every provisioned value here. Stated once so nine action lines cannot drift. */
const PROVISION = "pithy email provision --env <env>";

/** A binding `pithy email provision` wires into the resolved `wrangler.jsonc`. */
const binding = (name: string): HostEnvProvider => ({ kind: "binding", name, command: PROVISION });

/** A var the same run stamps into that config's `vars` block. */
const provisionedVar = (name: string): HostEnvProvider => ({ kind: "var", name, command: PROVISION });

/** A var with a shipped default — the template carries it, and an adopter may tune it in place. */
const tunedVar = (name: string): HostEnvProvider => ({ kind: "var", name });

/**
 * A binding the host calls one method on, checked structurally.
 *
 * Duck-typed rather than `instanceof`-checked because these are host objects the runtime hands over:
 * there is no class to compare against, and `wrangler dev`'s stand-ins are different objects again.
 * What the host depends on is the method, so the method is what is asserted.
 */
function callable<T>(method: string, what: string): z.ZodType<T> {
  return z.custom<T>((value) => typeof (value as Record<string, unknown> | null | undefined)?.[method] === "function", {
    error: `${what} — the binding is missing, or it is not the kind of binding this name expects.`,
  });
}

/** A D1 binding. `prepare` is the whole of what Kysely's D1 dialect needs from one. */
const d1Binding = (what: string): z.ZodType<D1Database> => callable<D1Database>("prepare", what);

/**
 * A count or a duration wrangler binds as a string.
 *
 * `z.coerce` before the integer check, so `"50"` is fifty and `"fifty"` is a refusal naming the field
 * — which is precisely the difference between this and the `Number(...)` it replaces.
 */
const tunedNumber = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/** The email host's env, as the host runs on it. Every field is coerced here, never at its reader. */
export const EmailHostEnv = z
  .object({
    DB: d1Binding("The app database holding this environment's email jobs and events").describe(
      "The app D1 database. The `pithy_email_jobs` and `pithy_email_events` tables live here, beside the adopter's own data. Bound by `pithy email provision`, which fills the id for the environment being deployed.",
    ),
    EMAIL_SUPPRESSIONS: d1Binding("The shared suppression database every environment of this project binds").describe(
      "The durable suppression D1 database — one per project, bound identically in every environment, so an unsubscribe or a hard bounce applies everywhere the project sends from. Named `<project>-global-email-suppressions`.",
    ),
    SECRETS: d1Binding("The per-environment secrets database the link-signing key is read from").describe(
      "The per-environment secrets D1 database. The link-signing key is stored here as an encrypted row and read through `@pithy-sh/secrets`; without it, tracking and unsubscribe links cannot be signed.",
    ),
    SECRETS_ENCRYPTION_KEYS: z
      .union([z.string().min(1), callable<SecretBinding>("get", "The master key binding")])
      .describe(
        "The master key that decrypts the secrets database — a Cloudflare Secrets Store binding in a deployed environment, and the same name as a plain string in `.dev.vars` locally. The one secret read outside the `secretsStore` accessor, because it is what makes the accessor work.",
      ),
    EMAIL: callable<EmailSender>("send", "The Cloudflare Email Service send binding").describe(
      "The Cloudflare Email Service `send_email` binding — the only thing in the kit that puts a message on the wire. `wrangler dev` simulates it locally; `remote: true` (the default under `pithy dev`) sends for real from the developer's machine.",
    ),
    EMAIL_SENDER: z
      .custom<EmailSenderBinding>((value) => isCallable(value, "create") && isCallable(value, "get"), {
        error: "The send Workflow binding — it must both start an instance and answer about one.",
      })
      .describe(
        "This host's own send Workflow, same-script. Two calls, and both matter: `create` starts a batch, and `get` is how the scheduler asks whether the instance a stranded row names is still alive before re-driving it.",
      ),
    EMAIL_SCHEDULER: callable<{ create(): Promise<unknown> }>("create", "The scheduler Workflow binding").describe(
      "This host's own scheduler Workflow, same-script. Fired by the every-minute cron; it finds due jobs and fans them out into send batches.",
    ),
    BASE_URL: z
      .url()
      .describe(
        "The app worker's public base URL for this environment. Every link that leaves in an email — magic link, tracked click, unsubscribe — is built against it, so a wrong value is a message that arrives and cannot be acted on.",
      ),
    EMAIL_THEME: z
      .string()
      .optional()
      .transform((raw, ctx): unknown => {
        if (raw === undefined || raw.trim().length === 0) return defaultTheme;
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          ctx.addIssue({ code: "custom", message: "Not valid JSON. The whole theme travels as one JSON var." });
          return z.NEVER;
        }
      })
      // Parsed, then validated: an unreadable theme must fail here, at boot, and not inside a render
      // step three retries deep where the message reads as a broken template.
      .pipe(EmailTheme)
      .describe(
        "The resolved brand theme, serialized as one JSON var at provision from the adopter's `email()` config. Absent falls back to the kit's default theme; present-and-unreadable is refused.",
      ),
    ENVIRONMENT: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The environment this host was deployed for. Stamped on every send as `X-Pithy-Env`, which is how the single inbound bounce worker attributes a bounce back to the environment that sent it.",
      ),
    LINK_TTL_DAYS: tunedNumber(90).describe(
      "How long a signed tracking or unsubscribe link stays valid, in days. Long by design: the link is minted into mail nobody can recall, and an unsubscribe that has expired is a complaint.",
    ),
    MAX_ATTEMPTS: tunedNumber(5).describe(
      "How many times one job may be attempted before it is failed terminally. Spent attempts are what separates a provider hiccup from an address that will never accept mail.",
    ),
    SCHEDULER_ENABLED: z
      .enum(["true", "false"])
      .describe("The var as wrangler binds it — a string, and only these two spellings of it.")
      .default("true")
      .transform((value) => value === "true")
      .describe(
        "Whether the every-minute scheduler Workflow runs. `false` stops due jobs being claimed at all — the cron still fires and does nothing — so it is a maintenance switch, not a tuning knob.",
      ),
    SCHEDULER_BATCH_SIZE: tunedNumber(50).describe(
      "How many jobs one send Workflow instance takes. Each job is a durable step, so this is the unit of retry and of the instance's report.",
    ),
    SCHEDULER_MAX_JOBS: tunedNumber(500).describe(
      "The most rows one scheduler tick will claim. A ceiling on the work a single minute can start, so a backlog drains steadily rather than in one instance-creating burst.",
    ),
    SCHEDULER_GRACE_MS: tunedNumber(2 * 60_000).describe(
      "How long an immediate job is left alone before the safety net treats it as stranded, in milliseconds. The window a freshly-enqueued job's own dispatch has to land in; too short re-drives sends that were already on their way.",
    ),
    SCHEDULER_STUCK_MS: tunedNumber(15 * 60_000).describe(
      "How long a job may sit `sending` before the safety net re-drives it, in milliseconds. A send Workflow in retry backoff writes nothing, so this is what tells a slow batch apart from a dead one.",
    ),
  })
  .describe("Everything the prebuilt email host worker reads out of its env, in the shape it runs on.");
export type EmailHostEnv = z.output<typeof EmailHostEnv>;

/** The send Workflow binding as the host holds it: it starts instances and answers about them. */
type EmailSenderBinding = {
  create(options: { id?: string; params: { jobIds: string[] } }): Promise<unknown>;
} & SendWorkflowInstances;

/** Whether a value carries a callable method of that name. */
function isCallable(value: unknown, method: string): boolean {
  return typeof (value as Record<string, unknown> | null | undefined)?.[method] === "function";
}

/**
 * The email host's env declaration — the schema plus what fills each field.
 *
 * The host validates against this at boot ({@link import("@pithy-sh/core/src/workflow/hostEnv").requireHostEnv});
 * `pithy doctor` walks the same object to check an adopter's *resolved* settings without running a
 * Worker. One declaration, so the check an operator runs and the check the host runs cannot disagree.
 */
export const emailHostEnv = defineHostEnv({
  capability: "email",
  env: EmailHostEnv,
  provided: {
    DB: binding("DB"),
    EMAIL_SUPPRESSIONS: binding("EMAIL_SUPPRESSIONS"),
    SECRETS: binding("SECRETS"),
    SECRETS_ENCRYPTION_KEYS: {
      kind: "secret",
      name: "SECRETS_ENCRYPTION_KEYS",
      command: "pithy secrets provision --env <env>",
    },
    EMAIL: binding("EMAIL"),
    EMAIL_SENDER: binding("EMAIL_SENDER"),
    EMAIL_SCHEDULER: binding("EMAIL_SCHEDULER"),
    BASE_URL: provisionedVar("BASE_URL"),
    // Written from the adopter's own `email()` config, so the fix is in `pithy.config.ts` and only
    // then in a provision run. Named as the config key, because that is where a person edits it.
    EMAIL_THEME: { kind: "config", name: "email({ theme, customTheme })", command: PROVISION },
    // The catalogs are deliberately absent from this map and from the schema above. Their variable
    // *names* are the project's locales — `EMAIL_MESSAGES_ES`, `EMAIL_MESSAGES_PT_BR` — and neither a
    // Zod object nor a fixed declaration table can name a key that is a decision made downstream.
    // `catalogsFromEnv` collects them off the raw env and validates each value; a missing one is not a
    // fault, because a project that serves only English has none to carry.
    ENVIRONMENT: provisionedVar("ENVIRONMENT"),
    LINK_TTL_DAYS: tunedVar("LINK_TTL_DAYS"),
    MAX_ATTEMPTS: tunedVar("MAX_ATTEMPTS"),
    SCHEDULER_ENABLED: tunedVar("SCHEDULER_ENABLED"),
    SCHEDULER_BATCH_SIZE: tunedVar("SCHEDULER_BATCH_SIZE"),
    SCHEDULER_MAX_JOBS: tunedVar("SCHEDULER_MAX_JOBS"),
    SCHEDULER_GRACE_MS: tunedVar("SCHEDULER_GRACE_MS"),
    SCHEDULER_STUCK_MS: tunedVar("SCHEDULER_STUCK_MS"),
  },
});
