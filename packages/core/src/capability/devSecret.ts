// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * A secret whose value is **arbitrary**, and can therefore be minted for local dev.
 *
 * The rule, stated once and here: a secret is generatable when nothing outside the project has to
 * agree with its value. A session signing key is; an OAuth client secret registered with a provider,
 * or a Stripe key, is not — a generated value there authenticates against nothing, and hides a real
 * gap behind one that looks filled in.
 *
 * It lives in core, and in its own module, because both ends need it and neither can import the
 * other: the owning capability declares it on its `@pithy-sh/secrets` registry entry, and the CLI
 * reads the same declaration off `pithy.manifest.json` — which it must, since `pithy add` wires a
 * capability without ever executing it.
 */

export const DevSecretValue = z
  .enum(["random"])
  .describe("How `pithy add` mints a secret's dev value. `random` is a random string and nothing else.");
export type DevSecretValue = z.infer<typeof DevSecretValue>;

/**
 * One declared dev secret, as a manifest carries it: the registry name, and how its value is minted.
 *
 * The manifest's projection of the registry entry's `devValue`. Each capability's own tests assert the
 * two agree, the way `requiredBindings` and `peerCapabilities` already mirror the runtime capability.
 */
export const DevSecret = z
  .object({
    name: z
      .string()
      .min(1)
      .describe(
        "The registry name the secret is declared under — also the `.dev.vars` key, since local dev resolves every secret from its injected string.",
      ),
    devValue: DevSecretValue.describe("How the dev value is minted. Must match the registry entry's `devValue`."),
  })
  .describe("A secret whose dev value `pithy add` mints, because its value is arbitrary.");
export type DevSecret = z.infer<typeof DevSecret>;
