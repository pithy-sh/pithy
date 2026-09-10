// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { undeclaredLineFields } from "@pithy-sh/secrets/src/cli/promptPlan";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { isTestFile, sourceFiles } from "./sourceFiles";

/**
 * **Every string leaf of every `json` secret says whether it fits on a line, and no capability may skip
 * saying.**
 *
 * `pithy secrets create` asks a `json` secret one field at a time, and a masked prompt reads **one
 * line**. What it does with a paste that is longer than that was measured against the real
 * `@clack/prompts` `password()` under a real pty (`capabilities/secretPrompt.pty.test.ts`): a
 * CR-delimited paste returns its first line and drops the rest, an LF-delimited one returns its last.
 * One fragment is written, `z.string().min(1)` accepts it, and the value surfaces as a signature that
 * never verifies — months later, in production, in somebody else's console.
 *
 * So a leaf is asked for only once its author has said it fits: `.meta({ multiline: false })`, or
 * `.meta({ multiline: true })` for a `.p8`, a PEM, a service-account key, which is asked for as one JSON
 * document instead. **This is the gate that makes "or" true of the whole repository.** Without it the
 * marker is opt-out, an unmarked PEM is asked for and truncated, and nothing says so — which is exactly
 * the state two rounds of review left, because the prompt-side backstop it was justified by ("refuse an
 * answer that arrived with a newline in it") cannot fire: an answer never arrives with one.
 *
 * The shape is CLAUDE.md's, three times over — every field carries a `.describe()`, every capability
 * declares a `migrationOrder`, every capability stamps a version — and for the same reason each of those
 * is a repo-wide sweep rather than a habit: **the property is only true as a set.** A capability landing
 * tomorrow with an unmarked credential field fails here, named, at authoring time.
 *
 * Repo-wide and unconditional. `--affected` is not consulted, because a schema in `@pithy-sh/auth` is
 * what this is about and the CLI is not its dependent (`ci/crossPackageReads.test.ts` plans the suite off
 * the `packages` read below).
 */

/** `packages/cli/src/ci` → the repository's packages, spelled as `project/capabilityVersions.test.ts` spells it. */
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "../../../../packages");

/** One `json` secret found in the tree: where it was declared, what it is called, and its schema. */
interface JsonSecret {
  /** The module that declares it, repo-relative — where the fix goes. */
  module: string;
  /** The registry key, which is also the name `pithy secrets create` is given. */
  name: string;
  /** The Zod object its value is validated against. */
  schema: z.ZodType;
}

/** Whether a value has the four axes every registry entry declares. Narrow enough that a config object is not one. */
function isEntry(value: unknown): value is SecretRegistryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<SecretRegistryEntry>;
  return (
    typeof entry.backend === "string" &&
    typeof entry.scope === "string" &&
    typeof entry.valueType === "string" &&
    typeof entry.rotatable === "boolean"
  );
}

/**
 * Every `json` secret this repository declares.
 *
 * Found by **importing** the modules that call `defineSecretRegistry`, never by reading their text: the
 * question is what a schema *is*, and a `.meta({})` two wrappers up or inherited from a shared schema in
 * another package is invisible to a grep. Both an exported registry and an exported bare entry count —
 * `masterKeyRegistryEntry` is the second shape, and it is the one secret every other secret is read
 * through.
 */
async function jsonSecrets(): Promise<JsonSecret[]> {
  const declaring = sourceFiles(PACKAGES).filter(
    (file) => !isTestFile(basename(file.path)) && file.text.includes("defineSecretRegistry("),
  );
  // Keyed, because one entry is reachable through more than one export: `media-r2-credentials` is both
  // its own registry slice and a member of media's. One secret, one report.
  const found = new Map<string, JsonSecret>();
  for (const file of declaring) {
    const module = file.path.slice(PACKAGES.length + 1);
    const exported = (await import(pathToFileURL(file.path).href)) as Record<string, unknown>;
    const take = (name: string, entry: SecretRegistryEntry): void => {
      if (entry.valueType === "json") found.set(`${module}:${name}`, { module, name, schema: entry.schema });
    };
    for (const [exportName, value] of Object.entries(exported)) {
      if (isEntry(value)) {
        take(exportName, value);
        continue;
      }
      if (typeof value !== "object" || value === null) continue;
      for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
        if (isEntry(entry)) take(name, entry);
      }
    }
  }
  return [...found.values()];
}

describe("every json secret's string leaves say whether they fit on a line", () => {
  it("finds the secrets at all, so this cannot pass vacuously", async () => {
    const secrets = await jsonSecrets();
    // The names are listed rather than counted: a sweep that silently stopped finding a package still
    // passes a count, and the two it would stop finding first are the two with a PEM among them.
    const names = new Set(secrets.map((secret) => secret.name));
    for (const name of [
      "payments-provider-credentials",
      "auth-google-credentials",
      "auth-apple-credentials",
      "turnstile-secret-keys",
      "storage-r2-credentials",
      "media-r2-credentials",
      "masterKeyRegistryEntry",
    ]) {
      expect(names, `${name} is no longer reached by the sweep`).toContain(name);
    }
  });

  it("holds every string leaf of every one of them to a declaration", async () => {
    const undeclared = (await jsonSecrets()).flatMap((secret) =>
      undeclaredLineFields(secret.schema, secret.name).map((field) => `${secret.module}: ${field}`),
    );
    expect(
      undeclared.sort(),
      "add .meta({ multiline: false }) beside the field's .describe(), or .meta({ multiline: true }) if its value can span lines",
    ).toEqual([]);
  });

  it("reports a leaf that says nothing, and is satisfied by either answer", async () => {
    // The gate's own behavior, against a schema shaped like the ones above. Without this, a walk that
    // quietly returned nothing would pass the sweep on every package at once.
    const { z } = await import("zod");
    const shape = (marked: z.ZodType) =>
      z
        .strictObject({
          apple: z.object({ keyId: marked.describe("The key id."), other: z.string().describe("Unmarked.") }),
        })
        .describe("A bundle.");
    expect(undeclaredLineFields(shape(z.string().meta({ multiline: false })), "value")).toEqual(["value.apple.other"]);
    expect(undeclaredLineFields(shape(z.string().meta({ multiline: true })), "value")).toEqual(["value.apple.other"]);
    expect(undeclaredLineFields(shape(z.string()), "value").sort()).toEqual(["value.apple.keyId", "value.apple.other"]);
  });
});
