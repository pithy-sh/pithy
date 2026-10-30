// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/** What the console gate reads as, for one linter config or for every one a project holds. */
export type ConsoleGateReading =
  | {
      state: "enforced";
      /** The config read, or each config read joined with ` and ` when a project holds two. */
      file: string;
    }
  | {
      state: "off";
      file: string;
      /** The rule as this config's linter names it: `suspicious/noConsole` or `no-console`. */
      rule: string;
      reason: string;
      /**
       * Why it is off: never stated, stated below `error`, or the linter disabled. Only `unstated` is a config
       * `pithy privacy enable` writes into — the other two are a person's decision.
       */
      cause: "unstated" | "lowered" | "disabled";
    }
  | { state: "unverifiable"; file: string | null; reason: string };

/** The rule's effect on one Worker source file: on, or the first reason it is not. */
export type FileReading =
  | { state: "enforced" }
  | { state: "disabled"; why: string }
  | { state: "lowered"; why: string }
  | { state: "unstated"; path: string };

/** What {@link gateOf} needs beside the readings. */
export interface GateContext {
  /** The config's project-relative name. */
  file: string;
  /** The rule as the config's linter names it. */
  rule: string;
  /** Why the config cannot be read whole — an `extends` — or `null` when it can. */
  extended: string | null;
}

/**
 * One config's gate from its per-file readings. A disabled file is `off` first, then a lowered one. An extended
 * config's overrides can still turn the rule down, so neither `error` nor silence is a reading once those are
 * ruled out: it is `unverifiable`. A file the rule was never stated for is `off`, the one cause `enable` writes.
 */
export function gateOf(readings: readonly FileReading[], context: GateContext): ConsoleGateReading {
  const { file, rule } = context;
  const disabled = readings.find((reading) => reading.state === "disabled");
  if (disabled?.state === "disabled") return { state: "off", file, rule, cause: "disabled", reason: disabled.why };
  const lowered = readings.find((reading) => reading.state === "lowered");
  if (lowered?.state === "lowered") return { state: "off", file, rule, cause: "lowered", reason: lowered.why };
  if (context.extended !== null) return { state: "unverifiable", file, reason: context.extended };
  const unstated = readings.find((reading) => reading.state === "unstated");
  if (unstated?.state !== "unstated") return { state: "enforced", file };
  return { state: "off", file, rule, cause: "unstated", reason: `${rule} is not on for ${unstated.path} in ${file}.` };
}

/**
 * The project's gate from each linter config's. It is `enforced` only when every config is: one that is `off`
 * decides, since a lint run that fails nothing for that linter leaves `console` open; then one that is
 * `unverifiable`, since the other closing it proves nothing about the half Pithy could not read.
 */
export function combineGates(gates: readonly [ConsoleGateReading, ...ConsoleGateReading[]]): ConsoleGateReading {
  const off = gates.find((gate) => gate.state === "off");
  if (off !== undefined) return off;
  const unverifiable = gates.find((gate) => gate.state === "unverifiable");
  if (unverifiable !== undefined) return unverifiable;
  if (gates.length === 1) return gates[0];
  return { state: "enforced", file: gates.map((gate) => gate.file).join(" and ") };
}
