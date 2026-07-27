import type { RatingAlgorithm } from "./algorithm";

/**
 * The rating-algorithm registry: `id` → its {@link RatingAlgorithm}. Populated with the built-ins
 * (`algorithm/builtins`) and any {@link registerRatingAlgorithm} an adopter adds. A byte-for-byte mirror
 * of multiplayer's game-model registry (`game/model.ts`) — the same load-time, last-write-wins shape.
 */
const registry = new Map<string, RatingAlgorithm>();

/**
 * Register a rating algorithm, making its `id` resolvable everywhere. Called at module load — the worker
 * entry imports the built-ins so every id is present before the first request. Re-registering an `id`
 * replaces it (last write wins), which is what lets an adopter override a built-in's tuning.
 */
export function registerRatingAlgorithm(algorithm: RatingAlgorithm): void {
  registry.set(algorithm.id, algorithm);
}

/** The algorithm for an `id`, or undefined if none is registered. */
export function resolveAlgorithm(id: string): RatingAlgorithm | undefined {
  return registry.get(id);
}

/** Every registered algorithm's `id`, for config validation and error messages. */
export function registeredAlgorithmIds(): string[] {
  return [...registry.keys()];
}

/** The fewest / most players an algorithm supports — the bounds config checks a game's roster against. */
export function algorithmBounds(algorithm: RatingAlgorithm): { min: number; max: number } {
  return { min: algorithm.minPlayers, max: algorithm.maxPlayers };
}
