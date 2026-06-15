import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * The shape of a Cloudflare Workers Builds lifecycle event, as delivered to a subscribed queue.
 * A subscription (created via `workersProvisioner.setupBuildEventSubscription`) pushes one of these
 * each time a build changes state. Consumers validate the raw message through `WorkersBuildEvent`
 * before trusting it; ISO-string dates decode to `Date` via `JsonDate`, so the schema round-trips.
 */

/** Where a build's lifecycle currently sits. */
export const WorkersBuildStatus = z
  .enum(["queued", "initializing", "running", "stopped"])
  .describe("A Cloudflare Builds lifecycle state.");
export type WorkersBuildStatus = z.infer<typeof WorkersBuildStatus>;

/** The terminal result of a build, set once it reaches `stopped`. */
export const WorkersBuildOutcome = z
  .enum(["success", "fail", "skipped", "cancelled", "terminated"])
  .describe("The terminal outcome of a Cloudflare build.");
export type WorkersBuildOutcome = z.infer<typeof WorkersBuildOutcome>;

/** What kicked off a build. */
export const WorkersTriggerSource = z
  .enum(["push", "pull_request", "manual", "api"])
  .describe("What initiated a Cloudflare build.");
export type WorkersTriggerSource = z.infer<typeof WorkersTriggerSource>;

/** A build lifecycle event delivered to a subscribed queue. */
export const WorkersBuildEvent = z
  .object({
    build_id: z.string().describe("The build's unique identifier from CF Builds."),
    script_name: z.string().describe("The Worker script this build targets."),
    trigger_id: z.string().describe("The build trigger that initiated this build."),
    trigger_source: WorkersTriggerSource.describe("How the build was initiated."),
    status: WorkersBuildStatus.describe("The build's current lifecycle state."),
    outcome: WorkersBuildOutcome.nullish().describe("The final result, set once status reaches 'stopped'."),
    branch: z.string().describe("The git branch that was built."),
    commit_hash: z.string().describe("The git commit SHA that was built."),
    started_at: JsonDate.nullish().describe("When execution began (ISO-8601 on the wire, Date in JS)."),
    completed_at: JsonDate.nullish().describe("When the build finished (ISO-8601 on the wire, Date in JS)."),
    created_at: JsonDate.describe("When the build was queued (ISO-8601 on the wire, Date in JS)."),
  })
  .describe("A Cloudflare Workers Builds lifecycle event delivered to a subscribed queue.");
export type WorkersBuildEvent = z.output<typeof WorkersBuildEvent>;
