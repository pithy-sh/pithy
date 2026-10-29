// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, test, vi } from "vitest";

/**
 * **A correct code for an account that may not act goes on to the screen for that state** (#620).
 *
 * The Worker answers the OTP sign-in for a suspended or deleted account with a 403 carrying
 * `auth/account_suspended` or `auth/account_deleted`. Read as a wrong code, that is "That code didn't work",
 * and the person tries again, and again, with a code that was right. So the screen asks the refusal's code
 * the same question the callback and the sign-in screen ask, and routes by role.
 *
 * The router is stubbed so the destination is a path invented here: a screen that wrote the destination as a
 * literal would still go to the real one, and this goes red.
 */

const SUSPENDED_CANARY = "/canary-suspended-screen";
const DELETED_CANARY = "/canary-deleted-screen";

const navigated: string[] = [];
let answer: { ok: true; value: unknown } | { ok: false; failure: { code: string; message: string; action: null } };

vi.mock("../../pithy-config", () => ({
  authConfig: { enabled: true, basePath: "/auth", otpLength: 6 },
  turnstileConfig: { enabled: false, sitekey: "", mode: "visible", action: "", token: { field: "", header: null } },
}));

vi.mock("../../router", () => {
  const byRole = new Map<string, string>([
    ["account-suspended", SUSPENDED_CANARY],
    ["account-deleted", DELETED_CANARY],
    ["sign-in", "/sign-in"],
  ]);
  return {
    navigate: (to: string) => {
      navigated.push(to);
    },
    useSearchParam: () => "someone@example.com",
    routeTable: async () => ({ byRole }),
  };
});

vi.mock("@pithy-sh/auth/src/client/api", () => ({
  signInWithOtp: async () => answer,
  sendOtp: async () => ({ ok: true, value: null }),
  getSession: async () => ({ ok: true, value: null }),
  signOut: async () => ({ ok: true, value: null }),
}));

// React refuses to run `act` unless the environment says it is a test one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  navigated.length = 0;
  document.body.innerHTML = "";
});

/** Render the screen, type a full code, press sign in, and hand back what it rendered. */
async function submitCode(): Promise<HTMLElement> {
  const { default: Otp } = await import("./otp");
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    createRoot(host).render(<Otp />);
  });
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  for (const input of host.querySelectorAll<HTMLInputElement>(".otp input")) {
    await act(async () => {
      setter?.call(input, "1");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const submit = host.querySelector<HTMLButtonElement>("button[type=button]");
  expect(submit?.disabled, "the sign-in button stayed disabled with a full code").toBe(false);
  await act(async () => {
    submit?.click();
  });
  // The route table is a promise; let it settle.
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

test("a suspended account's correct code goes on to the suspended screen, not to 'that code didn't work'", async () => {
  // The canaries must not have drifted onto the real paths: those would pass against a screen that wrote them.
  expect(SUSPENDED_CANARY).not.toBe("/account-suspended");
  expect(DELETED_CANARY).not.toBe("/account-deleted");
  answer = { ok: false, failure: { code: "auth/account_suspended", message: "Under review.", action: null } };
  const host = await submitCode();
  expect(navigated).toEqual([SUSPENDED_CANARY]);
  expect(host.textContent).not.toContain("didn't work");
});

test("a deleted account's correct code goes on to the deleted screen", async () => {
  answer = { ok: false, failure: { code: "auth/account_deleted", message: "Deleted.", action: null } };
  await submitCode();
  expect(navigated).toEqual([DELETED_CANARY]);
});

test("a wrong code is still a wrong code", async () => {
  answer = { ok: false, failure: { code: "auth/invalid_otp", message: "Invalid OTP.", action: null } };
  const host = await submitCode();
  expect(navigated).toEqual([]);
  expect(host.textContent).toContain("That code didn't work.");
});
