// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { parse } from "comment-json";
import { kitSource } from "../project/kitSource";
import { KIT_ROOT } from "./kitRoot";

/**
 * A Workflows client double holding the named Workflows (#789). A delete removes one and answers whether it was
 * there, as `CloudflareWorkflowsClient.deleteWorkflow` does. `held` is what is left, for a test to read.
 */
export function workflowsHolding(present: readonly string[] = []): {
  workflows: Pick<CloudflareWorkflowsClient, "deleteWorkflow">;
  held: Set<string>;
} {
  const held = new Set(present);
  return { workflows: { deleteWorkflow: async (name) => held.delete(name) }, held };
}

/**
 * **Every Workflow a host's committed `wrangler.jsonc` declares, as one environment deploys it (#789).** Read from
 * the file itself rather than from any namer, so a Workflow added to the template and to nothing else is still
 * counted — which is what makes a teardown test that seeds these fail when its deprovision misses one. A template
 * name is `pithy-<capability>-<job>`; the deployed name is `<project>-<env>-<capability>-<job>`.
 */
export async function declaredWorkflowNames(worker: string, project: string, env: string): Promise<string[]> {
  const dir = dirname(kitSource(KIT_ROOT, worker));
  const template = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as WorkflowHostTemplate;
  return (template.workflows ?? []).map((workflow) => `${project}-${env}-${workflow.name.replace(/^pithy-/, "")}`);
}
