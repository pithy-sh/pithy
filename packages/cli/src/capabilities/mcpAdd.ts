// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ConfigOption } from "@pithy-sh/core/src/capability/manifest";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { ConflictError, InputRequiredError } from "@pithy-sh/core/src/error/pithyError";
import type { ConfigValue } from "./add";
import { locateRegistration, objectProperties } from "./reconcile";

/** The capability this module writes the rules for. */
export const MCP_CAPABILITY = "mcp";

/** The package of the OAuth provider `mcp()` composes into auth itself. */
const OAUTH_PROVIDER_PACKAGE = "@better-auth/oauth-provider";

/** The binding `auth()` uses when its registration names none. */
const AUTH_DEFAULT_DATABASE = "DB";

/** What auth's registration says about its database: a binding, or nothing this can read. */
type AuthDatabase = { readonly known: true; readonly binding: string } | { readonly known: false };

/** A string literal's value, or `undefined` for anything else. */
function stringLiteral(text: string): string | undefined {
  const match = /^(["'])([^"'\\]*)\1$/.exec(text.trim());
  return match?.[2];
}

/**
 * The D1 binding the Worker's `auth()` registration uses, read from the config source.
 *
 * Called once auth is composed, so a registration this cannot locate, such as `auth(authOptions)`, is one it
 * cannot read rather than an absent one.
 */
export function authDatabase(source: string): AuthDatabase {
  const location = locateRegistration(source, "auth");
  if (location === null) return { known: false };
  if (location.form === "oneliner") return { known: true, binding: AUTH_DEFAULT_DATABASE };
  const property = objectProperties(source, location.openIndex, location.closeIndex).find(
    (candidate) => candidate.key === "database",
  );
  if (property === undefined) {
    return location.statesKey("database") ? { known: false } : { known: true, binding: AUTH_DEFAULT_DATABASE };
  }
  const binding = stringLiteral(source.slice(property.valueStart, property.valueEnd));
  return binding === undefined ? { known: false } : { known: true, binding };
}

/** The options a person is asked about for mcp: all of them, minus `database` when auth's registration answers it. */
export function mcpPromptOptions(source: string, options: readonly ConfigOption[]): readonly ConfigOption[] {
  return authDatabase(source).known ? options.filter((option) => option.key !== "database") : options;
}

/** Whether the Worker's config already composes an OAuth provider into auth. */
export function composesOAuthProvider(source: string): boolean {
  const specifier = OAUTH_PROVIDER_PACKAGE.replace(/[/.]/g, "\\$&");
  if (new RegExp(`from\\s*["']${specifier}["']`).test(source)) return true;
  const location = locateRegistration(source, "auth");
  if (location === null || location.form === "oneliner") return false;
  return /\boauthProvider\s*\(/.test(source.slice(location.openIndex, location.closeIndex));
}

/** What {@link mcpConfigValues} needs: the Worker's config source, the values so far, and the run to name again. */
export interface McpConfigValuesOptions {
  /** The Worker's `pithy.config.ts`, after any prerequisite was composed into it. */
  readonly source: string;
  /** The values `--set`, `--floor` and the prompt settled. */
  readonly values: Readonly<Record<string, ConfigValue>>;
  /** The `pithy add` a refusal names again. */
  readonly again: string;
}

/**
 * The values `pithy add mcp` writes: the caller's, with `database` set to the one auth uses.
 *
 * Refuses a config that already composes an OAuth provider into auth, because `mcp()` composes the one its
 * endpoint uses and `createBackend` refuses two. Refuses a `database` that differs from auth's, and one it
 * cannot read from auth's registration and the caller did not name.
 */
export function mcpConfigValues({ source, values, again }: McpConfigValuesOptions): Record<string, ConfigValue> {
  if (composesOAuthProvider(source)) {
    throw new ConflictError({
      message: "auth({ plugins }) already composes an OAuth provider.",
      action: `Remove oauthProvider() from auth({ plugins: [...] }) and its import, then run ${again} again. mcp composes the one its endpoint uses.`,
      detail: `The Worker's pithy.config.ts names ${OAUTH_PROVIDER_PACKAGE} or calls oauthProvider() in auth's registration.`,
    });
  }
  const auth = authDatabase(source);
  const named = values.database;
  if (auth.known && named !== undefined && named !== auth.binding) {
    throw new ConflictError({
      message: `mcp names database ${String(named)}, and auth uses ${auth.binding}.`,
      action: `Drop --set database, or pass --set database=${auth.binding}. The provider's tables live beside auth's.`,
    });
  }
  if (auth.known) return { ...values, database: auth.binding };
  if (named !== undefined) return { ...values };
  throw new InputRequiredError({
    flag: "--set",
    message: "mcp needs auth's database binding, and auth's registration does not name it as a string.",
    action: "Pass --set database=<the D1 binding auth uses>. The provider's tables live beside auth's.",
  });
}

/** What `pithy add mcp` says follows it: the two screens, and how a route becomes a tool. */
export function mcpNotes(): string[] {
  return [
    `Run ${commandName("ui add")} for the agent-consent and connected-applications screens. An agent's user signs in and approves on the first, and revokes on the second.`,
    "A route is a tool only when it says so: describeRoute({ operation, tool: true }) on a GET, describeRoute({ operation, tool: { effect } }) on anything else, with the effect writes, sends, charges or deletes.",
  ];
}
