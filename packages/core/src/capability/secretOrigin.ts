// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * How a secret's value comes to exist, and how it is replaced.
 *
 * A secret the kit cannot mint leaves an adopter on their own. The registry has always known which
 * those are — no `devValue` — and nothing about how a human is supposed to get one, so every client
 * that wanted to help had to carry its own table of names, and a capability added tomorrow silently
 * fell off it.
 *
 * It lives in core, and in its own module, for the reason `devSecret.ts` does: both ends need it and
 * neither can import the other. The owning capability declares it on its `@pithy-sh/secrets` registry
 * entry; a client — `pithy doctor`, `pithy secrets ls`, a management dashboard — reads the same
 * declaration off `pithy.manifest.json`, which it must, since `pithy add` wires a capability without
 * ever executing it.
 *
 * **A function cannot cross into the manifest. A tag can.** So everything here is data, and the code
 * that knows what `random` means stays in the CLI — exactly as it already does for `devValue`.
 */

export const SecretIssuer = z
  .enum([
    "project",
    "cloudflare",
    "apple",
    "google",
    "github",
    "facebook",
    "microsoft",
    "stripe",
    "lemonSqueezy",
    "paddle",
    "gitlab",
    "atlassian",
    "other",
  ])
  .describe(
    "Who issues this value. `project` means it is arbitrary and ours to make. Every other member is a third party whose console or API is the only source: payments rails, auth's social providers, `cloudflare` for R2, Turnstile and API tokens, and the repository hosts an adopter may rotate CI credentials against. `other` is the floor an unrecognised issuer lands on, so a capability added tomorrow is renderable by a client built today.",
  );
export type SecretIssuer = z.output<typeof SecretIssuer>;

/**
 * The issuer field, everywhere it appears, with its one degradation rule attached.
 *
 * **An unrecognised issuer degrades to `other` rather than failing.** A manifest is read from
 * `node_modules`, so it can be newer than the client reading it — and a client that threw on an issuer
 * it had not been built against would blank a pane over a name it did not need to understand. `other`
 * is the honest answer: *somebody issues this, and I cannot help you with them.* Declared once, here,
 * because a rule stated at four field sites is a rule three of them will eventually miss.
 */
function issuedBy(description: string): z.ZodType<SecretIssuer, unknown> {
  return SecretIssuer.catch("other").describe(description);
}

/** The characters a secret name may hold. Excludes `/`, which separates a keyspace from a member key. */
const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** What a helper must supply, per item. Permission groups and scope names, and nothing that reads as code. */
const HELPER_NEED = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/;

/**
 * A documentation link, held to `https:` and nothing else.
 *
 * `z.url()` on its own is not enough here: it accepts `javascript:alert(1)`, and it accepts `http:`. A
 * manifest is third-party data read out of `node_modules`, and this is the one field in it whose whole
 * purpose is to be turned into an anchor an operator clicks. So the scheme is constrained at the schema,
 * where a client cannot forget to.
 */
const DOCUMENTATION_URL = /^https:\/\//;

/** The documentation field, wherever it appears: a real URL, and an `https:` one. */
function documentedAt(description: string) {
  return z.url().regex(DOCUMENTATION_URL).describe(description);
}

export const SecretRecipe = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z
        .literal("random")
        .describe("Random bytes rendered as a string. Any value works, because nothing outside the project reads it."),
      bytes: z
        .int()
        .positive()
        .describe(
          "Entropy before encoding. Stated because 32 and 16 are not interchangeable — a value sized for AES-256 that arrives half that long fails at decrypt, not at write, and by then it is stored.",
        ),
      encoding: z
        .enum(["base64url", "base64", "hex"])
        .describe(
          "How the bytes are rendered. The kit mints `base64url`, unpadded, so a value survives a `.dev.vars` line, a shell export and a URL without quoting.",
        ),
    }),
    z.object({
      kind: z
        .literal("encryptionConfig")
        .describe(
          "An `EncryptionConfig` — `currentVersion`, a `versions` map, `lastRotatedAt` — minted by `initialMasterKeyConfig`. `SECRETS_ENCRYPTION_KEYS` is the one, and the reason this is a union rather than an enum: it is minted, and a random string is not one of these. It states no `bytes` or `encoding` because the structure states its own.",
        ),
    }),
  ])
  .describe(
    "What produces a minted value. A tag the CLI resolves to code, never the code itself, because this crosses into the manifest.",
  );
export type SecretRecipe = z.output<typeof SecretRecipe>;

export const SecretOrigin = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z
        .literal("minted")
        .describe("The kit produces this value. Nothing outside the project has to agree with it."),
      recipe: SecretRecipe.describe("What produces it."),
    }),
    z.object({
      kind: z
        .literal("helped")
        .describe(
          "The kit cannot produce it, but knows enough to compose the command that does — a Cloudflare API token, whose permission groups an operator should not have to look up.",
        ),
      issuer: issuedBy("Whose console or API issues it."),
      needs: z
        .partialRecord(SecretIssuer, z.array(z.string().regex(HELPER_NEED)))
        .describe(
          "What a helper must supply, keyed by issuer. Cloudflare's key is its permission groups. Keyed rather than flat so a second issuer does not widen a shape every consumer must handle.",
        ),
      documentation: documentedAt(
        "Where the command's arguments come from, for an operator who would rather check them by hand.",
      ).optional(),
    }),
    z.object({
      kind: z
        .literal("obtained")
        .describe(
          "A human gets it from a third party and there is no command. An OAuth client secret is the case, and always will be.",
        ),
      issuer: issuedBy("Whose console issues it."),
      documentation: documentedAt(
        "Where a human goes. The specific settings page, not a product homepage — the point is to end a search, not to start one.",
      ),
    }),
  ])
  .describe(
    "How this secret's value first comes to exist. Closed, so a consumer branches rather than parses, and so an unhandled member is a type error rather than a blank screen.",
  );
export type SecretOrigin = z.output<typeof SecretOrigin>;

export const SecretRotation = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z
        .literal("local")
        .describe(
          'Replaced by producing a new value the same way it was minted. Every `origin.kind: "minted"` secret, and nothing else — if the kit can make one it can make another.',
        ),
    }),
    z.object({
      kind: z
        .literal("provider")
        .describe(
          "Replaced by calling the issuer, which returns the new value. The kit cannot invent this call; the capability or the adopter supplies it, and it changes state in somebody else's system.",
        ),
      issuer: issuedBy("Who is called."),
      documentation: documentedAt(
        "What the call does, for an operator deciding whether to trust it with a live credential.",
      ).optional(),
    }),
    z.object({
      kind: z
        .literal("manual")
        .describe(
          "A human, in a console. No API returns the new value — a GitHub or Google OAuth client secret. This is a real answer, not a missing one.",
        ),
      issuer: issuedBy("Whose console."),
      documentation: documentedAt("The page where it is done."),
    }),
  ])
  .describe(
    "How this secret is replaced, declared separately from `origin` because neither follows from the other: a GitLab token is `obtained` and rotates by `provider`, while an OAuth client secret is `obtained` and rotates only by `manual`. Declared per secret, never per issuer — some Cloudflare secrets roll and some do not.",
  );
export type SecretRotation = z.output<typeof SecretRotation>;

export const DeclaredSecret = z
  .object({
    name: z
      .string()
      .regex(SECRET_NAME)
      .describe(
        "The registry name the secret is declared under. Constrained, because a manifest is third-party data read from `node_modules` and this name reaches a rendered command.",
      ),
    origin: SecretOrigin.describe("How its value first comes to exist. Must match the registry entry's `origin`."),
    rotation: SecretRotation.describe("How it is replaced. Must match the registry entry's `rotation`."),
  })
  .describe(
    "One declared secret, as a manifest carries it: its registry name and both axes. Both, always — an origin without a rotation answers half of what an operator holding an overdue secret needs to know. The manifest's projection of the registry entry, and each capability's own tests assert the two agree.",
  );
export type DeclaredSecret = z.output<typeof DeclaredSecret>;
