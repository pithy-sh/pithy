// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Capability, defineCapability, type PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { PurgeContext } from "@pithy-sh/core/src/capability/purge";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { type AppTool, appTools } from "@pithy-sh/core/src/mcp/tools";
import { routeGroupsOf } from "@pithy-sh/core/src/openapi/routeGroups";
import type { Hono } from "hono";
import { z } from "zod";
import { isAuthCapability } from "../capability";
import { authPluginPlan } from "../migrations/pluginTables";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../version.generated";
import { floorLine, isOpenToEverySignedInUser, McpFloor } from "./floor";
import type { McpHost, McpWiring } from "./host";
import { registerMcpRoutes } from "./http/routes";
import { MCP_CAPABILITY_NAME } from "./marker";
import { mcpAuthorizationServer } from "./provider";
import { eraseMcpUser, exportMcpUser } from "./purge";

/**
 * The MCP capability: the app's own agent surface, authorized as a user (`docs/AGENT-ACCESS.md` §4).
 *
 * **An agent that uses an application is a user of it.** It acts *as somebody*, with that person's authorization,
 * through the app's own routes — never through the control-plane seam, which creates no user and no session. So
 * this capability composes an OAuth 2.1 authorization server into the auth instance (`./provider.ts`), serves a
 * streamable HTTP MCP endpoint (`./routes.ts`), and offers each caller the routes their role reaches as tools
 * (`@pithy-sh/core/src/mcp/tools.ts`). Composing it mounts the endpoint; the adopter writes no route.
 *
 * **The default is closed.** It is off until composed, and composing it means choosing a {@link McpFloor}.
 */

/** The migration order of the provider's tables in the `app` database. */
export const MCP_MIGRATION_ORDER = 1700;

/** The MCP capability's configuration. */
export const McpConfig = z
  .object({
    path: z
      .string()
      .regex(/^\/[a-z0-9/_-]*[a-z0-9]$/, "A path like `/mcp`.")
      .default("/mcp")
      .describe("Where the MCP endpoint mounts. A client is pointed at `<origin><path>`. Defaults to `/mcp`."),
    floor: McpFloor,
    consentPath: z
      .string()
      .regex(/^\/[A-Za-z0-9/_-]*$/, "A path like `/agent-consent`.")
      .default("/agent-consent")
      .describe(
        "The scaffolded consent screen's path in this Worker's front end. Both sign-in and consent for an agent land there. Defaults to `/agent-consent`, which `pithy ui` writes.",
      ),
    database: z
      .string()
      .default("DB")
      .describe("The D1 binding auth uses. The provider's tables live beside auth's. Must match `auth({ database })`."),
  })
  .describe("Configuration for the MCP capability.");
export type McpConfig = z.output<typeof McpConfig>;
export type McpConfigInput = z.input<typeof McpConfig>;

/** The MCP capability, with its resolved config attached for inspection. */
export interface McpCapability extends Capability {
  readonly mcpConfig: McpConfig;
  /** What auth composes into its instance. */
  readonly mcpWiring: McpWiring;
  /** Every tool the composed app offers, before any caller's role filters it. Empty until the app is built. */
  readonly tools: () => readonly AppTool[];
  /** Whether the endpoint is open to every signed-in user, and the floor in one line. Read by `pithy doctor`. */
  readonly floorReport: { readonly open: boolean; readonly line: string };
}

/** The provider's tables, derived once from the plugin itself. Its options shape no column, so any resource does. */
const providerPlan = authPluginPlan([
  mcpAuthorizationServer({ resource: "https://schema.invalid/mcp", consentPage: "/agent-consent" })[0],
]);

/** The one migration that plan holds: the plugin's tables, under this capability's own namespace. */
export const PROVIDER_MIGRATION = (() => {
  const [migration] = Object.values(providerPlan.migrations);
  if (migration === undefined) {
    throw new ValidationError({
      message: "The OAuth provider declared no tables.",
      detail: "authPluginPlan derived no migration for the oauth-provider plugin",
    });
  }
  return migration;
})();

/** Refuse a composition this capability cannot serve, naming what to change. */
function hostFrom(capabilities: readonly Capability[], config: McpConfig): McpHost {
  const authCap = capabilities.find(isAuthCapability);
  if (!authCap) {
    throw new ValidationError({
      message: "The mcp capability requires the auth capability.",
      action: "Add `auth(...)` to your capabilities. An agent acts as a signed-in user, and auth is who signs them in.",
    });
  }
  if (authCap.authConfig.database !== config.database) {
    throw new ValidationError({
      message: "The mcp capability and the auth capability name different databases.",
      action: `Set mcp({ database: "${authCap.authConfig.database}" }). The provider's tables live beside auth's.`,
      detail: `mcp database ${config.database}, auth database ${authCap.authConfig.database}`,
    });
  }
  const pluginIds = authCap.authConfig.plugins.map((plugin) => plugin.id);
  if (pluginIds.includes("oauth-provider")) {
    throw new ValidationError({
      message: "auth({ plugins }) already composes an OAuth provider.",
      action:
        "Remove oauthProvider() from auth({ plugins: [...] }). The mcp capability composes the one this endpoint uses.",
    });
  }
  return authCap.mcpHost;
}

/** The MCP capability. */
export function mcp(options: McpConfigInput): McpCapability {
  const config = McpConfig.parse(options);
  const wiring: McpWiring = { path: config.path, consentPage: config.consentPath };
  let host: McpHost | undefined;
  let app: Hono<PithyHonoEnv> | undefined;
  let tools: readonly AppTool[] | undefined;

  const ready = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) {
      throw new ValidationError({
        message: "The mcp capability is not composed.",
        action: "Compose it through createBackend; it needs the auth capability beside it.",
        detail: `mcp read its ${what} before createBackend composed it`,
      });
    }
    return value;
  };

  const capability = defineCapability({
    name: MCP_CAPABILITY_NAME,
    version: PACKAGE_VERSION,
    package: PACKAGE_NAME,
    config: McpConfig,
    dependsOn: ["auth"],
    requiredBindings: [{ type: "d1", name: config.database }],
    databases: {
      app: {
        binding: config.database,
        tables: {},
        migrationOrder: MCP_MIGRATION_ORDER,
        migrations: { "0001_init": PROVIDER_MIGRATION },
      },
    },
    purge: [
      {
        subject: "user",
        summary:
          "Every application the person let act as them: the consents, and the access and refresh tokens minted under them. A dynamically registered client is the application's, not the person's, and stays.",
        erase: (context: PurgeContext) => eraseMcpUser(context, config.database),
        export: (context: PurgeContext) => exportMcpUser(context, config.database),
      },
    ],
    compose: ({ capabilities }) => {
      host = hostFrom(capabilities, config);
    },
    routes: (router) => {
      app = router as unknown as Hono<PithyHonoEnv>;
      registerMcpRoutes(router as unknown as Hono<PithyHonoEnv>, {
        path: config.path,
        floor: config.floor,
        host: () => ready(host, "auth host"),
        app: () => ready(app, "router"),
        tools: () => {
          // Read once, after `createBackend` has recorded every capability's routes — the first request is the
          // earliest moment the whole table exists, and it does not change afterwards.
          tools ??= appTools(routeGroupsOf(ready(app, "router")) ?? []);
          return tools;
        },
      });
    },
  });

  return Object.assign(capability, {
    mcpConfig: config,
    mcpWiring: wiring,
    tools: () => tools ?? (app ? appTools(routeGroupsOf(app) ?? []) : []),
    floorReport: { open: isOpenToEverySignedInUser(config.floor), line: floorLine(config.floor) },
  });
}
