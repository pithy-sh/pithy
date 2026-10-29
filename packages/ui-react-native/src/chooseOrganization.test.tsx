// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Platform, Pressable, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMemoryAdapter, RouterProvider, usePath } from "../templates/src/router";

/**
 * **Choosing an account leaves the way a document load does, and a single membership is entered without asking.**
 *
 * What is in force decides what every later request may reach. A route change that keeps the screens mounted keeps
 * whatever the previous account's data put on them, and shows it to somebody now acting as a different tenant. On a
 * phone there is no document to load, so the router remounts every screen as it goes; the probe below is a screen's
 * state that must not survive the switch. It looks identical in a manual test, because the first account you try is
 * the one whose data is already on screen.
 *
 * Somebody with exactly one account is not choosing, so no picker is drawn, and the choice is still written: an
 * acting selection nobody recorded is resolved again on every request.
 */

const ONLY = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Games",
  slug: "acme",
  mark: null,
  role: "admin",
  createdAt: "2026-09-01T12:00:00.000Z",
};
const OTHER = { ...ONLY, id: "22222222-2222-4222-8222-222222222222", name: "Beta Studio", slug: "beta" };
const SUSPENDED = {
  code: "organization/organization_suspended",
  message: "This organization is suspended. Your own account is not affected.",
  action: null,
};

const ORGANIZATION_OPTIONS = { origin: "https://api.example.com", fetch: async () => ({}) };

const { listOrganizations, chooseOrganization, image } = vi.hoisted(() => ({
  listOrganizations: vi.fn(),
  chooseOrganization: vi.fn(),
  image: vi.fn(),
}));

vi.mock("@pithy-sh/organization/src/client/api", () => ({ listOrganizations, chooseOrganization }));
vi.mock("../templates/src/transport", () => ({ transport: { organization: ORGANIZATION_OPTIONS, image } }));

/** The suspended screen's path, invented here, so a screen that wrote it as a literal goes red. */
const SUSPENDED_CANARY = "/canary-organization-suspended";
vi.mock("../templates/src/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/router")>()),
  routeTable: async () => ({ byRole: new Map([["organization-suspended", SUSPENDED_CANARY]]) }),
}));

const os = Platform.OS;

beforeEach(() => {
  listOrganizations.mockReset();
  chooseOrganization.mockReset();
  image.mockReset();
  image.mockImplementation(async (path: string) => ({ uri: `https://api.example.com${path}` }));
});

afterEach(() => {
  cleanup();
  Platform.OS = os;
  vi.resetModules();
});

/** State a screen held before the choice. A document load drops it; a route change keeps it. */
function Probe() {
  const [count, setCount] = useState(0);
  return (
    <Pressable role="button" onPress={() => setCount((now) => now + 1)}>
      <Text>{`probe ${count}`}</Text>
    </Pressable>
  );
}

/** Render the chooser beside the probe, the probe already moved off its first state. */
async function mount() {
  const { default: ChooseOrganization } = await import("../templates/src/routes/pithy/choose-organization");
  const adapter = createMemoryAdapter("/choose-organization");
  // The router's part: the chooser answers its own path, and anywhere else is some other screen.
  function Screens() {
    const path = usePath();
    return (
      <>
        <Probe />
        {path === "/choose-organization" ? <ChooseOrganization /> : <Text>{`at ${path}`}</Text>}
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
  expect(screen.getByText("probe 1")).toBeTruthy();
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

test("claims its route", async () => {
  const chooser = await import("../templates/src/routes/pithy/choose-organization");
  expect(chooser.path).toBe("/choose-organization");
});

test("a single membership is entered without asking, and the choice is still written", async () => {
  listOrganizations.mockResolvedValue({ ok: true, value: { organizations: [ONLY], acting: null } });
  chooseOrganization.mockResolvedValue({ ok: true, value: { organizationId: ONLY.id, chosen: true } });

  const adapter = await mount();

  expect(listOrganizations).toHaveBeenCalledWith(ORGANIZATION_OPTIONS);
  expect(chooseOrganization).toHaveBeenCalledWith(ONLY.id, ORGANIZATION_OPTIONS);
  expect(adapter.path()).toBe("/");
  expect(screen.queryAllByText("Acme Games")).toHaveLength(0);
});

test("several memberships draw the picker, and choosing one writes it", async () => {
  listOrganizations.mockResolvedValue({ ok: true, value: { organizations: [ONLY, OTHER], acting: null } });
  chooseOrganization.mockResolvedValue({ ok: true, value: { organizationId: OTHER.id, chosen: true } });

  await mount();
  expect(screen.getByRole("heading").textContent).toBe("Choose an account");
  expect(document.body.textContent).toContain("Acme Games");
  expect(document.body.textContent).toContain("You are admin here.");

  await press("Beta Studio");
  expect(chooseOrganization).toHaveBeenCalledWith(OTHER.id, ORGANIZATION_OPTIONS);
});

test("**it leaves the way a document load does: every screen remounts, so nothing the last account put there survives**", async () => {
  listOrganizations.mockResolvedValue({ ok: true, value: { organizations: [ONLY, OTHER], acting: null } });
  chooseOrganization.mockResolvedValue({ ok: true, value: { organizationId: ONLY.id, chosen: true } });

  const adapter = await mount();
  await press("Acme Games");

  expect(adapter.path()).toBe("/");
  // The half that goes red if the screen leaves by an ordinary route change.
  expect(await screen.findByText("probe 0")).toBeTruthy();
});

test("belonging nowhere is its own answer, not an empty picker", async () => {
  listOrganizations.mockResolvedValue({ ok: true, value: { organizations: [], acting: null } });

  const adapter = await mount();

  expect(document.body.textContent).toContain("No accounts yet");
  expect(chooseOrganization).not.toHaveBeenCalled();
  expect(adapter.path()).toBe("/choose-organization");
});

test("somebody whose only accounts are suspended is sent to the suspended screen, by role", async () => {
  listOrganizations.mockResolvedValue({ ok: true, value: { organizations: [], acting: null, suspended: 1 } });

  const adapter = await mount();

  expect(adapter.path()).toBe(SUSPENDED_CANARY);
  expect(document.body.textContent).not.toContain("No accounts yet");
  expect(chooseOrganization).not.toHaveBeenCalled();
  // Nothing is in force, so there is no previous account's data to shed.
  expect(screen.getByText("probe 1")).toBeTruthy();
});

test("a refused choice stays on the screen rather than leaving for an account nobody has", async () => {
  listOrganizations.mockResolvedValue({ ok: true, value: { organizations: [ONLY, OTHER], acting: null } });
  chooseOrganization.mockResolvedValue({
    ok: false,
    failure: { code: "organization/not_found", message: "That organization does not exist.", action: null },
  });

  const adapter = await mount();
  await press("Acme Games");

  expect(adapter.path()).toBe("/choose-organization");
  expect(document.body.textContent).toContain("We couldn't load your accounts.");

  await press("Try again");
  expect(listOrganizations).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("Beta Studio");
});

test("an account suspended since the list was drawn goes on to the suspended screen, by role", async () => {
  listOrganizations.mockResolvedValue({ ok: true, value: { organizations: [ONLY, OTHER], acting: null } });
  chooseOrganization.mockResolvedValue({ ok: false, failure: SUSPENDED });

  const adapter = await mount();
  await press("Acme Games");

  expect(adapter.path()).toBe(SUSPENDED_CANARY);
  expect(screen.getByText("probe 1")).toBeTruthy();
});

test("a list that could not be read says so, and can be tried again", async () => {
  listOrganizations.mockResolvedValueOnce({
    ok: false,
    failure: { code: "client/unreachable", message: "unreachable", action: null },
  });
  listOrganizations.mockResolvedValue({ ok: true, value: { organizations: [ONLY, OTHER], acting: null } });

  await mount();
  expect(document.body.textContent).toContain("We couldn't load your accounts.");

  await press("Try again");
  expect(document.body.textContent).toContain("Acme Games");
});

describe("an organization's mark", () => {
  test("none draws its initial", async () => {
    listOrganizations.mockResolvedValue({ ok: true, value: { organizations: [ONLY, OTHER], acting: null } });
    await mount();
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("B")).toBeTruthy();
  });

  test("a raster on the Worker is drawn from the transport's image, with the credential it carries", async () => {
    const { markSource } = await import("../templates/src/routes/pithy/choose-organization");
    image.mockResolvedValue({
      uri: "https://api.example.com/organizations/marks/organization/o1?v=1",
      headers: { authorization: "Bearer raw-token" },
    });
    expect(await markSource("/organizations/marks/organization/o1?v=1")).toEqual({
      uri: "https://api.example.com/organizations/marks/organization/o1?v=1",
      headers: { authorization: "Bearer raw-token" },
    });
    expect(image).toHaveBeenCalledWith("/organizations/marks/organization/o1?v=1");
  });

  test("a vector is its own value on the web, and its initial on a phone, which cannot draw one", async () => {
    const svg = "data:image/svg+xml;base64,PHN2Zy8+";
    const { markSource } = await import("../templates/src/routes/pithy/choose-organization");
    Platform.OS = "web";
    expect(await markSource(svg)).toEqual({ uri: svg });
    Platform.OS = "ios";
    expect(await markSource(svg)).toBeNull();
    expect(await markSource(null)).toBeNull();
    expect(image).not.toHaveBeenCalled();
  });

  test("a mark the transport will not draw is the initial", async () => {
    listOrganizations.mockResolvedValue({
      ok: true,
      value: { organizations: [{ ...ONLY, mark: "/organizations/marks/organization/o1" }, OTHER], acting: null },
    });
    image.mockResolvedValue(null);
    await mount();
    expect(screen.getByText("A")).toBeTruthy();
  });

  test("a mark that is drawn is an image, not the initial", async () => {
    listOrganizations.mockResolvedValue({
      ok: true,
      value: { organizations: [{ ...ONLY, mark: "/organizations/marks/organization/o1" }, OTHER], acting: null },
    });
    await mount();
    expect(image).toHaveBeenCalledWith("/organizations/marks/organization/o1");
    expect(screen.queryByText("A")).toBeNull();
    expect(screen.getByText("B")).toBeTruthy();
  });
});
