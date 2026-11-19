// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { KIT_SESSION_FIELDS, KIT_USER_FIELDS } from "../data/kitFields";
import { kitPlugins } from "../instance/plugins";

/**
 * The Better Auth options that shape the kit's whole schema, and only those: the model names, the kit's own
 * extra columns, the rate-limit table and the kit's own plugins ahead of `plugins`. A kit column missing here
 * would read as something a plugin brought; see `../data/kitFields.ts` for what that costs. The plugins'
 * callbacks are never invoked, since `getSchema` reads `plugin.schema` and not behavior. The drift test reads
 * the kit's tables through it, and `kitSchema.test.ts` holds `KIT_SCHEMA_FIELDS` to it.
 */
export function authSchemaOptions(plugins: readonly BetterAuthPlugin[]): BetterAuthOptions {
  return {
    user: { modelName: "pithyAuthUsers", additionalFields: KIT_USER_FIELDS },
    session: { modelName: "pithyAuthSessions", additionalFields: KIT_SESSION_FIELDS },
    account: { modelName: "pithyAuthAccounts" },
    verification: { modelName: "pithyAuthVerifications" },
    rateLimit: { enabled: true, storage: "database", modelName: "pithyAuthRateLimit" },
    plugins: [
      ...kitPlugins({
        verificationExpiresIn: 300,
        otpLength: 6,
        disableSignUp: false,
        sendEmail: async () => ({ delivery: "queued" }),
        emit: async () => undefined,
      }),
      ...plugins,
    ],
  };
}
