// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

// The Miniflare `main` for `*.workers.test.ts`: it registers the Workflow behind the `RANK_REFRESH` binding, the
// rank refresh with a page of two instances so a handful of instances spans several runs. Its fetch is inert. It
// is named as a test so it is never built, published, or counted among the Workflows the kit ships.

import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Gate } from "@pithy-sh/core/src/testing";
import { RankPassContinuation } from "./worker";
import { RankRefreshWorkflow } from "./worker.entry";

/** The instances one run of {@link TestRankRefreshWorkflow} walks. */
export const TEST_INSTANCE_PAGE_SIZE = 2;

/** The two gates a continuation run stops at before it starts: `arrived` it opens, `release` it waits on. */
export interface HeldRankRun {
  readonly arrived: Gate;
  readonly release: Gate;
}

/**
 * What a test injects into {@link TestRankRefreshWorkflow}: the leaderboard config every run parses, the gates
 * each continuation run stops at, keyed by its run number, and the params every run received.
 */
export const rankRuns: { config: string; holds: Map<number, HeldRankRun>; payloads: unknown[] } = {
  config: "",
  holds: new Map(),
  payloads: [],
};

/** The rank refresh, walking two instances a run, reading the test's config, and holding each continuation. */
export class TestRankRefreshWorkflow extends RankRefreshWorkflow {
  protected override readonly instancePageSize = TEST_INSTANCE_PAGE_SIZE;

  override async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    rankRuns.payloads.push(event.payload);
    const continuation = RankPassContinuation.safeParse(event.payload);
    if (continuation.success) {
      const hold = rankRuns.holds.get(continuation.data.run);
      if (hold === undefined) {
        throw new InternalError({ message: `No gate is registered for rank run ${continuation.data.run}.` });
      }
      hold.arrived.open();
      await hold.release.opened();
    }
    this.env = { ...this.env, LEADERBOARD_CONFIG: rankRuns.config };
    await super.run(event, step);
  }
}

export default {
  fetch(): Response {
    return new Response("leaderboard test worker", { status: 200 });
  },
};
