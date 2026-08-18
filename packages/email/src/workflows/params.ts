// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * What each of email's two durable jobs is started with.
 *
 * Declared here rather than inline on the capability because **three places now need the same
 * object**: the capability's `workflows` map (which is what the app worker dispatches through), the
 * host's mirrored registry in `provision/resolveEmailConfig.ts` (which derives the deployed Workflow
 * names), and the host's dispatch route, which validates an incoming loopback payload against the
 * declaring spec's own schema before it starts anything (pithy-sh/pithy#410).
 *
 * That last one is why the mirror could no longer carry `z.unknown()`. A params schema that accepts
 * everything turns a malformed dispatch into a durable instance that fails somewhere inside its first
 * step, which is exactly the class of failure the request contract exists to name at the door.
 */

/** The batch of queued rows one send Workflow instance is responsible for. */
export const EmailSendParams = z
  .object({
    jobIds: z
      .array(z.string().min(1).describe("A queued `pithy_email_jobs` row id."))
      .min(1)
      .describe("The batch of queued job ids this instance sends — one durable step each."),
  })
  .describe("Parameters for one durable send batch.");
export type EmailSendParams = z.infer<typeof EmailSendParams>;

/** The scheduler's parameters: none. It finds its own work. */
export const EmailScheduleParams = z
  .object({})
  .describe("The scheduler takes no parameters — it finds its own due jobs.");
export type EmailScheduleParams = z.infer<typeof EmailScheduleParams>;
