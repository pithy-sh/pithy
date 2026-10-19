// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ArtifactsInvalidConfigError } from "../error/errors";

/**
 * Cloudflare's shortest token life. `createToken` refuses anything under a minute with `INVALID_TTL`, so a config
 * below it would boot and then refuse every mint.
 */
export const MIN_TOKEN_TTL_SECONDS = 60;

/**
 * **The kit's ceiling on a token's life: an hour.** Cloudflare documents a maximum of a year. There is no token
 * table here, so the TTL is the revocation window, and a long one is not a tuned timeout, it is revocation turned
 * off. This number is the kit's judgment, stated as one.
 */
export const MAX_TOKEN_TTL_SECONDS = 3600;

/** What `artifacts({ … })` takes, besides the `repoName` seam. */
export const ArtifactsConfig = z
  .object({
    basePath: z
      .string()
      .startsWith("/")
      .default("/artifacts")
      .describe("Where the repository routes mount. Changing it changes every address this capability serves."),
    tokenTtlSeconds: z
      .number()
      .int()
      .min(MIN_TOKEN_TTL_SECONDS)
      .max(MAX_TOKEN_TTL_SECONDS)
      .default(900)
      .describe(
        "How long a minted git token lives, in seconds: 60 to 3600, default 900. **This is the revocation window.** There is no token record, so after a grant is removed this is how long a revoked person keeps pushing, unless the owner revokes every token on the repository. A git client re-mints per operation, so a short life costs nothing.",
      ),
    managePower: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The organization power that lets a member manage the organization's repositories, e.g. `repos:manage`. Your own name, declared in your role catalog. Required when `organization` is composed, and refused at boot when the catalog does not declare it. Ignored without `organization`.",
      ),
    acceptRepoName: z
      .boolean()
      .default(false)
      .describe(
        "Let a create request supply the repository's physical name — the one in the clone URL. Off by default: the name is a random UUID, which cannot collide and cannot be guessed. Turn it on and uniqueness is yours, and a collision is a refusal you caused.",
      ),
    binding: z
      .string()
      .min(1)
      .default("ARTIFACTS")
      .describe("The Worker env binding the Artifacts namespace is bound as."),
  })
  .describe("The artifacts capability's configuration.");
export type ArtifactsConfig = z.output<typeof ArtifactsConfig>;
export type ArtifactsConfigInput = z.input<typeof ArtifactsConfig>;

/**
 * Parse the config, or refuse it at boot. The TTL's refusal names the ceiling and what it means, because the only
 * reason to ask for more is not knowing that it is the window a revoked person keeps pushing in.
 */
export function parseArtifactsConfig(input: ArtifactsConfigInput): ArtifactsConfig {
  const parsed = ArtifactsConfig.safeParse(input);
  if (parsed.success) return parsed.data;
  const ttl = parsed.error.issues.some((issue) => issue.path[0] === "tokenTtlSeconds");
  throw new ArtifactsInvalidConfigError({
    message: ttl
      ? `tokenTtlSeconds must be a whole number from ${MIN_TOKEN_TTL_SECONDS} to ${MAX_TOKEN_TTL_SECONDS}. It is the revocation window: a revoked person keeps pushing for that long.`
      : "The artifacts configuration is invalid.",
    action: "Fix the artifacts({ … }) block in pithy.config.ts.",
    detail: parsed.error.message,
  });
}
