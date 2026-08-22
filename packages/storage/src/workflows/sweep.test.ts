// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createLogger } from "@pithy-sh/core/src/logger/logger";
import type { LogRecord } from "@pithy-sh/core/src/logger/record";
import { describe, expect, test } from "vitest";
import { reportSweep, type SweepResult } from "./sweep";

/**
 * How a run reports itself. The tally is the sweep's only visible output, so what an operator can
 * query for is behavior, not formatting: the counts must arrive as fields rather than inside a
 * message, and a capped run must be findable without reading every run that was not capped.
 */

const result = (overrides: Partial<SweepResult> = {}): SweepResult => ({
  reclaimedRows: 0,
  deletedObjects: 0,
  scannedObjects: 0,
  truncated: false,
  dryRun: false,
  ...overrides,
});

/** A logger whose sink keeps the finished records, so a test asserts on the shape Workers Logs indexes. */
function capture(): { log: ReturnType<typeof createLogger>; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { log: createLogger({ level: "debug", sink: (record) => records.push(record) }), records };
}

describe("reportSweep", () => {
  test("reports a completed run at info, with the whole tally in fields", () => {
    const { log, records } = capture();
    reportSweep(log, result({ reclaimedRows: 2, deletedObjects: 3, scannedObjects: 40 }));
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("info");
    expect(records[0]?.fields).toEqual({
      reclaimedRows: 2,
      deletedObjects: 3,
      scannedObjects: 40,
      truncated: false,
      dryRun: false,
    });
  });

  test("reports a capped run at warn — the bucket was left part-swept", () => {
    // Degraded but continuing: the run did its work and stopped early, so orphans survive until a
    // later pass. That is the one outcome worth alerting on, and it needs its own level to be found.
    const { log, records } = capture();
    reportSweep(log, result({ scannedObjects: 1_000_000, truncated: true }));
    expect(records[0]?.level).toBe("warn");
    expect(records[0]?.fields?.truncated).toBe(true);
  });

  test("carries dryRun, so a reporting run is not read as a reclaim that happened", () => {
    const { log, records } = capture();
    reportSweep(log, result({ reclaimedRows: 7, dryRun: true }));
    expect(records[0]?.fields?.dryRun).toBe(true);
  });
});
