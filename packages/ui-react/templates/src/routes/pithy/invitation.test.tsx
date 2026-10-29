// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

/**
 * **Accepting an invitation puts you in the account you joined, and leaves by a document load.**
 *
 * Joining does not move the account in force. The server writes the membership and stops there, so a screen that
 * accepts and goes home lands somebody back in whatever account they were acting in before, with no sign that the
 * one they just joined exists. The screen records the choice itself, and this test asserts the write happened.
 *
 * Leaving is a document load for the chooser's reason. What is in force decides what every request may reach, and a
 * route change keeps whatever the previous account's data had already populated on the page. It looks identical in a
 * manual test, because the person testing it usually belongs to one account.
 *
 * The third behavior is the one nobody already signed in can see: a stranger holding the link is shown the offer, and
 * sent to sign in with this page as the place to come back to.
 */

const TOKEN = "tok_canary-invitation";
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const OFFER = {
  organizationName: "Acme Games",
  inviterName: "Ada Lovelace",
  role: "editor",
  expiresAt: "2026-11-04T12:00:00.000Z",
};
const ACCEPTED = { organizationId: ORGANIZATION_ID, membershipId: "m1", role: "editor", joined: true };
const INVALID = {
  code: "organization/invitation_invalid",
  message: "That invitation can no longer be accepted.",
  action: "Ask for a new one.",
};

const { readInvitation, acceptInvitation, chooseOrganization, getSession } = vi.hoisted(() => ({
  readInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  chooseOrganization: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@pithy-sh/organization/src/client/api", () => ({ readInvitation, acceptInvitation, chooseOrganization }));
vi.mock("../../session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../session")>()),
  getSession,
}));

/**
 * The router, with destinations invented here, so a screen that wrote the sign-in or suspended screen's path as a
 * literal goes red. Its navigation is the real one, which pushes history, so the document-load test below still
 * catches a screen that reaches for it.
 */
const SIGN_IN_CANARY = "/canary-sign-in";
const SUSPENDED_CANARY = "/canary-organization-suspended";
vi.mock("../../router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../router")>()),
  routeTable: async () => ({
    byRole: new Map([
      ["sign-in", SIGN_IN_CANARY],
      ["organization-suspended", SUSPENDED_CANARY],
    ]),
  }),
}));

let host: HTMLElement;
let assign: ReturnType<typeof vi.fn>;
let pushState: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  assign = vi.fn();
  Object.defineProperty(window, "location", { value: { ...window.location, assign }, writable: true });
  pushState = vi.spyOn(window.history, "pushState");
  readInvitation.mockReset();
  acceptInvitation.mockReset();
  chooseOrganization.mockReset();
  getSession.mockReset();
  readInvitation.mockResolvedValue({ ok: true, value: OFFER });
  getSession.mockResolvedValue({ user: { id: "u1", email: "ada@example.com" } });
});

afterEach(() => {
  host.remove();
  pushState.mockRestore();
  vi.resetModules();
});

/** Render the screen for `TOKEN` and let its reads settle. */
async function render(): Promise<void> {
  const { default: Invitation } = await import("./invitation");
  await act(async () => {
    createRoot(host).render(<Invitation params={{ token: TOKEN }} />);
  });
}

/** Click the one button whose text contains `label`. */
async function click(label: string): Promise<void> {
  const button = [...host.querySelectorAll("button")].find((each) => each.textContent?.includes(label));
  expect(button, `no button reads "${label}"`).toBeDefined();
  await act(async () => {
    button?.click();
  });
}

test("the offer says who is asking, to what, as what, and until when", async () => {
  await render();

  expect(readInvitation).toHaveBeenCalledWith(TOKEN);
  expect(host.querySelector("h1")?.textContent).toContain("Acme Games");
  expect(host.textContent).toContain("Ada Lovelace");
  expect(host.textContent).toContain("editor");
  expect(host.textContent).toContain("November 4, 2026");
  expect(host.textContent).toContain("ada@example.com");
});

test("an inviter whose account is gone is left out rather than named as nobody", async () => {
  readInvitation.mockResolvedValue({ ok: true, value: { ...OFFER, inviterName: null } });

  await render();

  expect(host.textContent).toContain("editor");
  expect(host.textContent).not.toContain("null");
});

test("accepting joins, records the account as the one in force, and leaves by a document load", async () => {
  acceptInvitation.mockResolvedValue({ ok: true, value: ACCEPTED });
  chooseOrganization.mockResolvedValue({ ok: true, value: { organizationId: ORGANIZATION_ID, chosen: true } });

  await render();
  await click("Join");

  expect(acceptInvitation).toHaveBeenCalledWith(TOKEN);
  // Written, not merely joined: the server leaves the acting selection where it was.
  expect(chooseOrganization).toHaveBeenCalledWith(ORGANIZATION_ID);
  expect(assign).toHaveBeenCalledWith("/");
  // The half that goes red if somebody reaches for `navigate()`.
  expect(pushState).not.toHaveBeenCalled();
});

test("somebody already a member is still put into the account", async () => {
  acceptInvitation.mockResolvedValue({ ok: true, value: { ...ACCEPTED, joined: false } });
  chooseOrganization.mockResolvedValue({ ok: true, value: { organizationId: ORGANIZATION_ID, chosen: true } });

  await render();
  await click("Join");

  expect(chooseOrganization).toHaveBeenCalledWith(ORGANIZATION_ID);
  expect(assign).toHaveBeenCalledWith("/");
});

test("a stranger sees the offer, and is sent to sign in with this page to come back to", async () => {
  getSession.mockResolvedValue(null);

  await render();
  expect(host.querySelector("h1")?.textContent).toContain("Acme Games");

  await click("Sign in");

  expect(acceptInvitation).not.toHaveBeenCalled();
  const resume = new URLSearchParams({ resume: `/invitations/${TOKEN}` });
  expect(pushState).toHaveBeenCalledWith(null, "", `${SIGN_IN_CANARY}?${resume}`);
  expect(assign).not.toHaveBeenCalled();
});

test("a link that can no longer be used says so, and offers nothing to press", async () => {
  readInvitation.mockResolvedValue({ ok: false, failure: INVALID });

  await render();

  expect(host.textContent).toContain("can't be used");
  expect(host.querySelectorAll("button")).toHaveLength(0);
});

test("an invitation spent between reading and accepting says the same thing", async () => {
  acceptInvitation.mockResolvedValue({ ok: false, failure: INVALID });

  await render();
  await click("Join");

  expect(host.textContent).toContain("can't be used");
  expect(chooseOrganization).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
});

test("a read that fails is not mistaken for a dead link, and can be tried again", async () => {
  readInvitation.mockResolvedValueOnce({
    ok: false,
    failure: { code: "client/unreachable", message: "unreachable", action: null },
  });

  await render();
  expect(host.textContent).toContain("couldn't load this invitation");
  expect(host.textContent).not.toContain("can't be used");

  await click("Try again");

  expect(host.querySelector("h1")?.textContent).toContain("Acme Games");
});

test("a join whose choice then fails retries the choice, not the spent invitation", async () => {
  acceptInvitation.mockResolvedValue({ ok: true, value: ACCEPTED });
  chooseOrganization.mockResolvedValueOnce({
    ok: false,
    failure: { code: "client/unreachable", message: "unreachable", action: null },
  });

  await render();
  await click("Join");
  expect(assign).not.toHaveBeenCalled();
  expect(host.textContent).toContain("couldn't");

  chooseOrganization.mockResolvedValue({ ok: true, value: { organizationId: ORGANIZATION_ID, chosen: true } });
  await click("Try again");

  expect(acceptInvitation).toHaveBeenCalledTimes(1);
  expect(chooseOrganization).toHaveBeenCalledTimes(2);
  expect(assign).toHaveBeenCalledWith("/");
});

test("an account suspended since the offer was read goes on to the suspended screen, by role", async () => {
  acceptInvitation.mockResolvedValue({ ok: true, value: ACCEPTED });
  chooseOrganization.mockResolvedValue({
    ok: false,
    failure: {
      code: "organization/organization_suspended",
      message: "This organization is suspended. Your own account is not affected.",
      action: null,
    },
  });

  await render();
  await click("Join");

  expect(pushState).toHaveBeenCalledWith(null, "", SUSPENDED_CANARY);
  // Not a document load: nothing is in force, so there is no previous account's data to shed.
  expect(assign).not.toHaveBeenCalled();
});
