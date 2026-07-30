// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ErrorPayload } from "./payload";

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
