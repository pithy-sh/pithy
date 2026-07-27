import { elo } from "./builtins/elo";
import { glicko } from "./builtins/glicko";
import { trueskill } from "./builtins/trueskill";
import { registerRatingAlgorithm } from "./registry";

/**
 * The three built-in rating algorithms, registered at module load — the exact mirror of multiplayer's
 * `game/builtins.ts`. Importing this module (the capability does, once) makes `elo`, `glicko`, and
 * `trueskill` resolvable everywhere before the first request. An adopter registers their own the same way
 * with `registerRatingAlgorithm`.
 */
export const BUILT_IN_ALGORITHMS = [elo, glicko, trueskill];

for (const algorithm of BUILT_IN_ALGORITHMS) {
  registerRatingAlgorithm(algorithm);
}
