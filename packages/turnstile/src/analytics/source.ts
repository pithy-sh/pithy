// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareManagerConfig } from "@pithy-sh/cloudflare/src/client/manager";
import { RUNTIME_TOKEN_SECRET } from "@pithy-sh/cloudflare/src/tokens/runtime";
import { pithyCommandOf } from "@pithy-sh/core/src/cli/command";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { runtimeTokenRegistry } from "@pithy-sh/secrets/src/tokens/runtimeTokenRegistry";
import { TurnstileConfigError } from "../error/errors";
import {
  TURNSTILE_ACCOUNT_SECRET,
  TURNSTILE_RUNTIME_PERMISSIONS,
  type TurnstileAccount,
  turnstileAccountRegistry,
} from "../secret/registry";

/** The command that writes the account, named for a refusal. */
const PROVISION = pithyCommandOf("turnstile provision", {}, { runtime: true });

/**
 * **How this Worker reaches Turnstile's analytics: the application's one runtime token, and the account
 * the widgets live in (#731).** Resolved at the first call and never before, so a test-key environment
 * reads neither.
 *
 * Both are read through the one secrets reader. The token is the `runtime` profile's, declared through
 * `@pithy-sh/secrets`' factory with turnstile's own need. An environment holding no account is refused by
 * name: the read cannot ask Cloudflare anything without it, and the fix is one provision away. The
 * message names that provision, because `clientError` strips `action` before a control-plane caller sees it.
 */
export function turnstileAnalyticsConfig(env: SecretsStoreEnv): () => Promise<CloudflareManagerConfig> {
  let resolved: Promise<CloudflareManagerConfig> | undefined;
  return () => {
    resolved ??= (async () => {
      let account: TurnstileAccount | null = null;
      let unreadable: unknown;
      try {
        account = (await sharedSecretsStore(env, turnstileAccountRegistry)).get(TURNSTILE_ACCOUNT_SECRET);
      } catch (cause) {
        unreadable = cause;
      }
      if (account === null) {
        throw new TurnstileConfigError(
          {
            // The remedy is in the message: a control-plane caller gets the wire shape, which drops `action`.
            message: `This environment holds no record of the Cloudflare account its widgets live in. Run \`${PROVISION}\` to record it.`,
            action: `Run \`${PROVISION}\`. It writes ${TURNSTILE_ACCOUNT_SECRET} for dev, staging and prod.`,
            detail: `reading "${TURNSTILE_ACCOUNT_SECRET}" ${unreadable instanceof Error ? `failed: ${unreadable.message}` : "found nothing"}`,
          },
          { cause: unreadable },
        );
      }
      const runtime = await sharedSecretsStore(env, runtimeTokenRegistry(TURNSTILE_RUNTIME_PERMISSIONS));
      return { apiToken: runtime.get(RUNTIME_TOKEN_SECRET), accountId: account.accountId };
    })();
    return resolved;
  };
}
