import { defineCommand } from "citty";
import { allCapabilities, loadProject } from "../project/config";
import { seedProject } from "../seed/run";
import { PRODUCTION_CONFIRM_PHRASE } from "../seed/safety";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/** One line per set: what it wrote, per backend (docs/CLI.md §3). Empty backends are omitted. */
function describeSet(set: {
  name: string;
  d1: { rows: number }[];
  kv: { entries: number }[];
  r2: unknown[];
  media: unknown[];
}): string {
  const rows = set.d1.reduce((sum, entry) => sum + entry.rows, 0);
  const entries = set.kv.reduce((sum, entry) => sum + entry.entries, 0);
  const parts: string[] = [];
  if (rows > 0) parts.push(`${rows} row${rows === 1 ? "" : "s"}`);
  if (entries > 0) parts.push(`${entries} entr${entries === 1 ? "y" : "ies"}`);
  if (set.r2.length > 0) parts.push(`${set.r2.length} object${set.r2.length === 1 ? "" : "s"}`);
  if (set.media.length > 0) parts.push(`${set.media.length} asset${set.media.length === 1 ? "" : "s"}`);
  return `${set.name}: ${parts.length > 0 ? parts.join(", ") : "nothing to seed"}.`;
}

/** The interactive production-confirm prompt: an `@clack/prompts` text field asking for the exact phrase. */
function productionPrompt(): () => Promise<string> {
  return async () => {
    const { isCancel, text } = await import("@clack/prompts");
    const answer = await text({
      message: `This writes to production. Type "${PRODUCTION_CONFIRM_PHRASE}" to confirm:`,
    });
    return isCancel(answer) ? "" : answer;
  };
}

export default defineCommand({
  meta: { name: "seed", description: "Seed an environment from your Zod-typed fixtures" },
  args: {
    env: { type: "string", default: "dev", description: "Target environment" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
    "dry-run": { type: "boolean", default: false, description: "Print the write plan; change nothing" },
    yes: { type: "boolean", default: false, description: "Confirm a non-dev environment" },
    "confirm-production": {
      type: "string",
      description: `Unlock production non-interactively: "${PRODUCTION_CONFIRM_PHRASE}"`,
    },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const config = await loadProject(projectDir);
      const dryRun = args["dry-run"];
      const interactive = !args.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

      const report = await seedProject({
        capabilities: allCapabilities(config),
        projectDir,
        env: args.env,
        includeExamples: config.seed?.includeExamples ?? false,
        dryRun,
        yes: args.yes,
        json: args.json,
        confirmProduction: args["confirm-production"],
        productionEnvironments: config.seed?.productionEnvironments,
        prompt: interactive ? productionPrompt() : undefined,
      });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ ...report })}\n`);
        return;
      }

      for (const key of report.skippedByEnv) {
        process.stdout.write(`Skipped ${key}: not allowed in ${args.env}.\n`);
      }
      if (report.sets.length === 0) {
        process.stdout.write(`Nothing to seed for ${args.env}.\n`);
      }
      for (const set of report.sets) {
        process.stdout.write(`${describeSet(set)}\n`);
      }
      if (dryRun) process.stdout.write("Dry run. Nothing written.\n");
      process.stdout.write(`${formatDone()}\n`);
    }),
});
