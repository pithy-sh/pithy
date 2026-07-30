// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { battleGame } from "./games/battle";
import { connectNGame } from "./games/connectN";
import { crapsGame } from "./games/craps";
import { registerGameModel } from "./model";

/**
 * Registers the built-in example games — imported for its side effect by the capability and the Durable
 * Object, so all three `kind`s resolve without either one importing the games directly. A bare
 * `import "../game/builtins"` is a side-effect import and is never tree-shaken away.
 *
 * These are *example games* built on the reusable pattern helpers (`simultaneous`, `turnBased`,
 * `wageringTable`) — they show how to layer a game, and an adopter adds their own the same way, with
 * `registerGameModel(myGame)` at worker load.
 */
export const BUILT_IN_GAMES = [battleGame, connectNGame, crapsGame];

for (const game of BUILT_IN_GAMES) registerGameModel(game);
