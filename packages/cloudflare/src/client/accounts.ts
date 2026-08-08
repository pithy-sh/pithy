// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Cloudflare } from "cloudflare";
import { z } from "zod";
import { cloudflareRequest } from "./errors";

/**
 * The accounts a bootstrap API token can see — `GET /accounts`.
 *
 * **The one Cloudflare read in this package that is not account-scoped**, which is why it is a function
 * here rather than a manager: {@link CloudflareManager} takes an `accountId` in its config and refuses
 * without one, and this is the call made *before* an account id exists. `pithy init` collects the token
 * two prompts before it lists zones, and until now it took the account id on trust — pasted, unverified,
 * and wrong often enough that "the token is for one account and the id is another" is a documented
 * failure mode (`CLOUDFLARE_CREDENTIAL_KEYS`). Asking the token what it can see removes that class
 * outright, and the account's own name is a better nickname than one invented at a prompt (#206).
 *
 * Read-only, and never required: a narrowly scoped token that cannot list accounts is a legitimate
 * token, and every caller falls back to asking.
 */

/** One Cloudflare account, as `GET /accounts` lists it. Two fields, because two is all anything here uses. */
export const CfAccount = z
  .object({
    id: z
      .string()
      .describe("The account id every provisioned resource is created under, and the value a project pins."),
    name: z
      .string()
      .describe("The account's own name, as the operator set it — free text, e.g. `Leed, Inc.`, never a slug."),
  })
  .describe("One Cloudflare account a bootstrap API token can see.");
export type CfAccount = z.output<typeof CfAccount>;

/**
 * More than this and a picker is not a picker. A token seeing hundreds of accounts is somebody's
 * reseller credential, and walking every page of it to build a `select` helps nobody — the cap keeps one
 * unusual token from turning `pithy init` into a paginated crawl.
 */
const MAX_ACCOUNTS = 100;

/** What {@link listCloudflareAccounts} needs: a token, and — for a test — somewhere other than Cloudflare. */
export interface ListCloudflareAccountsOptions {
  /** The bootstrap API token. Never logged; it is only ever handed to the SDK. */
  apiToken: string;
  /**
   * Seam: the raw account records. Defaults to the SDK's own paginated `accounts.list()`.
   *
   * A test passing this never reaches Cloudflare, which matters more here than anywhere else in the
   * package: the default would list the operator's real accounts using whatever token their shell
   * exports.
   */
  accounts?: (client: Cloudflare) => AsyncIterable<unknown>;
}

/**
 * Every account this token can see, name-sorted so a picker is stable between runs.
 *
 * **Each record is validated, and one that does not parse is dropped rather than passed on.** This is a
 * response from outside crossing into a value that becomes `cloudflare.accountId` in a repository and
 * the account every later resource is created under; a half-record would put an `undefined` id into a
 * config file and a `[object Object]` into an error message. The same rule `listZones` follows.
 *
 * Throws a `cloudflare/request_failed` when the account list could not be read at all — a token without
 * the permission, or no network. Callers treat that as "no picker" and ask instead.
 */
export async function listCloudflareAccounts(options: ListCloudflareAccountsOptions): Promise<CfAccount[]> {
  return cloudflareRequest("list accounts", async () => {
    const client = new Cloudflare({ apiToken: options.apiToken });
    const source = options.accounts ?? ((sdk: Cloudflare) => sdk.accounts.list());
    const accounts: CfAccount[] = [];
    for await (const record of source(client)) {
      const parsed = CfAccount.safeParse(record);
      if (parsed.success) accounts.push(parsed.data);
      if (accounts.length >= MAX_ACCOUNTS) break;
    }
    return accounts.sort((a, b) => a.name.localeCompare(b.name));
  });
}
