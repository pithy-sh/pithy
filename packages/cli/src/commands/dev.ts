import { defineCommand } from "citty";
import { startDev } from "../dev/orchestrator";
import { formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy dev` — run every autostart worker locally under one supervisor.
 *
 * Discovers the workers from `apps/`, resolves each one's pinned port from `.dev.config.json` (verifying it
 * is free, never drifting), spawns them as process groups, tees their labeled output to the terminal and
 * `logs/dev.log`, and prints one ready banner. Ctrl-C (SIGINT) or SIGTERM tears the whole session down; any
 * worker exiting brings the rest down with it. The real work lives in `startDev`; this stays thin.
 */
export default defineCommand({
  meta: { name: "dev", description: "Run every worker locally under one supervisor." },
  args: {
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const handle = await startDev({ projectDir, json: args.json });

      if (args.json) {
        const workers = Object.fromEntries(handle.workers.map((w) => [w.name, { port: w.port, origin: w.origin }]));
        process.stdout.write(`${formatJsonLine({ command: "dev", workers })}\n`);
      }

      process.once("SIGINT", () => void handle.shutdown("interrupted"));
      process.once("SIGTERM", () => void handle.shutdown("terminated"));

      await handle.closed;
      process.exit(0);
    }),
});
