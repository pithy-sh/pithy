// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CapabilitySettings, SettingsFinding } from "@pithy-sh/core/src/capability/settings";
import type { LocaleCatalogs } from "@pithy-sh/core/src/i18n/catalog";
import { KIT_CATALOGS } from "../catalogs/kit";
import type { I18nConfig } from "../config/config";

/** How many missing keys a finding names before it stops counting out loud. */
const LISTED_KEYS = 5;

/**
 * Catalog coverage as `pithy doctor`'s **local** tier — offline, project-file-only, and already fatal
 * to `doctor`'s exit code.
 *
 * This is the whole of what a `pithy i18n check` command would have been, and it costs no new command,
 * no `docs/commands/` page, and no edit to the five exact-count or byte-pinned CLI gates a new command
 * moves (`dispatch.test.ts`'s `DECLARED`/`GROUPS`, `binDocs.test.ts`'s byte comparison of `docs/CLI.md`
 * §4.1 against real `pithy --help`, `doctorDocs.test.ts`'s mandated page sections and `--json` key
 * register). The seam already exists and this is textbook for it.
 *
 * It answers one question: **would a reader in a supported locale meet a sentence nobody wrote?** For
 * each locale the project serves, every key reachable in the default locale must be reachable in that
 * one too, through the adopter's own catalog or the kit's translation.
 *
 * There is no `account` tier. Nothing about language is a question for the Cloudflare API.
 */
export function i18nSettings(config: I18nConfig, composed: () => LocaleCatalogs): CapabilitySettings {
  return {
    local: () => {
      const findings: SettingsFinding[] = [];
      const capabilityMessages = composed();
      const baseline = new Set([
        ...Object.keys(capabilityMessages[config.defaultLocale] ?? {}),
        ...Object.keys(config.messages[config.defaultLocale] ?? {}),
      ]);
      for (const locale of config.supportedLocales) {
        if (locale === config.defaultLocale) continue;
        const covered = new Set([
          ...Object.keys(KIT_CATALOGS[locale] ?? {}),
          ...Object.keys(capabilityMessages[locale] ?? {}),
          ...Object.keys(config.messages[locale] ?? {}),
        ]);
        const missing = [...baseline].filter((key) => !covered.has(key)).sort();
        if (missing.length === 0) continue;
        const named = missing.slice(0, LISTED_KEYS).join(", ");
        const rest = missing.length > LISTED_KEYS ? `, and ${missing.length - LISTED_KEYS} more` : "";
        findings.push({
          setting: `i18n.supportedLocales.${locale}`,
          environment: null,
          problem: `${missing.length} ${missing.length === 1 ? "message has" : "messages have"} no \`${locale}\` translation, so a reader in that language meets ${config.defaultLocale} instead.`,
          action: `Add them to \`i18n({ messages: { ${locale}: … } })\` in your \`pithy.config.ts\`: ${named}${rest}.`,
        });
      }
      return findings;
    },
  };
}
