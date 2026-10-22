// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assign, parse } from "comment-json";
import { writeJsonc } from "../project/jsonc";
import { type ConsoleGateReading, NO_CONSOLE_OVERRIDE, readConsoleGate } from "./consoleGate";

/**
 * **Close `console` in a project's Worker source: the Biome half of `pithy privacy enable`** (#132).
 *
 * It writes one thing — an `overrides` entry setting `suspicious/noConsole` to `error` on every linted file
 * under `apps/*\/src` ({@link NO_CONSOLE_OVERRIDE}) — and only into a config where the rule is **not stated at
 * all**. Three cases write nothing, each on purpose:
 *
 * - **Already enforced.** A re-run is a no-op.
 * - **Stated and turned down** — `warn`, `off`, an override lowering it, the linter disabled. That is the
 *   adopter's decision, made on purpose; overriding it silently would make Pithy the owner of a file it does not
 *   own. The gate stays `off`, the reason says why, and `pithy deploy` refuses until a person changes it.
 * - **No Biome config, or one Pithy cannot read.** Creating a `biome.jsonc` would decide an adopter's toolchain.
 *   The gate is `unverifiable`, and deploy says so on every run.
 *
 * After a write the gate is read back from the file, so what this reports is what the deploy gate will read.
 */

/** What {@link closeConsole} did, and the gate it left. */
export interface ClosedConsole {
  /** Whether the Biome config was written. */
  written: boolean;
  /** The gate as read after the run. */
  gate: ConsoleGateReading;
}

/** Close `console` in `projectDir`'s Biome config, where that is Pithy's to do. See the module note. */
export async function closeConsole(projectDir: string): Promise<ClosedConsole> {
  const gate = await readConsoleGate(projectDir);
  if (gate.state !== "off" || gate.cause !== "unstated") return { written: false, gate };
  const path = join(projectDir, gate.file);
  const config = parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const overrides = Array.isArray(config.overrides) ? config.overrides : [];
  overrides.push(structuredClone(NO_CONSOLE_OVERRIDE));
  assign(config, { overrides });
  await writeJsonc(path, config);
  return { written: true, gate: await readConsoleGate(projectDir) };
}
