// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

// The Miniflare `main` for `*.workers.test.ts`: it registers the presence room's Durable Object class, so the
// `PRESENCE_ROOMS` test binding resolves, and the Workflow behind the `INTERLEAVED` binding. Its fetch is inert.
// It is named as a test so it is never built, published, or counted among the Workflows the kit ships.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { InternalError } from "./error/pithyError";
import type { Gate } from "./testing";

export { PresenceRoom } from "./presence/durableObject";

/** The two gates one `InterleavedWorkflow` run stops at: `held` it opens on arrival, `release` it waits on. */
export interface HeldRun {
  readonly held: Gate;
  readonly release: Gate;
}

/** What a test injects into `InterleavedWorkflow`: the gates for each run, and the log every run appends to. */
export const interleaved: { runs: Map<string, HeldRun>; log: string[] } = { runs: new Map(), log: [] };

/** A Workflow of three steps whose middle step stops at the gates the test registered for its run. */
export class InterleavedWorkflow extends WorkflowEntrypoint<unknown, { run: string }> {
  override async run(event: WorkflowEvent<{ run: string }>, step: WorkflowStep): Promise<void> {
    const { run } = event.payload;
    await step.do("start", async () => {
      interleaved.log.push(`${run}:start`);
    });
    await step.do("hold", async () => {
      const gates = interleaved.runs.get(run);
      if (gates === undefined) throw new InternalError({ message: `No gates are registered for run ${run}.` });
      interleaved.log.push(`${run}:held`);
      gates.held.open();
      await gates.release.opened();
    });
    await step.do("finish", async () => {
      interleaved.log.push(`${run}:finish`);
    });
  }
}

export default {
  fetch(): Response {
    return new Response("core test worker", { status: 200 });
  },
};
