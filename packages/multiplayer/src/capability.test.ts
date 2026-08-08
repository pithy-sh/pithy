// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { describe, expect, it } from "vitest";
import type { MultiplayerOptions } from "./capability";
import { MultiplayerConfig, validateGames } from "./config/config";
import "./game/builtins";

/**
 * What `pithy add multiplayer` writes, checked against what `multiplayer()` accepts.
 *
 * The manifest is the only thing `pithy add` reads, so an option missing from it is an option missing
 * from the adopter's `pithy.config.ts`. `games` was missing, and a fresh scaffold failed `tsc` with
 * TS2345 before the adopter had touched anything (#168).
 *
 * `games: []` would have been the cheap fix, and it is the wrong one: `games` carries `.min(1)` with a
 * message saying why, so an empty seed compiles and then throws `too_small` on the first config load —
 * which `pithy upgrade` reports as "Could not load pithy.config.ts", naming the wrong cause. Both halves
 * are asserted here: `seeded` is annotated as `MultiplayerOptions`, so a shape the factory would reject
 * fails the compile, and parsing plus `validateGames` is what proves it survives the refusal.
 *
 * The two steps the capability performs, rather than the capability itself: `./capability` reaches
 * `session/durableObject`, which imports `cloudflare:workers` and resolves in workerd and nowhere else
 * — the same reason `schema-descriptions.test.ts` excludes that module. `MultiplayerOptions` still
 * arrives from it, as a type-only import that erases.
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

  /** The two steps `multiplayer()` performs on its options, in order. */
  const assemble = (options: MultiplayerOptions) => {
    const { basePath: _basePath, ...config } = options;
    return validateGames(MultiplayerConfig.parse(config));
  };

  it("states every option MultiplayerConfig requires, at a value the type accepts", () => {
    expect(rendered).toEqual(seeded);
  });

  it("seeds a game the config will actually load — an empty array would not", () => {
    expect(assemble(seeded).map((game) => game.key)).toEqual(["tic-tac-toe"]);
    expect(() => assemble({ ...seeded, games: [] })).toThrow();
  });

  it("seeds a game whose kind resolves and whose rules pass that model's schema", () => {
    // `validateGames` runs at assembly, so a seed naming an unregistered model — or carrying a rules
    // block that model rejects — throws on deploy rather than on the adopter's first session. A 3x3
    // board where three in a line wins is tic-tac-toe: the smallest connect-n that can be won at all,
    // two players, no wagering, no ledger.
    const [game] = assemble(seeded);
    expect(game?.kind).toBe("connect-n");
    expect(game?.players).toBe(2);
    expect(() => assemble({ games: [{ key: "g", kind: "no-such-model", rules: {} }] })).toThrow();
  });
});
