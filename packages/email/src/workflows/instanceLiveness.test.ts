// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { isLiveInstanceStatus } from "./instanceLiveness";

/**
 * Which Workflow instance statuses mean a batch is still coming (pithy-sh/pithy#342).
 *
 * The vocabulary below is Cloudflare's, written out here rather than imported, and the classification is
 * the scheduler's own reading of it. That is deliberate: a table built from the module's set would say
 * only that the module contains what it contains. This says what each of the platform's answers is
 * allowed to cost — a wrong "live" strands emails forever, a wrong "dead" sends someone two.
 */
const PLATFORM_STATUSES: readonly { status: string; live: boolean; because: string }[] = [
  { status: "queued", live: true, because: "the instance exists and will start" },
  { status: "running", live: true, because: "a step is executing, or waiting out its retry backoff" },
  { status: "waiting", live: true, because: "it is parked on an event and will resume" },
  { status: "waitingForPause", live: true, because: "it is still executing until the pause lands" },
  { status: "paused", live: true, because: "it is resumable and still owns its rows" },
  { status: "errored", live: false, because: "every retry is spent; nothing more will run" },
  { status: "terminated", live: false, because: "it was stopped and will not resume" },
  { status: "complete", live: false, because: "its body returned; it will not touch another job" },
  { status: "unknown", live: false, because: "an answer that says nothing may not vouch for a batch" },
];

describe("isLiveInstanceStatus", () => {
  // A gate over a lopsided table is a gate that can pass by answering one way. Both halves are real.
  test("the classification covers both outcomes", () => {
    expect(PLATFORM_STATUSES.filter((s) => s.live).length).toBeGreaterThan(1);
    expect(PLATFORM_STATUSES.filter((s) => !s.live).length).toBeGreaterThan(1);
  });

  for (const { status, live, because } of PLATFORM_STATUSES) {
    test(`${status} is ${live ? "live" : "dead"} — ${because}`, () => {
      expect(isLiveInstanceStatus(status)).toBe(live);
    });
  }

  test("a status this code has never heard of is dead", () => {
    // The open-world default, and the reason the set is named for the live states rather than the dead
    // ones. A status the platform adds tomorrow costs a duplicate render that `runSend` short-circuits
    // for anything already `sent`; the opposite mistake costs an email that is never sent at all.
    for (const status of ["", "sleeping", "RUNNING", "Complete", "queued "]) {
      expect(isLiveInstanceStatus(status), `${JSON.stringify(status)} was treated as live`).toBe(false);
    }
  });
});
