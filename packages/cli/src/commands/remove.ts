import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { defaultRemoveSteps, removeCapability } from "../capabilities/remove";
import { allCapabilities, loadProject } from "../project/config";
import { formatDone, withErrorReporting } from "../terminal/output";

/**
 * `remove` is the deliberate exception to the agent-drivable / `--json` convention: it is destructive,
 * so it is human-only. `--json` fast-fails here — before anything is read or changed.
 */
export function rejectJson(json: boolean): void {
  if (json) {
    throw new ValidationError({
      message: "pithy remove is a manual command. --json is not supported.",
      action: "Run pithy remove <capability> at a terminal.",
    });
  }
}

/**
 * The `--drop` confirmation for an environment. `dev` asks a light yes/no; any non-dev env demands the
 * exact typed phrase `drop <cap> from <env>` (the Cloudflare-dashboard delete pattern) — a mismatch or
 * a cancel returns false and aborts with zero changes. There is no bypass flag.
 */
export function dropConfirm(capability: string, env: string): () => Promise<boolean> {
  return async () => {
    const clack = await import("@clack/prompts");
    if (env === "dev") {
      const answer = await clack.confirm({ message: `Drop ${capability}'s tables from dev? This deletes data.` });
      return !clack.isCancel(answer) && answer === true;
    }
    const phrase = `drop ${capability} from ${env}`;
    const typed = await clack.text({ message: `This deletes ${env} data. Type "${phrase}" to confirm:` });
    return !clack.isCancel(typed) && typed === phrase;
  };
}

export default defineCommand({
  meta: { name: "remove", description: "Remove a capability — the manual, interactive inverse of add" },
  args: {
    capability: { type: "positional", required: true, description: "Capability name, e.g. auth" },
    drop: {
      type: "boolean",
      default: false,
      description: "Also roll back the capability's migrations (drops its tables)",
    },
    env: { type: "string", default: "dev", description: "With --drop, the environment whose tables to drop" },
    json: { type: "boolean", default: false, description: "Not supported — remove is manual-only" },
  },
  // Errors always render as terminal problem/action lines: `remove` has no machine-readable surface.
  run: ({ args }) =>
    withErrorReporting(false, async () => {
      rejectJson(args.json);

      const projectDir = process.cwd();
      const config = await loadProject(projectDir);
      const capabilities = allCapabilities(config);
      const env = args.env;

      const result = await removeCapability({
        projectDir,
        capability: args.capability,
        drop: args.drop ? { env, confirm: dropConfirm(args.capability, env) } : undefined,
        steps: defaultRemoveSteps(projectDir, async () => capabilities),
      });

      if (!result.present) {
        process.stdout.write(`${args.capability} is not present. Nothing to remove.\n`);
        return;
      }
      if (result.aborted) {
        process.stdout.write("Aborted. Nothing changed.\n");
        return;
      }

      process.stdout.write(`Removed ${args.capability}.\n`);
      if (result.dropped) {
        const total = result.dropped.reduce((sum, run) => sum + run.results.length, 0);
        process.stdout.write(`Dropped ${total} migration${total === 1 ? "" : "s"} from ${env}.\n`);
      }
      if (result.ejected) {
        process.stdout.write(`Deleted capabilities/${args.capability}/.\n`);
      } else if (result.packageManager) {
        process.stdout.write(`Uninstalled @pithy-sh/${args.capability}.\n`);
      }
      if (result.tablesRemain) {
        // The down code is gone now, so there's no post-removal pithy command to reverse them — name
        // the tables to drop by hand, and point at --drop for next time.
        process.stdout.write(
          `${args.capability}'s D1 tables were left in place — your data is safe, and a later pithy add ${args.capability} reuses them. To drop them, remove the pithy_${args.capability}_* tables by hand (pass --drop to reverse them during removal).\n`,
        );
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});
