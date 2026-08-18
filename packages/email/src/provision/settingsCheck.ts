// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type {
  CapabilitySettings,
  SettingsAccountContext,
  SettingsCheckContext,
  SettingsFinding,
} from "@pithy-sh/core/src/capability/settings";
import { hostEnvFindings } from "@pithy-sh/core/src/capability/settings";
import { checkHostEnv } from "@pithy-sh/core/src/workflow/hostEnv";
import { EMAIL_LINK_SIGNING_KEY } from "../crypto/signingKey";
import type { EmailTheme } from "../templates/theme";
import { emailHostEnv } from "../workflows/hostEnv";
import { suppressionDatabaseName } from "./provisionEmail";

/**
 * Whether email's settings **work**, as `pithy doctor` asks it (pithy-sh/pithy#411).
 *
 * Every check doctor had before this one asked about presence: the `email({ … })` option keys are
 * written, the `DB` and `EMAIL_SENDER` bindings are declared, the ledger is level. All of them pass while
 * `fromAddress` names a domain nobody onboarded, the link-signing key was never created, `BASE_URL` is
 * staging's URL in production's config, and the suppression database does not exist — and the way an
 * adopter learns any of that is a message that never arrives.
 *
 * ## The local tier runs the host's own schema
 *
 * `checkHostEnv(emailHostEnv, …)` is not a second reading of the same rules — it is *the* reading. The
 * prebuilt host worker refuses to start on the same declaration (`workflows/worker.ts`), so a value doctor
 * calls good is a value the host will accept, and a rule that changes changes in one file. Bindings are
 * stubbed on the way in, deliberately: whether `DB` is bound is `pithy doctor`'s `bindings` check and
 * `Secret bindings:` block, and asking it twice would report one fault as two.
 *
 * ## The account tier asks the three things only the account knows
 *
 * Is the sending domain a zone here, does the suppression database exist, does the signing key have a
 * value. Each costs one Cloudflare call, each is skipped whole when the account cannot be reached, and
 * none of them is inferable from a file in the checkout.
 *
 * Nothing here writes. Every finding names the command, the config key, or the one-time dashboard action
 * that resolves it.
 */

/** The resolved config slice the check reads. The capability builds it; nothing here parses config. */
export interface EmailSettingsInput {
  /** The address every message is sent from — its domain is what must be onboarded. */
  fromAddress: string;
  /** The public base URL every link in a message is built against. */
  baseUrl: string;
  /** The resolved theme, as the host receives it: one JSON var. */
  theme?: EmailTheme;
}

/**
 * A stand-in for a binding, so the local tier judges values rather than wiring.
 *
 * `EmailHostEnv` duck-types its bindings — it asserts the method the host calls, because these are host
 * objects the runtime hands over and there is no class to compare against. That is what makes a stub
 * possible here at all, and it is why the stub carries the methods rather than being an empty object: the
 * schema would refuse `{}` and the report would fill with wiring faults doctor already states elsewhere.
 */
function stubBindings(): Record<string, unknown> {
  const d1 = { prepare: () => undefined } as unknown as D1Database;
  return {
    DB: d1,
    EMAIL_SUPPRESSIONS: d1,
    SECRETS: d1,
    SECRETS_ENCRYPTION_KEYS: "checked elsewhere",
    EMAIL: { send: () => undefined },
    EMAIL_SENDER: { create: () => undefined, get: () => undefined },
    EMAIL_SCHEDULER: { create: () => undefined },
  };
}

/** The domain half of an address, lowercased, or `null` where the address carries none usable. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain.includes(".") ? domain : null;
}

/** The origin of a URL, or `null` when it is not one. Compared origin-to-origin, never string-to-string. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The host's own parse of the values this composition would hand it.
 *
 * Run **once**, not once per environment, and reported with no environment named: `email({ … })` is one
 * config object per Worker, so a `BASE_URL` that is not a URL is one edit however many environments a
 * project declares. Three lines about one key is how a report stops being read.
 */
function localHostEnv(config: EmailSettingsInput): SettingsFinding[] {
  const candidate = {
    ...stubBindings(),
    BASE_URL: config.baseUrl,
    // Serialized exactly as `resolveEmailConfig` stamps it, so what is checked is what the host parses —
    // a theme that resolves in TypeScript and does not survive a round trip through one JSON var is the
    // failure this catches.
    ...(config.theme ? { EMAIL_THEME: JSON.stringify(config.theme) } : {}),
  };
  return hostEnvFindings(checkHostEnv(emailHostEnv, candidate), null);
}

/**
 * Whether the configured base URL is an origin this project actually answers on.
 *
 * `pithy email provision` stamps each host's `BASE_URL` from that environment's *resolved worker address*,
 * so a deployed host is right by construction — but `email({ baseUrl })` is what `pithy dev` renders links
 * against and what the repository states its intent with, and a value matching no declared origin is a
 * link to a host nothing serves. Asked only when some environment declares one: a project before its first
 * domain has nothing to compare against, and `Origins:` already reports that.
 */
function localBaseUrlOrigin(config: EmailSettingsInput, context: SettingsCheckContext): SettingsFinding[] {
  const declared = context.environments
    .map((environment) => (environment.origin === null ? null : originOf(environment.origin)))
    .filter((origin): origin is string => origin !== null);
  const configured = originOf(config.baseUrl);
  if (declared.length === 0 || configured === null || declared.includes(configured)) return [];
  return [
    {
      setting: "BASE_URL",
      environment: null,
      problem: `Links are built against ${configured}, and no environment this project declares answers on it.`,
      action: `Set \`email({ baseUrl })\` to an origin this project serves: ${declared.join(", ")}.`,
    },
  ];
}

/** The address question, asked once: it is one config key, and one edit fixes every environment. */
function localForAddress(config: EmailSettingsInput): SettingsFinding[] {
  if (domainOf(config.fromAddress) !== null) return [];
  return [
    {
      setting: "fromAddress",
      environment: null,
      problem: `${config.fromAddress} is not an address a sending domain can be read from.`,
      action: "Set `email({ fromAddress })` to an address on a domain you have onboarded onto Email Service.",
    },
  ];
}

/** The last declared environment — the one a project-wide remedy is named for. */
function lastEnvironment(context: SettingsCheckContext): string {
  return context.environments.at(-1)?.name ?? "prod";
}

/** The account half: the zone, the suppression database, and the signing key. */
async function accountFindings(
  config: EmailSettingsInput,
  context: SettingsAccountContext,
): Promise<SettingsFinding[]> {
  const findings: SettingsFinding[] = [];

  const domain = domainOf(config.fromAddress);
  // A domain the local tier already refused is not asked about again: it named the edit, and a second
  // line about the same key would send the operator looking for a second problem.
  if (domain !== null && !(await context.account.zone(domain))) {
    findings.push({
      setting: "fromAddress",
      environment: null,
      problem: `${domain} is not a zone on this Cloudflare account, so it cannot be onboarded onto Email Service.`,
      action: `Add ${domain} to this Cloudflare account, then onboard it onto Email Service in the dashboard.`,
    });
  }

  const suppressions = suppressionDatabaseName(context.project);
  if (!(await context.account.d1Databases()).includes(suppressions)) {
    findings.push({
      setting: "EMAIL_SUPPRESSIONS",
      environment: null,
      problem: `No D1 database named ${suppressions} exists on this account.`,
      // One database for the whole project, so the remedy is one run in any environment — named as the
      // last declared one, which is the environment an operator is least likely to have skipped.
      action: `Run \`pithy email provision --env ${lastEnvironment(context)}\`. Nothing is suppressed until it exists.`,
    });
  }

  for (const environment of context.environments) {
    // `dev` has no manager Worker to ask: a `d1` secret's value is sealed under a master key that never
    // leaves the environment's manager, and local dev has none. Asking would be answered by a refusal,
    // which the runner would report as an unchecked capability rather than as this clean pass.
    if (environment.name === "dev") continue;
    if (await context.account.secret({ name: EMAIL_LINK_SIGNING_KEY, environment: environment.name })) continue;
    findings.push({
      setting: EMAIL_LINK_SIGNING_KEY,
      environment: environment.name,
      problem: `The link-signing key has no value in ${environment.name}, so no tracking or unsubscribe link can be signed.`,
      action: `Run \`pithy secrets provision --env ${environment.name}\`.`,
    });
  }

  return findings;
}

/** Email's settings check, built from one composition's resolved config. Declared on the capability. */
export function emailSettings(config: EmailSettingsInput): CapabilitySettings {
  return {
    local: (context) => [...localHostEnv(config), ...localForAddress(config), ...localBaseUrlOrigin(config, context)],
    account: (context) => accountFindings(config, context),
  };
}
