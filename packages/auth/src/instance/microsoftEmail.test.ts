// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  MICROSOFT_PERSONAL_ACCOUNTS_TENANT_ID,
  microsoftEmailVerified,
  microsoftProfileToUser,
} from "./microsoftEmail";

/**
 * The rule that decides whether an Entra ID email is the signer's own (#262).
 *
 * Entra cannot vouch for an email it did not verify: the `email` claim is read from a directory `mail`
 * attribute a tenant admin sets to any string, and work and school tokens carry no `email_verified`. So
 * every case here is about what a hostile tenant can and cannot put in a token. It can write `email`. It
 * cannot write `xms_edov` or `tid`, because Microsoft computes both.
 */

/** A work-account token from some tenant, as a hostile admin would mint it: any address, no proof. */
const WORK = { tid: "72f988bf-86f1-41af-91ab-2d7cd011db47", oid: "o-1", email: "ceo@victim.test" };

describe("microsoftEmailVerified, signed out", () => {
  test("verified when Microsoft says the tenant owns the email's domain", () => {
    expect(microsoftEmailVerified({ ...WORK, xms_edov: true }, null)).toBe(true);
  });

  test("verified for a personal Microsoft account, which has no directory and no admin to edit it", () => {
    expect(microsoftEmailVerified({ ...WORK, tid: MICROSOFT_PERSONAL_ACCOUNTS_TENANT_ID }, null)).toBe(true);
  });

  test("the personal-accounts tenant is the one Microsoft documents", () => {
    // Pinned by value, so a typo in the constant is a red test rather than a silent "never personal".
    expect(MICROSOFT_PERSONAL_ACCOUNTS_TENANT_ID).toBe("9188040d-6c67-4c5b-b112-36a304b66dad");
  });

  // Absence is never read as verification, and only the boolean `true` is.
  test.each([
    ["the claim absent", WORK],
    ["xms_edov false", { ...WORK, xms_edov: false }],
    ["xms_edov the string 'true'", { ...WORK, xms_edov: "true" }],
    ["xms_edov the number 1", { ...WORK, xms_edov: 1 }],
    ["xms_edov null", { ...WORK, xms_edov: null }],
    ["xms_edov an object", { ...WORK, xms_edov: { value: true } }],
    ["email_verified true, which Entra never issues and a mapper must not honor", { ...WORK, email_verified: true }],
    ["verified_primary_email naming the address", { ...WORK, verified_primary_email: [WORK.email] }],
    ["a tid that only differs in case", { ...WORK, tid: MICROSOFT_PERSONAL_ACCOUNTS_TENANT_ID.toUpperCase() }],
    ["a tid that is not a string", { ...WORK, tid: 9188040 }],
    ["no tid at all", { oid: "o-1", email: "ceo@victim.test" }],
    ["an empty profile", {}],
  ])("unverified with %s", (_label, profile) => {
    expect(microsoftEmailVerified(profile as Record<string, unknown>, null)).toBe(false);
  });
});

/**
 * The challenge's second half: signed in by magic link, connecting Microsoft from inside the account.
 *
 * The magic link proved the account's own address. A Microsoft identity naming that same address is then
 * verified — by the kit, not by Microsoft — and only that one address: a different one stays unverified,
 * which is what Better Auth's link branch refuses.
 */
describe("microsoftEmailVerified, linking from inside the account", () => {
  test("verified when the email is the signed-in account's own address", () => {
    expect(microsoftEmailVerified(WORK, { email: "ceo@victim.test" })).toBe(true);
  });

  test("matched without regard to case, as Better Auth stores and compares addresses", () => {
    expect(microsoftEmailVerified({ ...WORK, email: "CEO@Victim.Test" }, { email: "ceo@victim.test" })).toBe(true);
  });

  test("unverified when the email is some other address", () => {
    expect(microsoftEmailVerified(WORK, { email: "someone-else@victim.test" })).toBe(false);
  });

  test.each([
    ["no email claim", { tid: WORK.tid, oid: "o-1" }, { email: "ceo@victim.test" }],
    ["an email that is not a string", { ...WORK, email: ["ceo@victim.test"] }, { email: "ceo@victim.test" }],
    ["a link carrying no address", WORK, { email: undefined }],
    ["a link carrying an empty address", { ...WORK, email: "" }, { email: "" }],
  ])("unverified with %s", (_label, profile, link) => {
    expect(microsoftEmailVerified(profile as Record<string, unknown>, link)).toBe(false);
  });
});

describe("microsoftProfileToUser", () => {
  test("states the flag every time, so Better Auth's own default never stands", async () => {
    // Better Auth falls back to `email_verified`, then to `verified_primary_email`, both of which a
    // hostile tenant can influence. The mapper is spread after that default, so it must always say.
    expect(await microsoftProfileToUser({ ...WORK, verified_primary_email: [WORK.email] })).toEqual({
      emailVerified: false,
    });
    expect(await microsoftProfileToUser({ ...WORK, xms_edov: true })).toEqual({ emailVerified: true });
  });

  test("outside a request there is no link in progress, and it fails closed rather than throwing", async () => {
    // `getOAuthState()` throws where no request state was established. A mapper reached by hand must
    // answer unverified, never pass the throw up as a sign-in error or read it as a link.
    expect(await microsoftProfileToUser(WORK)).toEqual({ emailVerified: false });
  });
});
