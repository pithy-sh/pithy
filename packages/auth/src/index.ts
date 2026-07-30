// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add auth` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory, the `requireAuth()` gate other capabilities stack, and the data /
 * secret types an app or tool needs. Every other module is imported by deep path
 * (`@pithy-sh/auth/src/...`) — this is the documented contract, not a barrel over the package.
 */

export { AuthAuditActions } from "./audit/actions";
export { type AuthCapability, AuthConfig, type AuthConfigInput, auth, isAuthCapability } from "./capability";
export { type Device, DevicePlatform } from "./data/device";
export { type AuthDatabase, authDatabase } from "./data/tables";
export { DEVICE_HEADERS, type DeviceMeta } from "./device/registry";
export { requireAuth } from "./http/middleware";
export {
  AppleOAuthCredentials,
  AUTH_APPLE_CREDENTIALS,
  AUTH_GOOGLE_CREDENTIALS,
  AUTH_SESSION_SECRET,
  authSecretsRegistry,
  GoogleOAuthCredentials,
} from "./instance/secrets";
