// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type AmbientEnv, compositionEnvironment } from "@pithy-sh/core/src/env/ambient";
import { isContinuousIntegration } from "@pithy-sh/core/src/env/ci";
import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import { DEV_LOGIN_ROUTE } from "@pithy-sh/core/src/seed/devLogin";
import { attestationIsConfigured } from "../attestation/config";
import type { AuthConfig } from "../capability";
import type { SignInMethods } from "../instance/signInMethods";
import { authAdminRoutes } from "./guards";

/**
 * Whether the dev sign-in route mounts in this composition. Two gates, independently: the composition's
 * environment is `dev`, and this is not continuous integration. `undefined`, nothing stamped, is not `dev`.
 */
export function devLoginMounts(env: AmbientEnv): boolean {
  return compositionEnvironment(env) === "dev" && !isContinuousIntegration(env);
}

/** Better Auth's email sign-in endpoints for the methods composed. A method left out has none. */
function emailSignInTable(methods: SignInMethods): (readonly ["GET" | "POST", string])[] {
  return [
    ...(methods.magicLink
      ? ([
          ["POST", "/sign-in/magic-link"],
          ["GET", "/magic-link/verify"],
        ] as const)
      : []),
    ...(methods.emailOtp
      ? ([
          ["POST", "/email-otp/send-verification-otp"],
          ["POST", "/sign-in/email-otp"],
        ] as const)
      : []),
  ];
}

/**
 * Every route the auth capability mounts, in the order it mounts them: the dev sign-in when it mounts, the
 * attestation routes once any environment has an attestation block, the session and account routes, the
 * email sign-in endpoints `methods` leaves on, the management surface, and Better Auth's catch-all last.
 */
export function authRouteTable(config: AuthConfig, devLogin: boolean): DeclaredRoute[] {
  const base = config.basePath;
  return [
    ...(devLogin ? [{ method: "GET" as const, path: DEV_LOGIN_ROUTE }] : []),
    ...(attestationIsConfigured(config.attestation)
      ? declareRoutes(base, [
          ["POST", "/attestation/challenge"],
          ["POST", "/attestation/ios/keys"],
        ])
      : []),
    ...declareRoutes(base, [
      ["POST", "/token/rotate"],
      ["GET", "/sign-in/social/start"],
      ["POST", "/handoff"],
      ["GET", "/devices"],
      ["POST", "/devices/revoke"],
      ["DELETE", "/account"],
      ["POST", "/link-social"],
      ["POST", "/unlink-account"],
      ["GET", "/profile/image"],
      ...emailSignInTable(config.methods),
    ]),
    ...adminRouteTable(authAdminRoutes(base)),
    { method: "ALL", path: `${base}/*` },
  ];
}
