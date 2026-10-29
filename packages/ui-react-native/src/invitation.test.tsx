// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Pressable, Text } from "react-native";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMemoryAdapter, RouterProvider, usePath } from "../templates/src/router";

/**
 * **Accepting an invitation puts you in the account you joined, and leaves the way a document load does.**
 *
 * Joining does not move the account in force. The server writes the membership and stops there, so a screen that
 * accepts and goes home lands somebody back in whatever account they were acting in before, with no sign that the
 * one they just joined exists. The screen records the choice itself, and these tests assert the write happened.
 *
 * Leaving remounts every screen for the chooser's reason: what is in force decides what every request may reach, and
 * a plain route change keeps whatever the previous account's data had already populated. The probe below is that
 * state.
 *
 * The third behavior is the one nobody already signed in can see: a stranger holding the link is shown the offer, and
 * sent to sign in with this screen as the place to come back to.
 */

const TOKEN = "tok_canary-invitation";
const OWN_PATH = `/invitations/${TOKEN}`;
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
const UNREACHABLE = { code: "client/unreachable", message: "unreachable", action: null };
const CHOSEN = { ok: true, value: { organizationId: ORGANIZATION_ID, chosen: true } };

const ORGANIZATION_OPTIONS = { origin: "https://api.example.com", fetch: async () => ({}) };

const { readInvitation, acceptInvitation, chooseOrganization, getSession } = vi.hoisted(() => ({
  readInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  chooseOrganization: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@pithy-sh/organization/src/client/api", () => ({ readInvitation, acceptInvitation, chooseOrganization }));
vi.mock("../templates/src/transport", () => ({ transport: { organization: ORGANIZATION_OPTIONS } }));
vi.mock("../templates/src/session", () => ({ getSession, RESUME_PARAM: "resume" }));

/** Destinations invented here, so a screen that wrote the sign-in or suspended screen's path as a literal goes red. */
const SIGN_IN_CANARY = "/canary-sign-in";
const SUSPENDED_CANARY = "/canary-organization-suspended";
vi.mock("../templates/src/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/router")>()),
  routeTable: async () => ({
    byRole: new Map([
      ["sign-in", SIGN_IN_CANARY],
      ["organization-suspended", SUSPENDED_CANARY],
    ]),
  }),
}));

beforeEach(() => {
  readInvitation.mockReset();
  acceptInvitation.mockReset();
  chooseOrganization.mockReset();
  getSession.mockReset();
  readInvitation.mockResolvedValue({ ok: true, value: OFFER });
  getSession.mockResolvedValue({ user: { id: "u1", email: "ada@example.com" } });
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

/** State a screen held before the join. A document load drops it; a route change keeps it. */
function Probe() {
  const [count, setCount] = useState(0);
  return (
    <Pressable role="button" onPress={() => setCount((now) => now + 1)}>
      <Text>{`probe ${count}`}</Text>
    </Pressable>
  );
}

/** Render the screen for `TOKEN` beside the probe, the probe already moved off its first state. */
async function mount() {
  const invitation = await import("../templates/src/routes/pithy/invitation");
  const Invitation = invitation.default;
  const adapter = createMemoryAdapter(OWN_PATH);
  function Screens() {
    const path = usePath();
    return (
      <>
        <Probe />
        {path === OWN_PATH ? <Invitation params={{ token: TOKEN }} /> : <Text>{`at ${path}`}</Text>}
      </>
    );
  }
  await act(async () => {
    render(
      <RouterProvider adapter={adapter}>
        <Screens />
      </RouterProvider>,
    );
  });
  fireEvent.click(screen.getByText("probe 0"));
  return adapter;
}

/** Press the one button whose text contains `label`. */
async function press(label: string): Promise<void> {
  const button = screen.getAllByRole("button").find((each) => each.textContent?.includes(label));
  expect(button, `no button reads "${label}"`).toBeDefined();
  await act(async () => {
    if (button) fireEvent.click(button);
  });
}

/** The buttons the screen drew, the probe's left out. */
function screenButtons(): HTMLElement[] {
  return screen.getAllByRole("button").filter((each) => !each.textContent?.startsWith("probe"));
}

test("claims the path every invitation link lands on", async () => {
  const invitation = await import("../templates/src/routes/pithy/invitation");
  expect(invitation.path).toBe("/invitations/:token");
});

test("the offer says who is asking, to what, as what, and until when", async () => {
  await mount();

  expect(readInvitation).toHaveBeenCalledWith(TOKEN, ORGANIZATION_OPTIONS);
  expect(screen.getByRole("heading").textContent).toContain("Acme Games");
  expect(document.body.textContent).toContain("Ada Lovelace invited you as editor.");
  expect(document.body.textContent).toContain("November 4, 2026");
  expect(document.body.textContent).toContain("ada@example.com");
});

test("an inviter whose account is gone is left out rather than named as nobody", async () => {
  readInvitation.mockResolvedValue({ ok: true, value: { ...OFFER, inviterName: null } });

  await mount();

  expect(document.body.textContent).toContain("You're invited as editor.");
  expect(document.body.textContent).not.toContain("null");
});

test("accepting joins, records the account as the one in force, and leaves remounting every screen", async () => {
  acceptInvitation.mockResolvedValue({ ok: true, value: ACCEPTED });
  chooseOrganization.mockResolvedValue(CHOSEN);

  const adapter = await mount();
  await press("Join");

  expect(acceptInvitation).toHaveBeenCalledWith(TOKEN, ORGANIZATION_OPTIONS);
  // Written, not merely joined: the server leaves the acting selection where it was.
  expect(chooseOrganization).toHaveBeenCalledWith(ORGANIZATION_ID, ORGANIZATION_OPTIONS);
  expect(adapter.path()).toBe("/");
  // The half that goes red if the screen leaves by an ordinary route change.
  expect(await screen.findByText("probe 0")).toBeTruthy();
});

test("somebody already a member is still put into the account", async () => {
  acceptInvitation.mockResolvedValue({ ok: true, value: { ...ACCEPTED, joined: false } });
  chooseOrganization.mockResolvedValue(CHOSEN);

  const adapter = await mount();
  await press("Join");

  expect(chooseOrganization).toHaveBeenCalledWith(ORGANIZATION_ID, ORGANIZATION_OPTIONS);
  expect(adapter.path()).toBe("/");
});

test("a stranger sees the offer, and is sent to sign in with this screen to come back to", async () => {
  getSession.mockResolvedValue(null);

  const adapter = await mount();
  expect(screen.getByRole("heading").textContent).toContain("Acme Games");

  await press("Sign in");

  expect(acceptInvitation).not.toHaveBeenCalled();
  expect(adapter.path()).toBe(`${SIGN_IN_CANARY}?resume=${encodeURIComponent(OWN_PATH)}`);
  expect(screen.getByText("probe 1")).toBeTruthy();
});

test("a link that can no longer be used says so, and offers nothing to press", async () => {
  readInvitation.mockResolvedValue({ ok: false, failure: INVALID });

  await mount();

  expect(document.body.textContent).toContain("This invitation can't be used.");
  expect(screenButtons()).toHaveLength(0);
});

test("an invitation spent between reading and accepting says the same thing", async () => {
  acceptInvitation.mockResolvedValue({ ok: false, failure: INVALID });

  const adapter = await mount();
  await press("Join");

  expect(document.body.textContent).toContain("can't be used");
  expect(chooseOrganization).not.toHaveBeenCalled();
  expect(adapter.path()).toBe(OWN_PATH);
});

test("a read that fails is not mistaken for a dead link, and can be tried again", async () => {
  readInvitation.mockResolvedValueOnce({ ok: false, failure: UNREACHABLE });

  await mount();
  expect(document.body.textContent).toContain("We couldn't load this invitation.");
  expect(document.body.textContent).not.toContain("can't be used");

  await press("Try again");

  expect(screen.getByRole("heading").textContent).toContain("Acme Games");
});

test("a join whose choice then fails retries the choice, not the spent invitation", async () => {
  acceptInvitation.mockResolvedValue({ ok: true, value: ACCEPTED });
  chooseOrganization.mockResolvedValueOnce({ ok: false, failure: UNREACHABLE });

  const adapter = await mount();
  await press("Join");
  expect(adapter.path()).toBe(OWN_PATH);
  expect(document.body.textContent).toContain("We couldn't finish joining.");

  chooseOrganization.mockResolvedValue(CHOSEN);
  await press("Try again");

  expect(acceptInvitation).toHaveBeenCalledTimes(1);
  expect(chooseOrganization).toHaveBeenCalledTimes(2);
  expect(adapter.path()).toBe("/");
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

  const adapter = await mount();
  await press("Join");

  expect(adapter.path()).toBe(SUSPENDED_CANARY);
  // Nothing is in force, so there is no previous account's data to shed.
  expect(screen.getByText("probe 1")).toBeTruthy();
});
