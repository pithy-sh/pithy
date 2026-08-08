// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareNotConfiguredError } from "@pithy-sh/cloudflare/src/client/errors";
import type { TokenStore } from "@pithy-sh/cloudflare/src/tokens/profiles";
import type { StatePathOptions } from "../notifier/state";
import { writeMintedToken } from "./mintedTokens";

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
  /**
   * The project's name, from the root `pithy.config.ts` via `requireProjectName` — never a directory.
   * It keys `<config>/<project>/`, which is where a minted token goes now that nothing is written into
   * the checkout (#182).
   */
  project: string;
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
  /** Where the Pithy config directory is. Defaults to the real one; a seam so a test writes its own. */
  paths?: StatePathOptions;
}

/**
 * Write a minted token value to its store and report where it landed — never the value. `ephemeral`
 * persists nothing (the caller uses the value in-process); `dev-vars` records the token's **variable
 * key** under its environment in `<config>/<project>/tokens.json`, readable by a later CLI run;
 * `secrets-store` writes it to the CF Secrets Store under the project-scoped **entry name**, for a Worker
 * to read via its binding.
 *
 * **The `dev-vars` sink writes nothing inside the project directory, for any environment (#182).** It
 * used to write `.dev.vars` for dev and `.dev.vars.<env>` for everything else — so a production mint put
 * a live production Cloudflare token in the checkout, gitignored but reachable by `npm pack`, which does
 * not consult `.gitignore` when `files` is set (#145). The store name stays `dev-vars` because it is a
 * public flag value and renaming it would break every documented invocation; what changed is where it
 * puts the value. See {@link writeMintedToken}.
 */
export async function writeTokenToSink(store: TokenStore, value: string, context: SinkContext): Promise<SinkTarget> {
  switch (store) {
    case "ephemeral":
      return { sink: store, location: "(ephemeral — not written)" };
    case "dev-vars": {
      const path = await writeMintedToken(context.project, context.env, context.secretName, value, context.paths ?? {});
      return { sink: store, location: path };
    }
    case "secrets-store": {
      if (!context.putSecret) {
        throw new CloudflareNotConfiguredError({
          message: "No CF Secrets Store is configured for the secrets-store store.",
          action: "Run pithy add secrets to record SECRETS_STORE_ID, or mint with --store dev-vars.",
        });
      }
      await context.putSecret(context.storeEntryName, value);
      return { sink: store, location: "CF Secrets Store" };
    }
  }
}
