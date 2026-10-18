// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **The names of the one Cloudflare API token a deployed application holds (#728)**, in a module of their
 * own. A Worker reads the token by {@link RUNTIME_TOKEN_SECRET}, and importing the profile registry to
 * learn a string would put the token-minting client on every Worker's bundle. Nothing here imports anything.
 */

/** The name of the one runtime token — the single Cloudflare API token a deployed application holds (#728). */
export const RUNTIME_PROFILE = "runtime";

/**
 * The secret the runtime token's value is stored under, and the binding every Worker that calls Cloudflare
 * reads it through. Unscoped, because it is a binding name: the Secrets Store entry it resolves to carries
 * the project and environment (`<project>-<env>-runtime-cf-api-token`).
 */
export const RUNTIME_TOKEN_SECRET = "RUNTIME_CF_API_TOKEN";
