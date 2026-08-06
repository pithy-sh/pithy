// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { LogRecord } from "@pithy-sh/core/src/logger/record";
import { createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import { describe, expect, test } from "vitest";
import { TestersCohortClosedError } from "../error/errors";
import type { CohortPassResult } from "./daily";
import { logCohortFailure, logPassComplete } from "./worker";

/**
 * The daily worker's two outputs, as records rather than as text.
 *
 * A workers-project test because the module imports `cloudflare:workers` to extend `WorkflowEntrypoint`;
 * a node test cannot load it. Nothing here runs a pass — the pass has its own suite. What is proved is
 * the part an operator depends on: that a pass's tally arrives as queryable fields, that a cohort that
 * sent nothing is not reported at the same level as one that ran clean, and that a failed cohort keeps
 * its error payload — `detail` included — instead of being flattened into a message.
 */

/** A logger whose records land in `records`, through the adapter's own injection point. */
function capture(): { records: LogRecord[]; log: ReturnType<typeof createWorkerLogger> } {
  const records: LogRecord[] = [];
  return { records, log: createWorkerLogger({ name: "testers:daily", emit: (record) => records.push(record) }) };
}

const PASS: CohortPassResult = {
  cohortId: "coh_1",
  snapshotOn: "2026-06-01",
  nudged: { confirm: 2, store: 0, inactive: 1, closing: 0 },
  estimatedOptedInCount: 9,
  estimatedHeldDays: 3,
  trendDirection: "improving",
  pruned: 0,
};

describe("logPassComplete", () => {
  test("carries the tally as fields, not as a serialized string", () => {
    const { records, log } = capture();
    logPassComplete(log, [PASS]);

    expect(records).toHaveLength(1);
    const record = records[0];
    if (!record) throw new Error("no record");
    expect(record.name).toBe("testers:daily");
    expect(record.fields).toMatchObject({ cohorts: 1, skipped: 0 });
    expect(record.fields?.results).toMatchObject([{ cohortId: "coh_1", estimatedOptedInCount: 9 }]);
    // The point of the change: no `{` in the message means nothing was stringified into it.
    expect(record.msg).not.toContain("{");
  });

  test("a pass that chased normally is info", () => {
    const { records, log } = capture();
    logPassComplete(log, [PASS, { ...PASS, cohortId: "coh_2" }]);
    expect(records[0]?.level).toBe("info");
    expect(records[0]?.fields).toMatchObject({ cohorts: 2, skipped: 0 });
  });

  test("a cohort that could send nothing is warn — the pass ran and nobody was chased", () => {
    // The failure this capability cannot afford: a daily job that fires, advances state, mails nobody,
    // and reports it at the same level as a clean run. `no_base_url` is silent by construction.
    const { records, log } = capture();
    logPassComplete(log, [PASS, { ...PASS, cohortId: "coh_2", nudgesSkipped: "no_base_url" }]);
    expect(records[0]?.level).toBe("warn");
    expect(records[0]?.fields).toMatchObject({ cohorts: 2, skipped: 1 });
  });
});

describe("logCohortFailure", () => {
  test("a PithyError keeps its whole payload, `detail` included", () => {
    // The reserved `error` field is the whole reason this is not `log.error(msg, cohortId, error)`:
    // positionally, the code, the status and the throw-site detail all reduce to whatever the runtime
    // felt like printing. A log is an internal surface, so `detail` is the field worth keeping.
    const { records, log } = capture();
    logCohortFailure(log, "coh_1", new TestersCohortClosedError({ detail: "cohort coh_1 was closed at noon" }));

    expect(records).toHaveLength(1);
    const record = records[0];
    if (!record) throw new Error("no record");
    expect(record.level).toBe("error");
    expect(record.fields).toMatchObject({ cohort: "coh_1" });
    expect(record.error?.code).toBe("testers/cohort_closed");
    expect(record.error?.status).toBe(409);
    expect(record.error?.detail).toBe("cohort coh_1 was closed at noon");
  });

  test("a failure that is not ours still says what happened", () => {
    // A D1 blip is a plain `Error`, whose message and stack are non-enumerable — put it in the reserved
    // field and it serializes to `{}`, which is worse than the console line it replaced.
    const { records, log } = capture();
    logCohortFailure(log, "coh_2", new Error("D1_ERROR: network"));

    const record = records[0];
    if (!record) throw new Error("no record");
    expect(record.level).toBe("error");
    expect(record.error).toBeUndefined();
    expect(record.fields).toMatchObject({ cohort: "coh_2", reason: "D1_ERROR: network" });
  });
});
