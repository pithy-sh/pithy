// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CLOUDFLARE_ENV_KEYS } from "@pithy-sh/cloudflare/src/env/devVars";
import { PITHY_OFFLINE_ENV, SESSION_PROFILE_ENV } from "../cloudflare/config";
import { NO_TUI_ENV } from "../dev/tui/choose";
import { NO_UPDATE_NOTIFIER_ENV } from "../notifier/notify";
import { CONFIG_DIR_ENV } from "../notifier/state";
import { NO_OPEN_ENV } from "../platform/browser";
import { CLOUDFLARE_ENV_VAR } from "../project/effectiveConfig";
import { NONINTERACTIVE_ENV } from "../terminal/inputMode";
import { JSON_MODE_ENV } from "../terminal/jsonMode";
import type { EnvironmentVariable } from "./cliSchema";

/**
 * **Every environment variable the CLI reads, as `pithy schema` publishes it (#697).**
 *
 * The names come from the modules that read them, never restated, so renaming one renames it here.
 * `environment.test.ts` scans the source for `PITHY_` names and fails on one this list does not publish —
 * a variable an agent cannot discover is a setting it cannot use.
 */

/** Any non-blank value: the house rule for the CLI's own on-off variables. */
const ANY = "any non-blank value";

/**
 * The four credentials the Cloudflare overlay reads, each described. Keyed on the overlay's own list, so a
 * fifth key there is a type error here until somebody says what it is.
 */
const CLOUDFLARE_KEYS: Record<(typeof CLOUDFLARE_ENV_KEYS)[number], string> = {
  CLOUDFLARE_ACCOUNT_ID: "The Cloudflare account to act in. Overlays <config>/cloudflare.json, key by key.",
  CLOUDFLARE_API_TOKEN: "The bootstrap API token. Overlays <config>/cloudflare.json, key by key.",
  SECRETS_STORE_ID: "The Secrets Store to write to. Overlays <config>/cloudflare.json, key by key.",
  R2_CREDENTIALS: "R2 access credentials. Overlays <config>/cloudflare.json, key by key.",
};

/** Every variable, in the order `docs/commands/schema.md` lists them. */
export const ENVIRONMENT_VARIABLES: readonly EnvironmentVariable[] = [
  {
    name: NONINTERACTIVE_ENV,
    values: "`1`",
    description: "Forbid every prompt for the session. Any other value is refused.",
  },
  {
    name: JSON_MODE_ENV,
    values: "`compact` or `pretty`",
    description: "Settle how every --json line is formatted, for the session. Any other value is refused.",
  },
  {
    name: PITHY_OFFLINE_ENV,
    values: ANY,
    description: "Refuse ambient Cloudflare credentials and network probes.",
  },
  {
    name: CONFIG_DIR_ENV,
    values: "a directory path",
    description: "Move the per-machine config directory: credentials, dev secrets, the port registry.",
  },
  {
    name: NO_UPDATE_NOTIFIER_ENV,
    values: ANY,
    description: "Suppress the end-of-command update notice.",
  },
  { name: NO_OPEN_ENV, values: ANY, description: "Suppress every offer to open a link in a browser." },
  {
    name: SESSION_PROFILE_ENV,
    values: "set by pithy",
    description:
      "Set by pithy on a child whose Cloudflare credentials are a bound session's, so a pithy run inside it reads that pair as the session's own. Not one to set by hand.",
  },
  { name: NO_TUI_ENV, values: ANY, description: "Keep pithy dev to the plain stream, as --no-tui does." },
  { name: "NO_COLOR", values: ANY, description: "Turn color off." },
  { name: "FORCE_COLOR", values: ANY, description: "Turn color on, even where the stream is not a terminal." },
  ...Object.entries(CLOUDFLARE_KEYS).map(([name, description]) => ({ name, values: "the credential", description })),
  {
    name: CLOUDFLARE_ENV_VAR,
    values: "an environment name",
    description: "wrangler's own stanza selector. Read where a command hands wrangler a stanza.",
  },
];
