// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * **Which version of its shape a `--json` payload is (#697).**
 *
 * Every command's payload carries `schemaVersion`: an integer per command, from `1`, bumped only by a change
 * that breaks a parser — a key removed or retyped. A key added does not bump it. The number is declared once,
 * on the command's contract (`contract/commandContract.ts`), and `pithy schema` publishes it from there.
 *
 * **Stamped by the formatter, never written at a call site.** A command has dozens of `formatJsonLine({ … })`
 * sites, several of them shared between commands, and a version typed at each one is a version one of them
 * forgets — the docs gate also reads those literals, and a call site reshaped to carry the number would stop
 * being one it can read. So the command runs inside its own version, installed here by `withContract`
 * around its `run`, and `formatJsonLine` and `formatJsonStreamLine` stamp whatever is installed.
 *
 * **Ambient, for the reason `progress.ts` is**: the formatter cannot know which command called it, and the
 * one thing that does is the span the command runs in. Outside any command — a test calling a formatter, a
 * build script — nothing is installed and nothing is stamped.
 */

const CURRENT = new AsyncLocalStorage<number>();

/** Run `work` as a command whose payload is at `version`. */
export function withSchemaVersion<T>(version: number, work: () => T): T {
  return CURRENT.run(version, work);
}

/** The version of the command running now, or `undefined` outside one. */
export function currentSchemaVersion(): number | undefined {
  return CURRENT.getStore();
}

/**
 * `payload` with the running command's `schemaVersion` — straight after `command`, so a line still reads
 * from its name, or first when it has none (`doctor`'s). Outside a command, `payload` itself, untouched.
 */
export function stampSchemaVersion(payload: Record<string, unknown>): Record<string, unknown> {
  const schemaVersion = currentSchemaVersion();
  if (schemaVersion === undefined) return payload;
  const rest = Object.entries(payload).filter(([key]) => key !== "schemaVersion");
  const at = rest.findIndex(([key]) => key === "command") + 1;
  return Object.fromEntries([...rest.slice(0, at), ["schemaVersion", schemaVersion], ...rest.slice(at)]);
}
