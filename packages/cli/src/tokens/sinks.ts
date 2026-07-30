// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudflareNotConfiguredError } from "@pithy-sh/cloudflare/src/client/errors";
import type { TokenStore } from "@pithy-sh/cloudflare/src/tokens/profiles";
import { writeFileAtomic } from "../project/atomic";

/** Where a minted token landed — the store and a human location string. Never carries the value. */
export interface SinkTarget {
  sink: TokenStore;
  /** A human location for output: a filename, "CF Secrets Store", or the ephemeral note. No secret value. */
  location: string;
}

/** What a sink write needs: the project + env to target, the secret name (the key), and a Secrets Store writer. */
export interface SinkContext {
  projectDir: string;
  env: string;
  /** The secret name the value is stored under — the `.dev.vars` key or the CF Secrets Store entry name. */
  secretName: string;
  /** Writes a value to the CF Secrets Store; required for the `secrets-store` sink. */
  putSecret?: (name: string, value: string) => Promise<void>;
}

/** The `.dev.vars` file for an environment: `.dev.vars` for dev, `.dev.vars.<env>` otherwise (CLAUDE.md §dev vars). */
export function devVarsFileName(env: string): string {
  return env === "dev" ? ".dev.vars" : `.dev.vars.${env}`;
}

/** Upsert one `KEY=value` line in a `.dev.vars` file, preserving every other line; create the file if absent. */
async function upsertDevVar(file: string, key: string, value: string): Promise<void> {
  let lines: string[] = [];
  try {
    lines = (await readFile(file, "utf8")).split("\n");
  } catch {
    // No file yet — start empty.
  }
  const entry = `${key}=${value}`;
  const index = lines.findIndex((line) => line.trimStart().startsWith(`${key}=`));
  if (index >= 0) {
    lines[index] = entry;
  } else {
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(entry);
  }
  await writeFileAtomic(file, `${lines.join("\n")}\n`);
}

/**
 * Write a minted token value to its store and report where it landed — never the value. `ephemeral`
 * persists nothing (the caller uses the value in-process); `dev-vars` upserts the token's secret name
 * in the env's git-ignored `.dev.vars` file, readable by a later CLI run; `secrets-store` writes it to
 * the CF Secrets Store under the same name, for a Worker to read via its binding.
 */
export async function writeTokenToSink(store: TokenStore, value: string, context: SinkContext): Promise<SinkTarget> {
  switch (store) {
    case "ephemeral":
      return { sink: store, location: "(ephemeral — not written)" };
    case "dev-vars": {
      const name = devVarsFileName(context.env);
      await upsertDevVar(join(context.projectDir, name), context.secretName, value);
      return { sink: store, location: name };
    }
    case "secrets-store": {
      if (!context.putSecret) {
        throw new CloudflareNotConfiguredError({
          message: "No CF Secrets Store is configured for the secrets-store store.",
          action: "Set SECRETS_STORE_ID in .dev.vars, or mint with --store dev-vars.",
        });
      }
      await context.putSecret(context.secretName, value);
      return { sink: store, location: "CF Secrets Store" };
    }
  }
}
