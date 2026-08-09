// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCommand } from "citty";
import { projectCloudflareAccount } from "../project/config";
import { buildEnvInventory, type EnvInventory, type EnvResource } from "../project/envInventory";
import { formatJsonLine, withErrorReporting } from "../terminal/output";
import { dim, link, supportsHyperlinks } from "../terminal/style";

/**
 * `pithy env [name] [--worker <name>] [--json]` — a read-only inventory of every environment every
 * Worker declares in its own `wrangler.jsonc`: its bindings, resolved ids, provisioned state, base
 * URL, and Cloudflare dashboard links. It writes nothing, switches nothing, and always exits 0 —
 * provisioning health and non-zero exits belong to `pithy doctor`. A resource id renders as a
 * clickable OSC-8 hyperlink to its dashboard page in a terminal, falling back to a printed URL when
 * hyperlinks are off (piped output / NO_COLOR); `--json` always carries the full `dashboardUrl` per
 * resource. The positional `name` narrows to one environment across every Worker; `--worker` narrows
 * to one Worker.
 */

/** A short parenthetical label for a resource kind. */
const KIND_LABEL: Record<EnvResource["kind"], string> = {
  d1: "d1",
  kv: "kv",
  r2: "r2",
  durable_object: "do",
};

/**
 * Render an id-carrying value: dim "not provisioned" when it does not exist, a clickable link when
 * hyperlinks render and a dashboard URL exists, the plain id + printed URL as the fallback, or the
 * bare id when there is no URL (no account id, or an unlinkable kind).
 */
function renderValue(id: string | null, provisioned: boolean, url: string | null): string {
  if (!provisioned) return dim("not provisioned");
  const text = id ?? "";
  if (!url) return text;
  if (supportsHyperlinks()) return link(url, text);
  return `${text}  ${dim(url)}`;
}

/**
 * Render the full human-readable inventory as a single string, optionally filtered to one environment.
 * Workers are the outer grouping — each Worker's name, then its environments indented beneath, then
 * each environment's bindings. A Worker with no matching environment is reported as such, not omitted.
 */
export function renderEnvInventory(inventory: EnvInventory, filter?: string): string {
  const lines: string[] = [];
  if (!inventory.accountId) lines.push(dim("No CLOUDFLARE_ACCOUNT_ID. Dashboard links omitted."));

  for (const worker of inventory.workers) {
    lines.push(`${worker.worker}  ${dim(worker.dir)}`);

    const environments = filter
      ? worker.environments.filter((environment) => environment.name === filter)
      : worker.environments;
    if (environments.length === 0) {
      lines.push(`  ${dim(`No environment named ${filter}.`)}`);
      continue;
    }

    for (const environment of environments) {
      lines.push(`  ${environment.name}  ${dim(environment.baseUrl ?? "no url")}`);
      if (environment.scriptName) {
        lines.push(`    worker  ${renderValue(environment.scriptName, true, environment.workerDashboardUrl)}`);
      }
      for (const resource of environment.resources) {
        lines.push(
          `    ${resource.binding} (${KIND_LABEL[resource.kind]})  ${renderValue(resource.id, resource.provisioned, resource.dashboardUrl)}`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export default defineCommand({
  meta: {
    name: "env",
    description: "Inventory every worker's environments: bindings, ids, provisioned state, dashboard links",
  },
  args: {
    name: { type: "positional", required: false, description: "Show only this environment (e.g. staging)" },
    worker: { type: "string", description: "Show only this worker (default: every worker under apps/)" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      // The account first, from the project's own config: the inventory *prints* an account id and
      // builds every dashboard link out of it, so resolving one this project did not claim labels its
      // bindings with another company's account and links there (#206).
      const inventory = await buildEnvInventory({
        projectDir,
        account: await projectCloudflareAccount(projectDir),
        ...(args.worker ? { worker: args.worker } : {}),
      });
      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "env", ...inventory })}\n`);
        return;
      }
      process.stdout.write(renderEnvInventory(inventory, args.name));
    }),
});
