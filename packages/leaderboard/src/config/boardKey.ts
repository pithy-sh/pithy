// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The key shapes, in a module that imports nothing: a request schema compiles into a management client's
 * browser build, and the config module beside it pulls in a cron parser.
 *
 * A board key is a URL path segment (`/leaderboard/<key>/top`), so it is kebab-case and lowercase.
 */
export const BOARD_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A board family's key pattern: one static prefix segment, shaped like a board key, then one named id
 * segment — `level/:levelId`. An instance of the family is the board keyed `level/<id>`, addressed at
 * `/leaderboard/level/<id>`.
 */
export const FAMILY_PATTERN = /^([a-z0-9][a-z0-9-]*)\/:([A-Za-z][A-Za-z0-9]*)$/;

/**
 * The id half of an instance key. Looser than a board key, because these ids come from content rather
 * than from config: a level's slug, a UUID, a nanoid a player-made level was published under.
 */
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** How long an instance id may be. A UUID or a SHA-256 in hex fits. */
export const MAX_INSTANCE_ID_LENGTH = 64;

/**
 * Ids no instance can take. `POST /leaderboard/<prefix>/segment` is the segment read of a board keyed
 * `<prefix>`, so an instance under that id could take no submission.
 */
export const RESERVED_INSTANCE_IDS: ReadonlySet<string> = new Set(["segment"]);

/** Whether `id` can name an instance of a family. */
export function isInstanceId(id: string): boolean {
  return id.length <= MAX_INSTANCE_ID_LENGTH && INSTANCE_ID_PATTERN.test(id) && !RESERVED_INSTANCE_IDS.has(id);
}
