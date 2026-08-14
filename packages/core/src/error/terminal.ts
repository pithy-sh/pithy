// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ErrorPayload } from "./payload";
import { PublicErrorPayload } from "./payload";

/**
 * Render an error for the terminal: the public `message` becomes the problem line and the
 * optional `action` the action line — the two-line brand-voice shape `docs/CLI.md` §3.3 specifies.
 * This unifies the CLI's error output into the one `PithyError` family: the CLI catches a
 * `PithyError`, colorizes the first line via its `style.ts`, and prints this. `detail` is internal
 * and never rendered. The same payload that encodes to HTTP renders here — one error, two surfaces.
 */
export function renderTerminal(payload: ErrorPayload): string {
  return payload.action ? `${payload.message}\n${payload.action}` : payload.message;
}

/** An error as an operator's machine surface states it: the wire fields, plus the remedy. */
export type OperatorError = PublicErrorPayload & { action?: string };

/**
 * The machine-readable projection for an **operator's** consumer — the CLI's `--json` error line.
 *
 * The same audience as {@link renderTerminal}, in the shape a script can read. `action` belongs on it
 * for the reason it belongs on the terminal: whoever runs `pithy secrets create --json` is the person
 * who can act on "Bind a D1 database named DB in wrangler.jsonc". Dropping it because the *HTTP*
 * surface must would be classifying the field by the encoder that happened to be reused rather than
 * by who is reading.
 *
 * `detail` is still gone, and gone by the same schema that removes it on the wire — the public parse.
 * One rule, applied twice, rather than a second rule here that could drift from the first.
 */
export function operatorError(payload: ErrorPayload): OperatorError {
  const wire = PublicErrorPayload.parse(payload);
  return payload.action === undefined ? wire : { ...wire, action: payload.action };
}
