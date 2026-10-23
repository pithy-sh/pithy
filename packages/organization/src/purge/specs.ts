// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { workflowKey } from "@pithy-sh/core/src/workflow/naming";
import type { WorkflowRegistry, WorkflowSpecMap } from "@pithy-sh/core/src/workflow/spec";
import { z } from "zod";

/** This capability's name, and the first segment of its workflow dispatch keys. */
export const ORGANIZATION_CAPABILITY = "organization";

/** The binding the purge of one organization is started on. */
export const ORGANIZATION_PURGE_BINDING = "ORGANIZATION_PURGE";

/** The binding the daily pass that starts every due organization purge runs on. */
export const ORGANIZATION_PURGE_DUE_BINDING = "ORGANIZATION_PURGE_DUE";

/** The dispatch key of the purge of one organization. */
export const ORGANIZATION_PURGE_KEY = workflowKey(ORGANIZATION_CAPABILITY, "purge");

/** One organization's purge: which. */
export const OrganizationPurgeParams = z
  .object({
    organizationId: z.uuid().describe("The organization to erase, as `pithy_organization_organizations.id` stores it."),
  })
  .describe(
    "One organization's purge. It erases nothing unless the organization is deleted and its window has closed.",
  );
export type OrganizationPurgeParams = z.infer<typeof OrganizationPurgeParams>;

/** The daily pass's parameters. Every field optional, because a cron passes none. */
export const OrganizationPurgeDueParams = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("How many due organizations to start a purge for in this pass, oldest first. Defaults to 500."),
  })
  .describe("One pass that starts a purge for every organization past its window. A cron passes no field.");
export type OrganizationPurgeDueParams = z.infer<typeof OrganizationPurgeDueParams>;

/**
 * The two durable jobs this capability owns (#623) — **both hosted by the adopter's own Worker**, the one that
 * composes it, for the reason `@pithy-sh/auth`'s purge is: a purge runs every composed capability's contribution
 * for the organization, the adopter's own `app` among them, and those exist only in the Worker that composed them.
 * So each class is five lines in the adopter's entry, calling `runOrganizationPurge` and
 * `runOrganizationPurgeDue` in `./workflow.ts`. No `className` here: the class is the adopter's.
 *
 * **`purge-due` shares auth's 02:00 UTC trigger**, so a Worker composing both spends one cron on the two passes
 * rather than two. The window is counted in days, so a daily pass erases nothing later than an hourly one would.
 *
 * `optional: true` for both, so a Worker composing this still boots before the adopter has bound them. A
 * deletion then reports its purge as `pending`, and nothing is erased until they are.
 */
export const organizationWorkflows = {
  purge: {
    binding: ORGANIZATION_PURGE_BINDING,
    params: OrganizationPurgeParams,
    optional: true,
  },
  "purge-due": {
    binding: ORGANIZATION_PURGE_DUE_BINDING,
    params: OrganizationPurgeDueParams,
    schedule: "0 2 * * *",
    optional: true,
  },
} as const satisfies WorkflowSpecMap;

/** The jobs as a dispatch registry, keyed `organization/<job>`. */
export const organizationWorkflowRegistry: WorkflowRegistry = Object.fromEntries(
  Object.entries(organizationWorkflows).map(([job, spec]) => {
    const key = workflowKey(ORGANIZATION_CAPABILITY, job);
    return [key, { key, capability: ORGANIZATION_CAPABILITY, job, spec }];
  }),
);
