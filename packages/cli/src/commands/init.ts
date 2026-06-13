import { basename, resolve } from "node:path";
import { defineCommand } from "citty";
import { ensureEmptyTarget, scaffoldProject } from "../project/scaffold";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * Resolve the app name. Prompts when a human is attached and no `--name` was
 * given; otherwise takes the fallback. `prompted` tells the caller whether a
 * clack prompt rendered, so `Done.` can be set off from its gutter (CLI.md §2.7).
 */
async function resolveAppName(fallback: string, json: boolean): Promise<{ appName: string; prompted: boolean }> {
  if (json || !process.stdin.isTTY || !process.stdout.isTTY) return { appName: fallback, prompted: false };
  const { isCancel, text } = await import("@clack/prompts");
  const answer = await text({ message: "Project name:", defaultValue: fallback, placeholder: fallback });
  if (isCancel(answer)) {
    process.stderr.write("Cancelled.\n");
    process.exit(1);
  }
  return { appName: answer, prompted: true };
}

export default defineCommand({
  meta: { name: "init", description: "Scaffold a new project" },
  args: {
    name: { type: "string", description: "Application name. Defaults to the directory name." },
    dir: { type: "string", default: ".", description: "Target directory. Created if missing; must be empty." },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const targetDir = resolve(process.cwd(), args.dir);
      // Gate on the target before prompting — a doomed run fails fast, not after
      // the user answers (scaffoldProject re-checks, so the guard still holds).
      await ensureEmptyTarget(targetDir);
      const resolved = args.name
        ? { appName: args.name, prompted: false }
        : await resolveAppName(basename(targetDir), args.json);
      const { appName, prompted } = resolved;
      await scaffoldProject({ targetDir, appName });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ command: "init", targetDir, appName })}\n`);
        return;
      }
      // Set Done. off from the prompt's gutter; a flagged run has nothing above it.
      process.stdout.write(`${prompted ? "\n" : ""}${formatDone()}\n`);
    }),
});
