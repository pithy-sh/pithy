import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { createRemoteCliAudit } from "../audit/cliAudit";
import type { ConfigValue } from "../capabilities/add";
import { buildCatalogListing } from "../capabilities/catalog";
import { type ConfigPrompt, coerceConfigValue, collectSetFlags, runAdd } from "../capabilities/flow";
import { availableManifests } from "../capabilities/manifests";
import type { DatabaseRun } from "../migrations/run";
import { allCapabilities, loadProject } from "../project/config";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";

/**
 * The audit emitter for `pithy add`. There is no environment concept here — a capability is wired into
 * dev config, not deployed — so `"dev"` is the fallback env the audit database resolves against. A
 * no-op when Cloudflare creds or the audit capability aren't there (which is always true the very
 * first time `pithy add audit` itself runs — nothing can audit-log its own installation).
 */
async function buildAudit(projectDir: string) {
  const vars = loadCloudflareEnv(projectDir);
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return async () => {};
  const capabilities = await loadProject(projectDir)
    .then(allCapabilities)
    .catch(() => []);
  return createRemoteCliAudit({
    projectDir,
    env: "dev",
    capabilities,
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

/** `pithy add --list`: the built-in catalog, with installed capabilities marked. */
async function listCapabilities(projectDir: string, json: boolean): Promise<void> {
  const installed = new Set((await availableManifests(projectDir)).map((manifest) => manifest.name));
  const listing = buildCatalogListing(installed);
  if (json) {
    process.stdout.write(`${formatJsonLine({ command: "add", capabilities: listing })}\n`);
    return;
  }
  const rows = listing.map((entry) => ({
    name: entry.name,
    description: entry.installed ? `${entry.whenToEnable} (installed)` : entry.whenToEnable,
  }));
  process.stdout.write(`${formatList(rows)}\n`);
}

/** One line per database migrated, brand-voiced (docs/CLI.md §3). */
function describeRun(run: DatabaseRun): string {
  return run.results.length === 0
    ? `${run.database}: nothing to apply.`
    : `${run.database}: ${run.results.length} applied.`;
}

/** Fill un-set options interactively — a human-attached run prompts from the manifest. */
const promptConfigValues: ConfigPrompt = async (manifest, provided) => {
  const { isCancel, text } = await import("@clack/prompts");
  const values: Record<string, ConfigValue> = { ...provided };
  for (const option of manifest.configOptions) {
    if (option.key in values) continue;
    const fallback = String(option.default);
    const answer = await text({
      message: `${option.key} — ${option.describe}`,
      defaultValue: fallback,
      placeholder: fallback,
    });
    if (isCancel(answer)) {
      process.stderr.write("Cancelled.\n");
      process.exit(1);
    }
    values[option.key] = coerceConfigValue(option, answer, manifest.name);
  }
  return values;
};

export default defineCommand({
  meta: { name: "add", description: "Add a capability" },
  args: {
    // Optional so `pithy add --list` runs without a capability.
    capability: { type: "positional", required: false, description: "Capability name, e.g. auth" },
    list: { type: "boolean", default: false, description: "List the capabilities you can add" },
    set: { type: "string", description: "Override a config option: --set key=value (repeatable)" },
    eject: {
      type: "boolean",
      default: false,
      description: "Copy the capability's source into your repo and own it (no upgrades)",
    },
    force: {
      type: "boolean",
      default: false,
      description: "With --eject, overwrite an existing local copy (discards edits)",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  // `ctx` over `{ args }`: repeated `--set` only survives in rawArgs (citty keeps
  // the last value of a repeated string flag), so collectSetFlags reads it there.
  run: ({ args, rawArgs }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      if (args.list) {
        await listCapabilities(projectDir, args.json);
        return;
      }
      if (!args.capability) {
        throw new ValidationError({
          message: "Name a capability to add.",
          action: "Run pithy add --list to see what's available.",
        });
      }

      const interactive = !args.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
      const result = await runAdd({
        projectDir,
        capability: args.capability,
        setFlags: collectSetFlags(rawArgs),
        prompt: interactive ? promptConfigValues : undefined,
        eject: args.eject,
        force: args.force,
        audit: await buildAudit(projectDir),
      });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "add", ...result })}\n`);
        return;
      }
      for (const run of result.databases) {
        process.stdout.write(`${describeRun(run)}\n`);
      }
      if (result.eject) {
        process.stdout.write(
          `Ejected ${result.capability} into ${result.eject.path}/. It's yours now — ${result.package} no longer upgrades it.\n`,
        );
        if (result.eject.promotedDependencies.length > 0) {
          process.stdout.write(
            `Promoted ${result.eject.promotedDependencies.length} dependencies. ${result.package} is safe to remove.\n`,
          );
        }
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});
