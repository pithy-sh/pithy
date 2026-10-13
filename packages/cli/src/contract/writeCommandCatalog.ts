// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Write `@pithy-sh/core/src/cli/commandCatalog.generated.ts` from the composed command tree, and the CLI's
 * `capabilities/kitAddFacts.generated.ts` from every kit manifest (#711): the two tables the builders of a
 * `pithy` command line read. The same shape as `writePayloadShapes.ts`, and under `src/` for the reason it gives:
 * building the catalog means composing the real tree. `commandCatalog.test.ts` and `kitAddFacts.test.ts` fail
 * while either file is stale, and this is what they ask you to run.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { KIT_ADD_FACTS_PATH, renderKitAddFacts } from "../capabilities/kitAddFacts";
import { main } from "../main";
import { readOptionalFile } from "../project/readOptionalFile";
import { COMMAND_CATALOG_PATH, commandCatalogOf, renderCommandCatalog } from "./commandCatalog";
import { describeCli } from "./describe";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * Every kit package's manifest. A package with none is not a capability; a manifest that will not read or parse
 * fails the run, because dropping it would write a table that says the kit has no such capability.
 */
async function kitManifests(): Promise<CapabilityManifest[]> {
  const packages = join(REPO_ROOT, "packages");
  const found: CapabilityManifest[] = [];
  for (const pkg of readdirSync(packages).sort()) {
    const text = await readOptionalFile(join(packages, pkg, "pithy.manifest.json"));
    if (text !== null) found.push(CapabilityManifest.parse(JSON.parse(text)));
  }
  return found;
}

const outputs: [string, string][] = [
  [COMMAND_CATALOG_PATH, renderCommandCatalog(commandCatalogOf(await describeCli(main)))],
  [KIT_ADD_FACTS_PATH, renderKitAddFacts(await kitManifests())],
];
for (const [relative, expected] of outputs) {
  const path = join(REPO_ROOT, relative);
  if ((await readOptionalFile(path)) === expected) {
    process.stdout.write(`${relative} is current.\n`);
  } else {
    writeFileSync(path, expected);
    process.stdout.write(`Wrote ${relative}.\n`);
  }
}
