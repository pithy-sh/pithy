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
 * What an unprovisioned binding reads as in a **deployed** environment: an action item, and the reason
 * `pithy env` is read before and after provisioning.
 */
const NOT_PROVISIONED = "not provisioned";

/**
 * What an unprovisioned binding reads as in a **local** environment: a statement, not an action item.
 *
 * **A check that cannot fail meaningfully for an environment should not be run against it.** There is
 * no remote `dash-dev-db` and there is not supposed to be one — Miniflare serves D1 from the binding
 * declaration, with state under `.wrangler/state/v3/d1`, and `pithy dev` works precisely because no
 * Cloudflare resource is involved. Reporting three such bindings as deficiencies taught an operator to
 * skim past red in the one command they read against production (#320).
 *
 * Deliberately not the same string as the deployed one. Sharing it is what made the real action item
 * weaker.
 */
const LOCAL = "local";

/**
 * The half `local` does not cover, said once per stanza rather than once per binding.
 *
 * **The top-level stanza is the local environment and the stanza a bare `pithy deploy` ships.** `wrangler
 * deploy` with no `--env` takes it to Cloudflare, and it is the one deploy path with no
 * `assertEnvironmentProvisioned` in front of it — every `--env` deploy is refused before a binding with
 * no id reaches wrangler (#240), and this one is not. So `local` is a true statement about Miniflare and
 * an incomplete one about the file: an operator reading `pithy env` before a deploy read it as *nothing
 * to provision here* (#320 gave the word, this gives back what it took).
 *
 * A property of the stanza, so it is printed under the stanza, and only where it is a fact — a local
 * environment whose bindings all carry ids has nothing ungated about it, and a deployed one already says
 * `not provisioned`, which is the action item. A line under every environment would be the wallpaper the
 * word was introduced to remove.
 */
const UNGATED = "Miniflare needs no id. A bare pithy deploy ships this stanza, and nothing gates it on one.";

/**
 * Render an id-carrying value: the resource's state when it has no id, a clickable link when
 * hyperlinks render and a dashboard URL exists, the plain id + printed URL as the fallback, or the
 * bare id when there is no URL (no account id, or an unlinkable kind).
 *
 * `local` is the environment's own answer, carried on the report rather than guessed from its name — a
 * local environment that *does* name a real id still shows it, because pointing dev at a remote
 * database is a thing an adopter may do and the id is the true and useful thing to print.
 */
function renderValue(id: string | null, provisioned: boolean, url: string | null, local: boolean): string {
  if (!provisioned) return dim(local ? LOCAL : NOT_PROVISIONED);
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
  return renderLines(inventory, filter).join("\n").concat("\n");
}

/** The rendered lines, before they are joined — the seam a gate reads so it can assert per line. */
export function renderLines(inventory: EnvInventory, filter?: string): string[] {
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
        lines.push(
          `    worker  ${renderValue(environment.scriptName, true, environment.workerDashboardUrl, environment.local)}`,
        );
      }
      for (const resource of environment.resources) {
        lines.push(
          `    ${resource.binding} (${KIND_LABEL[resource.kind]})  ${renderValue(resource.id, resource.provisioned, resource.dashboardUrl, environment.local)}`,
        );
      }
      if (environment.local && environment.resources.some((resource) => !resource.provisioned)) {
        lines.push(`    ${dim(UNGATED)}`);
      }
    }
  }
  return lines;
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
