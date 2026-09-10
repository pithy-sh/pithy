// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The **binding name** every worker reads the master key through, fixed across environments — the
 * counterpart to `masterKeySecretName`, which scopes the Secrets Store *entry* the binding points at.
 * Local dev has no store: `.dev.vars` supplies this same name as a string, so it is also the key
 * `pithy add secrets` writes there.
 *
 * Stated once, and in a module of its own, because two very different readers need it. `env/bindings.ts`
 * is the reader beside it, and it declares the Workers types the binding resolves to. `registry.ts` is
 * the other, and `src/http/responses.ts` reaches it — an admin response schema a management client
 * validates **in a browser**. Importing a string from `env/bindings.ts` dragged `@cloudflare/workers-types`
 * the whole way there, which `tooling/browser-scopes` refuses. So the name is a leaf: **nothing here may
 * import anything**, and a near-miss between the writer and the reader is still one edit away from being
 * impossible rather than two.
 */
export const MASTER_KEY_BINDING = "SECRETS_ENCRYPTION_KEYS";
