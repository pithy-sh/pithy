// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assign, parse } from "comment-json";
import { writeJsonc } from "../project/jsonc";
import {
  type GateLinter,
  NO_CONSOLE_OVERRIDE,
  OXLINT_NO_CONSOLE_OVERRIDE,
  readConsoleGate,
  readLinterGates,
} from "./consoleGate";
import type { ConsoleGateReading } from "./gateReading";

/**
 * **Close `console` in a project's Worker source: the lint half of `pithy privacy enable`.**
 *
 * It writes one thing into each linter config the project root holds — an `overrides` entry setting the rule to
 * `error` on every linted file under `apps/*\/src`, tests aside: {@link NO_CONSOLE_OVERRIDE} for Biome,
 * {@link OXLINT_NO_CONSOLE_OVERRIDE} for Oxlint — and only into a config where the rule is **not stated at all**.
 * Three cases write nothing into a config, each on purpose:
 *
 * - **Already enforced.** A re-run is a no-op.
 * - **Stated and turned down** — `warn`, `off`, an override lowering it, the linter disabled. That is the adopter's
 *   decision, made on purpose; overriding it silently would make Pithy the owner of a file it does not own. The gate
 *   stays `off`, the reason says why, and `pithy deploy` refuses until a person changes it.
 * - **A config Pithy cannot read.** The gate is `unverifiable`, and deploy says so on every run.
 *
 * With no linter config at all it writes nothing either: creating one would decide an adopter's toolchain.
 *
 * After a write the gate is read back from the files, so what this reports is what the deploy gate will read.
 */

/** What {@link closeConsole} did, and the gate it left. */
export interface ClosedConsole {
  /** The linter configs written, project-relative, in the order the gate reads them. Empty when none was. */
  written: { linter: GateLinter; file: string }[];
  /** The gate as read after the run, across every linter config. */
  gate: ConsoleGateReading;
}

/** Close `console` in each of `projectDir`'s linter configs, where that is Pithy's to do. See the module note. */
export async function closeConsole(projectDir: string): Promise<ClosedConsole> {
  const written: ClosedConsole["written"] = [];
  for (const { linter, gate } of await readLinterGates(projectDir)) {
    if (gate.state !== "off" || gate.cause !== "unstated") continue;
    const path = join(projectDir, gate.file);
    const config = parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const overrides = Array.isArray(config.overrides) ? config.overrides : [];
    overrides.push(structuredClone(linter === "biome" ? NO_CONSOLE_OVERRIDE : OXLINT_NO_CONSOLE_OVERRIDE));
    assign(config, { overrides });
    await writeJsonc(path, config);
    written.push({ linter, file: gate.file });
  }
  return { written, gate: await readConsoleGate(projectDir) };
}
