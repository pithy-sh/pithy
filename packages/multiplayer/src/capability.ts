import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { Migration } from "kysely/migration";
import "./game/builtins";
import { MultiplayerConfig, type MultiplayerConfigInput, validateGames } from "./config/config";
import { multiplayerTables } from "./data/tables";
import { registerMultiplayerRoutes } from "./http/routes";
import { multiplayer_0001_results } from "./migrations/0001_results";
import { multiplayerExampleSeed } from "./seeds/example";

/**
 * Where multiplayer's migrations sort in the app database. Unique per database; the registry composes
 * keys like `0500_multiplayer_0001_results`. Sits after leaderboard (400).
 */
export const MULTIPLAYER_MIGRATION_ORDER = 500;

/** The Durable Object namespace binding name, and the class it is backed by — the CLI wires both. */
export const MULTIPLAYER_SESSIONS_BINDING = "SESSIONS";
export const MULTIPLAYER_SESSION_CLASS = "MultiplayerSession";

export type MultiplayerOptions = MultiplayerConfigInput & {
  /** Mount the routes somewhere other than `/multiplayer`. */
  basePath?: string;
};

export interface MultiplayerCapability extends Capability {
  multiplayerConfig: MultiplayerConfig;
}

/**
 * The multiplayer capability: authoritative, turn-based, two-player commit-reveal sessions.
 *
 * Fully optional. Config, migrations, routes, and bindings arrive only on `pithy add multiplayer`, and
 * `pithy remove multiplayer` is the clean inverse — including the Durable Object binding and its class
 * migration tag.
 *
 * This is Pithy's first Durable Object. Live session state — membership, hidden commits, the alarm-driven
 * commit deadline — lives in the DO's own storage, where authority and hidden state belong. D1 holds only
 * the durable *result*, joinable beside the adopter's own tables. The one thing a relay cannot do — hold
 * state neither client can read and resolve it — is the whole reason the capability exists.
 *
 * `dependsOn` is deliberately empty. Auth is a seam, not a peer: the routes read `c.var.auth` through
 * core's `AuthContext`, so without `@pithy-sh/auth` every route is denied rather than open. Leaderboard is
 * an *optional* one-way sink: a game may publish its result to a board, loaded by dynamic import so
 * `@pithy-sh/leaderboard` is never a hard dependency.
 */
export function multiplayer(options: MultiplayerOptions = { games: [] }): MultiplayerCapability {
  const { basePath, ...configInput } = options;
  // Parse the game set at assembly, then validate each game against its model — an unknown `kind`, a roster
  // outside the model's bounds, or an invalid `rules` block fails on deploy, not on the first session.
  const resolved = MultiplayerConfig.parse(configInput);
  const games = validateGames(resolved);

  const migrations: Record<string, Migration> = { "0001_results": multiplayer_0001_results };

  const requiredBindings: BindingSpecInput[] = [
    { type: "durable_object", name: MULTIPLAYER_SESSIONS_BINDING, className: MULTIPLAYER_SESSION_CLASS },
    { type: "d1", name: "DB" },
  ];

  const capability = defineCapability({
    name: "multiplayer",
    requiredBindings,
    config: MultiplayerConfig,
    databases: {
      app: {
        binding: "DB",
        tables: multiplayerTables(),
        migrationOrder: MULTIPLAYER_MIGRATION_ORDER,
        migrations,
      },
    },
    routes: registerMultiplayerRoutes({ games, basePath }),
    seeds: [multiplayerExampleSeed],
  });

  return Object.assign(capability, { multiplayerConfig: resolved });
}

export function isMultiplayerCapability(capability: Capability): capability is MultiplayerCapability {
  return capability.name === "multiplayer" && "multiplayerConfig" in capability;
}
