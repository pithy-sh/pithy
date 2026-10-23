// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The longest reason the kit stores. It is shown to the person, so it is a sentence, not a case file.
 *
 * A leaf with no imports, because two programs read it: the transitions, which refuse a longer one, and the
 * request schemas in `../http/schemas.ts`, which a browser program compiles (`tooling/browser-scopes`). Kept
 * in `./transitions.ts`, it pulled the email capability and the Workers types into that program (#621).
 */
export const MAX_REASON = 500;
