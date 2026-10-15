// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandName } from "@pithy-sh/core/src/cli/command";
import { PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { secretsStoreIdMissing } from "../capabilities/notComposed";
import type { ConfirmedAccount } from "./accountAnswer";
import { type CloudflareAccountSelection, cloudflareAccountConfirmation, cloudflareEnv } from "./config";

/**
 * **The Cloudflare credentials a command provisions with, for the account the project belongs to** — one loader
 * for every provisioning command, where there were five private copies edited five times over one sentence
 * (#711).
 *
 * The account is a parameter rather than an ambient, so this cannot resolve before something has established
 * which account the project is for (#206). It also carries **what vouches for the account** (#378): a bare id
 * cannot tell "this account has no such Worker" from "I asked an account nothing claims" — the two arrive as one
 * empty listing.
 */
export interface CommandCredentials {
  /** The account, with what vouches for it. */
  account: ConfirmedAccount;
  /** `CLOUDFLARE_ACCOUNT_ID`. */
  accountId: string;
  /** `CLOUDFLARE_API_TOKEN`. */
  apiToken: string;
  /** `SECRETS_STORE_ID`, or `""` where the command did not ask for the store. */
  storeId: string;
  /** `R2_CREDENTIALS`, raw, where the account carries them. */
  r2Raw: string | undefined;
}

/** Why a command needs the account's Secrets Store, which makes its id required. */
export interface StoreNeed {
  /** The project root, whose Workers the `pithy add secrets` that records the id is offered for. */
  projectDir: string;
  /** What this command needs the store for, in a clause: "the email worker binds its link-signing key from it". */
  why: string;
}

/**
 * The refusal for an account with no credentials. It names no command (#711): `pithy init` records them only as it
 * scaffolds a new project, and inside this one it is refused for the files it would write.
 */
export function credentialsMissing(): PreconditionFailedError {
  return new PreconditionFailedError({
    message: "Cloudflare credentials are missing.",
    action: `Run ${commandName("cloudflare connect")} to sign in, or export CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for this project's account. Then run this again.`,
  });
}

/**
 * The credentials for `account`, or the refusal naming what is missing. With `store`, the Secrets Store id is
 * required too, and its absence is refused naming the `pithy add secrets` that records it.
 */
export function commandCredentials(account: CloudflareAccountSelection | null, store?: StoreNeed): CommandCredentials {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  const storeId = vars.SECRETS_STORE_ID ?? "";
  if (!accountId || !apiToken) throw credentialsMissing();
  if (store !== undefined && !storeId) throw secretsStoreIdMissing(store.projectDir, store.why);
  const confirmation = cloudflareAccountConfirmation({ account });
  return { account: { accountId, confirmation }, accountId, apiToken, storeId, r2Raw: vars.R2_CREDENTIALS };
}
