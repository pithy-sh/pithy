// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add turnstile` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory plus the config types an app declares. The `turnstile()` *middleware* is
 * imported by deep path (`@pithy-sh/turnstile/src/http/middleware`) at the route that stacks it — this is
 * the documented contract, not a barrel over the package.
 */

export { isTurnstileCapability, type TurnstileCapability, turnstile } from "./capability";
export { type TurnstileConfig, type TurnstileConfigInput, TurnstileMode } from "./config/config";
