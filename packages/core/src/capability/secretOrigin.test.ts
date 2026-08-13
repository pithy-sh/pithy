// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { DeclaredSecret, SecretIssuer, SecretOrigin, SecretRecipe, SecretRotation } from "./secretOrigin";

describe("SecretIssuer", () => {
  test("names the parties the kit actually integrates, plus the project and a floor", () => {
    expect(SecretIssuer.options).toContain("project");
    expect(SecretIssuer.options).toContain("cloudflare");
    expect(SecretIssuer.options).toContain("github");
    expect(SecretIssuer.options).toContain("other");
  });
});

describe("SecretOrigin", () => {
  test("describes a random-string mint", () => {
    const parsed = SecretOrigin.parse({
      kind: "minted",
      recipe: { kind: "random", bytes: 32, encoding: "base64url" },
    });
    expect(parsed).toEqual({ kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } });
  });

  test("describes the master key, which is minted and is not a random string", () => {
    // The correction this union exists for. `SECRETS_ENCRYPTION_KEYS` is minted — by
    // `initialMasterKeyConfig` — and its value is an `EncryptionConfig`. A `recipe` that only knew
    // `random` could not say so, and the first secret the field could not describe would be the one it
    // was drafted around.
    const parsed = SecretOrigin.parse({ kind: "minted", recipe: { kind: "encryptionConfig" } });
    expect(parsed).toEqual({ kind: "minted", recipe: { kind: "encryptionConfig" } });
  });

  test("a random recipe must state its size — that is the whole reason it is stated", () => {
    expect(SecretRecipe.safeParse({ kind: "random" }).success).toBe(false);
    expect(SecretRecipe.safeParse({ kind: "random", bytes: 0, encoding: "hex" }).success).toBe(false);
  });

  test("a field a reader does not know is dropped, not refused", () => {
    // A manifest is read from `node_modules` and may be newer than the client reading it. Strictness
    // here would turn every additive change into a hard failure in the field, which is the opposite of
    // what `other` buys on the issuer axis.
    expect(SecretRecipe.parse({ kind: "encryptionConfig", tomorrowsField: 1 })).toEqual({ kind: "encryptionConfig" });
  });

  test("describes a helped secret by what the helper needs", () => {
    const parsed = SecretOrigin.parse({
      kind: "helped",
      issuer: "cloudflare",
      needs: { cloudflare: ["secrets:read", "secrets:write"] },
    });
    expect(parsed).toEqual({
      kind: "helped",
      issuer: "cloudflare",
      needs: { cloudflare: ["secrets:read", "secrets:write"] },
    });
  });

  test("describes an obtained secret by where a human goes", () => {
    const parsed = SecretOrigin.parse({
      kind: "obtained",
      issuer: "github",
      documentation: "https://github.com/settings/developers",
    });
    expect(parsed.kind).toBe("obtained");
  });

  test("an obtained secret must say where — a bare `go and get one` ends no search", () => {
    expect(SecretOrigin.safeParse({ kind: "obtained", issuer: "github" }).success).toBe(false);
    expect(SecretOrigin.safeParse({ kind: "obtained", issuer: "github", documentation: "settings" }).success).toBe(
      false,
    );
  });

  test("documentation must be https — a manifest is third-party data and this field becomes a link", () => {
    // `z.url()` alone accepts `javascript:alert(1)`. This one is read out of `node_modules` and rendered
    // as an anchor by a management client, so the scheme is constrained rather than assumed.
    for (const documentation of ["javascript:alert(1)", "http://github.com/settings", "data:text/html,x"]) {
      expect(SecretOrigin.safeParse({ kind: "obtained", issuer: "github", documentation }).success).toBe(false);
    }
  });

  test("an unrecognised kind fails rather than degrading — a consumer must branch, not guess", () => {
    expect(SecretOrigin.safeParse({ kind: "conjured" }).success).toBe(false);
  });

  test("an unrecognised issuer keeps its own key — the field degrades, the key cannot", () => {
    // A key is *not* a field. `SecretIssuer.catch("other")` rewrites what it parses, which is harmless
    // on a field and destructive on a key: the rewritten key lands on `other`, and whatever `other`
    // already held is overwritten with no error anywhere. So the key is preserved verbatim and the
    // reader decides at render time whether it recognises the name.
    const parsed = SecretOrigin.parse({
      kind: "helped",
      issuer: "vercel",
      needs: { vercel: ["deployments:write"] },
    });
    expect(parsed).toEqual({
      kind: "helped",
      issuer: "other",
      needs: { vercel: ["deployments:write"] },
    });
  });

  test("two unrecognised issuers keep both sets of scopes — nothing collapses onto `other`", () => {
    // The measured harm. Keyed by `SecretIssuer.catch("other")` this parsed to `{ other: ["b"] }`:
    // vercel's requirement was gone, and the parse succeeded, so nothing reported it. Requirements
    // silently lost are worse than a manifest that refuses to parse, because a refusal is visible.
    const parsed = SecretOrigin.parse({
      kind: "helped",
      issuer: "vercel",
      needs: { vercel: ["deployments:write"], netlify: ["sites:write"], other: ["read"] },
    });
    expect(parsed).toEqual({
      kind: "helped",
      issuer: "other",
      needs: { vercel: ["deployments:write"], netlify: ["sites:write"], other: ["read"] },
    });
  });

  test("a known issuer's key survives an unknown one beside it", () => {
    const parsed = SecretOrigin.parse({
      kind: "helped",
      issuer: "cloudflare",
      needs: { cloudflare: ["secrets:read"], vercel: ["deployments:write"] },
    });
    expect(parsed).toMatchObject({ needs: { cloudflare: ["secrets:read"], vercel: ["deployments:write"] } });
  });

  test("a key that is not shaped like an issuer name is refused", () => {
    // The key is preserved rather than rewritten, so it reaches a rendered command and a rendered
    // heading unchanged. That is the trade: it keeps its own scopes, and it is held to a name.
    for (const key of ["needs a space", "$(id)", "vercel;rm -rf /"]) {
      expect(
        SecretOrigin.safeParse({ kind: "helped", issuer: "cloudflare", needs: { [key]: ["x"] } }).success,
        key,
      ).toBe(false);
    }
  });

  test("an unrecognised issuer degrades to `other` rather than failing", () => {
    // A capability added tomorrow names an issuer a client built today has never heard of. The client
    // renders it as documented-only and keeps working; it does not blank the pane.
    const parsed = SecretOrigin.parse({
      kind: "obtained",
      issuer: "vercel",
      documentation: "https://vercel.com/account/tokens",
    });
    expect(parsed).toMatchObject({ issuer: "other" });
  });
});

describe("SecretRotation", () => {
  test("local names no issuer — nobody else is involved", () => {
    expect(SecretRotation.parse({ kind: "local" })).toEqual({ kind: "local" });
  });

  test("provider names who is called", () => {
    const parsed = SecretRotation.parse({ kind: "provider", issuer: "cloudflare" });
    expect(parsed).toMatchObject({ kind: "provider", issuer: "cloudflare" });
  });

  test("manual names the page where a human does it", () => {
    expect(
      SecretRotation.safeParse({ kind: "manual", issuer: "github", documentation: "https://github.com/settings" })
        .success,
    ).toBe(true);
    expect(SecretRotation.safeParse({ kind: "manual", issuer: "github" }).success).toBe(false);
  });

  test("an unrecognised issuer degrades here too", () => {
    expect(SecretRotation.parse({ kind: "provider", issuer: "vercel" })).toMatchObject({ issuer: "other" });
  });
});

describe("DeclaredSecret", () => {
  test("carries both axes — one of them alone answers half a question", () => {
    const parsed = DeclaredSecret.parse({
      name: "auth-session-secret",
      origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } },
      rotation: { kind: "local" },
    });
    expect(parsed.name).toBe("auth-session-secret");
    expect(
      DeclaredSecret.safeParse({
        name: "auth-session-secret",
        origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } },
      }).success,
    ).toBe(false);
  });

  test("a name is constrained, because a manifest is third-party data", () => {
    expect(
      DeclaredSecret.safeParse({
        name: "auth }) ; evil(",
        origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } },
        rotation: { kind: "local" },
      }).success,
    ).toBe(false);
  });
});
