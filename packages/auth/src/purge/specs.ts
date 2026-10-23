// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { workflowKey } from "@pithy-sh/core/src/workflow/naming";
import type { WorkflowRegistry, WorkflowSpecMap } from "@pithy-sh/core/src/workflow/spec";
import { z } from "zod";

/** This capability's name, and the first segment of its workflow dispatch keys. */
export const AUTH_CAPABILITY = "auth";

/** The binding the purge of one account is started on. */
export const AUTH_PURGE_BINDING = "AUTH_PURGE";

/** The binding the daily pass that starts every due purge runs on. */
export const AUTH_PURGE_DUE_BINDING = "AUTH_PURGE_DUE";

/** The dispatch key of the purge of one account. */
export const AUTH_PURGE_KEY = workflowKey(AUTH_CAPABILITY, "purge");

/** One account's purge: which, and whether its last mail is sent. */
export const AuthPurgeParams = z
  .object({
    userId: z.string().min(1).max(255).describe("The account to erase, as `pithy_auth_users.id` stores it."),
    notify: z
      .boolean()
      .optional()
      .describe(
        "Whether the deletion-complete mail is sent. Absent is true; the config can still turn it off. A hard deletion with `notify: false` passes false.",
      ),
  })
  .describe("One account's purge. It erases nothing unless the account is deleted and its window has closed.");
export type AuthPurgeParams = z.infer<typeof AuthPurgeParams>;

/**
 * The daily pass's parameters. Every field optional, because a cron passes none — `createEntrypoint` starts a
 * scheduled job with `{}`.
 */
export const AuthPurgeDueParams = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("How many due accounts to start a purge for in this pass, oldest first. Defaults to 500."),
  })
  .describe("One pass that starts a purge for every account past its window. A cron passes no field.");
export type AuthPurgeDueParams = z.infer<typeof AuthPurgeDueParams>;

/**
 * The two durable jobs auth owns (#622) — **both hosted by the adopter's own Worker**, the one that composes
 * auth, never a prebuilt host.
 *
 * **Why not a host.** A purge runs every composed capability's contribution, the adopter's own `app` among
 * them, and those exist only in the Worker whose `pithy.config.ts` composed them. A prebuilt host composes
 * nothing. So each class is five lines in the adopter's entry, calling `runAuthPurge` and `runAuthPurgeDue` in
 * `./workflow.ts`, exactly as `@pithy-sh/payments`' usage pass is: Cloudflare resolves a `class_name` in the
 * script that binds it, and the body finds the composition the way a Workflow that sends mail finds email.
 * No `className` here, deliberately: the class is the adopter's, and so is its `workflows` entry. The docs
 * give both (`docs/account-lifecycle.md`).
 *
 * **`purge-due` is daily at 02:00 UTC**, ahead of storage's and the secrets rotation at 03:00, payments' 04:00
 * and testers' 05:00. Daily because the window is counted in days: an hourly pass would start the same purge
 * twenty-four times and erase nothing sooner. Both stay dispatchable on demand — a hard deletion starts
 * `purge` directly.
 *
 * `optional: true` for both, so a Worker composing auth still boots before the adopter has bound them. A
 * deletion then reports its purge as `pending`, and nothing is erased until they are.
 */
export const authWorkflows = {
  purge: {
    binding: AUTH_PURGE_BINDING,
    params: AuthPurgeParams,
    optional: true,
  },
  "purge-due": {
    binding: AUTH_PURGE_DUE_BINDING,
    params: AuthPurgeDueParams,
    schedule: "0 2 * * *",
    optional: true,
  },
} as const satisfies WorkflowSpecMap;

/**
 * The jobs as a dispatch registry, keyed `auth/<job>`, built here for the reason testers builds its own: the key
 * format is core's either way. The daily pass starts each purge on the binding directly, not through this, because
 * it names the instance (`./start.ts`) and dispatch does not.
 */
export const authWorkflowRegistry: WorkflowRegistry = Object.fromEntries(
  Object.entries(authWorkflows).map(([job, spec]) => {
    const key = workflowKey(AUTH_CAPABILITY, job);
    return [key, { key, capability: AUTH_CAPABILITY, job, spec }];
  }),
);
