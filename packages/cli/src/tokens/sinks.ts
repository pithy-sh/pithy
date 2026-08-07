// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { CloudflareNotConfiguredError } from "@pithy-sh/cloudflare/src/client/errors";
import type { TokenStore } from "@pithy-sh/cloudflare/src/tokens/profiles";
import { upsertDevVars } from "../project/devVars";

/** Where a minted token landed — the store and a human location string. Never carries the value. */
export interface SinkTarget {
  sink: TokenStore;
  /** A human location for output: a filename, "CF Secrets Store", or the ephemeral note. No secret value. */
  location: string;
}

/**
 * What a sink write needs: the project dir + env to target, the two names a value can be stored under,
 * and a Secrets Store writer.
 *
 * The two names are deliberately separate. They were one string, and that string was doing two jobs
 * with opposite requirements: a **variable key** in a file this checkout owns, and an **entry name** in
 * one flat namespace shared by every project in the Cloudflare account. Only the second needs a project
 * scope — and scoping the first would rename `CF_TOKEN_CI_SYSTEM` and break every pipeline reading it.
 */
export interface SinkContext {
  projectDir: string;
  env: string;
  /**
   * The `.dev.vars` variable key — a local environment-variable name, never project-scoped. This is
   * what CI reads, so it stays exactly as the profile declares it.
   */
  secretName: string;
  /**
   * The CF Secrets Store entry name — project-scoped (`tokenStoreEntryName`). The store is one flat
   * account-wide namespace, so this name is the only partition between two projects' entries: an
   * unscoped one would silently overwrite another project's live credential.
   */
  storeEntryName: string;
  /** Writes a value to the CF Secrets Store; required for the `secrets-store` sink. */
  putSecret?: (name: string, value: string) => Promise<void>;
}

/** The `.dev.vars` file for an environment: `.dev.vars` for dev, `.dev.vars.<env>` otherwise (CLAUDE.md §dev vars). */
export function devVarsFileName(env: string): string {
  return env === "dev" ? ".dev.vars" : `.dev.vars.${env}`;
}

/**
 * Write a minted token value to its store and report where it landed — never the value. `ephemeral`
 * persists nothing (the caller uses the value in-process); `dev-vars` upserts the token's **variable
 * key** in the env's git-ignored `.dev.vars` file, readable by a later CLI run; `secrets-store` writes
 * it to the CF Secrets Store under the project-scoped **entry name**, for a Worker to read via its binding.
 *
 * The `dev-vars` write goes through `upsertDevVars`, which is the *only* thing that should be writing one
 * of these files. This had its own copy of the upsert, and the copy did not carry the `0600` the shared
 * one applies when it has to create the file — so minting a token for an environment that had no
 * `.dev.vars.<env>` yet left a live production Cloudflare credential at the umask default, `0664`.
 */
export async function writeTokenToSink(store: TokenStore, value: string, context: SinkContext): Promise<SinkTarget> {
  switch (store) {
    case "ephemeral":
      return { sink: store, location: "(ephemeral — not written)" };
    case "dev-vars": {
      const name = devVarsFileName(context.env);
      await upsertDevVars(join(context.projectDir, name), { [context.secretName]: value });
      return { sink: store, location: name };
    }
    case "secrets-store": {
      if (!context.putSecret) {
        throw new CloudflareNotConfiguredError({
          message: "No CF Secrets Store is configured for the secrets-store store.",
          action: "Set SECRETS_STORE_ID in .dev.vars, or mint with --store dev-vars.",
        });
      }
      await context.putSecret(context.storeEntryName, value);
      return { sink: store, location: "CF Secrets Store" };
    }
  }
}
