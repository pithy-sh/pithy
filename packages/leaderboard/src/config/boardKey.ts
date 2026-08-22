// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The board-key pattern, in the one module that has no reason to import anything (#430).
 *
 * Both `config/config.ts` and `http/schemas.ts` constrain a board key with this regex, and the schema
 * used to take it from the config module. That module validates a board's cron window through
 * `window/schedule.ts`, which imports `croner` — so a request schema, which a management client compiles
 * in a browser to build a call, was dragging a cron parser in to spell one regex. `croner` runs in a
 * browser perfectly well, and that is exactly why widening the allowlist would have been the wrong fix:
 * the rule is what a browser build may reach, not what it can survive.
 *
 * A board key is a URL path segment (`/leaderboard/<key>/top`), so it is kebab-case and lowercase.
 */
export const BOARD_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
