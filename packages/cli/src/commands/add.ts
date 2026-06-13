import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { addCapability } from "../capabilities/add";
import { availableManifests, loadManifest } from "../capabilities/manifests";
import { formatDone, formatJsonLine, formatList, withErrorReporting } from "../terminal/output";

/** `pithy add --list`: the available capabilities, or the Phase 0 "none yet" note. */
function listCapabilities(json: boolean): void {
  const manifests = availableManifests();
  if (json) {
    const capabilities = manifests.map((m) => ({ name: m.name, package: m.package, whenToEnable: m.whenToEnable }));
    process.stdout.write(`${formatJsonLine({ command: "add", capabilities })}\n`);
    return;
  }
  if (manifests.length === 0) {
    process.stdout.write("No capabilities yet. They land in Phase 1.\n");
    return;
  }
  const rows = manifests.map((m) => ({ name: m.name, description: m.whenToEnable ?? "" }));
  process.stdout.write(`${formatList(rows)}\n`);
}

export default defineCommand({
  meta: { name: "add", description: "Add a capability" },
  args: {
    // Optional so `pithy add --list` runs without a capability.
    capability: { type: "positional", required: false, description: "Capability name, e.g. auth" },
    list: { type: "boolean", default: false, description: "List the capabilities you can add" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      if (args.list) {
        listCapabilities(args.json);
        return;
      }
      if (!args.capability) {
        throw new ValidationError({
          message: "Name a capability to add.",
          action: "Run pithy add --list to see what's available.",
        });
      }
      const manifest = await loadManifest(args.capability);
      await addCapability({ projectDir: process.cwd(), manifest });
      const line = args.json
        ? formatJsonLine({ command: "add", capability: manifest.name, package: manifest.package })
        : formatDone();
      process.stdout.write(`${line}\n`);
    }),
});
