// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { describe, expect, it } from "vitest";
import type { MultiplayerOptions } from "./capability";
import {
  MULTIPLAYER_SESSION_CLASS,
  MULTIPLAYER_SESSION_MODULE,
  MULTIPLAYER_SESSIONS_BINDING,
  multiplayer,
} from "./capability";

/**
 * What `pithy add multiplayer` writes, checked by calling `multiplayer()` on it.
 *
 * The manifest is the only thing `pithy add` reads, so an option missing from it is an option missing
 * from the adopter's `pithy.config.ts`. `games` was missing, and a fresh scaffold failed `tsc` with
 * TS2345 before the adopter had touched anything (#168).
 *
 * `games: []` would have been the cheap fix, and it is the wrong one: `games` carries `.min(1)` with a
 * message saying why, so an empty seed compiles and then throws `too_small` on the first config load —
 * which `pithy upgrade` reports as "Could not load pithy.config.ts", naming the wrong cause. Both halves
 * are asserted here: `seeded` is annotated as `MultiplayerOptions`, so a shape the factory would reject
 * fails the compile, and calling the factory is what proves it survives the refusal.
 *
 * This file used to stand in for the factory, re-performing its two steps (`MultiplayerConfig.parse`
 * then `validateGames`) against a type-only import, because `./capability` reached
 * `session/durableObject` through the routes and that module imports `cloudflare:workers` — so calling
 * `multiplayer()` in a Node test was impossible. #172 split the Durable Object off the config path.
 * The stand-in is gone: this now calls the thing an adopter's `pithy.config.ts` calls.
 */
describe("pithy.manifest.json", () => {
  const manifest = CapabilityManifest.parse(
    JSON.parse(readFileSync(new URL("../pithy.manifest.json", import.meta.url), "utf8")),
  );

  /** Exactly the object `pithy add` renders: every option's key at its manifest default. */
  const rendered = Object.fromEntries(manifest.configOptions.map((option) => [option.key, option.default]));

  const seeded: MultiplayerOptions = {
    games: [{ key: "tic-tac-toe", kind: "connect-n", rules: { rows: 3, cols: 3, connect: 3 } }],
    basePath: "/multiplayer",
  };

  it("states every option MultiplayerConfig requires, at a value the type accepts", () => {
    expect(rendered).toEqual(seeded);
  });

  it("assembles a capability from the seed — an empty game set would not", () => {
    const capability = multiplayer(seeded);
    expect(capability.name).toBe("multiplayer");
    expect(capability.multiplayerConfig.games.map((game) => game.key)).toEqual(["tic-tac-toe"]);
    expect(() => multiplayer({ ...seeded, games: [] })).toThrow();
  });

  it("seeds a game whose kind resolves and whose rules pass that model's schema", () => {
    // `validateGames` runs at assembly, so a seed naming an unregistered model — or carrying a rules
    // block that model rejects — throws on deploy rather than on the adopter's first session. A 3x3
    // board where three in a line wins is tic-tac-toe: the smallest connect-n that can be won at all,
    // two players, no wagering, no ledger.
    const [game] = multiplayer(seeded).multiplayerConfig.games;
    expect(game?.kind).toBe("connect-n");
    expect(game?.players).toBe(2);
    expect(() => multiplayer({ games: [{ key: "g", kind: "no-such-model", rules: {} }] })).toThrow();
  });

  it("declares the Durable Object binding the manifest and the CLI wire", () => {
    // The factory is callable here, so the bindings it declares are checkable against the manifest the
    // CLI reads — the two statements of the same fact, and `pithy add` writes wrangler config from the
    // manifest while the runtime resolves against the capability.
    const bindings = multiplayer(seeded).requiredBindings;
    expect(bindings).toContainEqual(
      expect.objectContaining({
        type: "durable_object",
        name: MULTIPLAYER_SESSIONS_BINDING,
        className: MULTIPLAYER_SESSION_CLASS,
      }),
    );
    expect(manifest.requiredBindings).toContainEqual(
      expect.objectContaining({
        type: "durable_object",
        name: MULTIPLAYER_SESSIONS_BINDING,
        className: MULTIPLAYER_SESSION_CLASS,
      }),
    );
  });

  it("names the module the Durable Object is exported from, and it is not the entry point", () => {
    // `classModule` is what `pithy add` writes the worker entry's re-export against (#428), so a module
    // that does not export the class is a Worker that fails at bundle time — on a line the CLI wrote.
    // #172 moved the class out of `src/index`, which an adopter's `pithy.config.ts` imports in Node.
    for (const bindings of [multiplayer(seeded).requiredBindings, manifest.requiredBindings]) {
      const declared = bindings.find((binding) => binding.type === "durable_object");
      expect(declared?.classModule).toBe(MULTIPLAYER_SESSION_MODULE);
      expect(MULTIPLAYER_SESSION_MODULE).not.toContain("/src/index");
    }
  });
});
