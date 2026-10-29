// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Revoking is the only narrowing a person has, so this screen lists every application acting as them — by the name
 * it gave itself and by where its access goes — and revokes one with a press.
 */

const ORIGIN = "http://localhost:8787";
const NAME_CANARY = "Canary Official Sync";
const REDIRECT_CANARY = "http://127.0.0.1:4317/canary-callback";

const { listConnectedApplications, revokeConnectedApplication } = vi.hoisted(() => ({
  listConnectedApplications: vi.fn(),
  revokeConnectedApplication: vi.fn(),
}));

vi.mock("@pithy-sh/auth/src/client/mcp", () => ({ listConnectedApplications, revokeConnectedApplication }));

const APPLICATIONS = [
  {
    clientId: "c1",
    reportedName: NAME_CANARY,
    redirectUris: [REDIRECT_CANARY],
    approvedAt: "2026-10-27T12:00:00.000Z",
  },
  {
    clientId: "c2",
    reportedName: null,
    redirectUris: ["https://b.example/cb"],
    approvedAt: "2026-10-26T12:00:00.000Z",
  },
];

const os = Platform.OS;

beforeEach(() => {
  listConnectedApplications.mockReset();
  revokeConnectedApplication.mockReset();
  listConnectedApplications.mockResolvedValue({ ok: true, value: APPLICATIONS });
});

afterEach(() => {
  cleanup();
  Platform.OS = os;
  vi.resetModules();
});

async function rendered(platform: "ios" | "web" = "web") {
  Platform.OS = platform;
  const { default: ConnectedApplications, path } = await import("../templates/src/routes/pithy/connected-applications");
  expect(path).toBe("/connected-applications");
  return render(<ConnectedApplications />);
}

describe("the connected applications screen", () => {
  test("lists each application by its reported name and where its access goes", async () => {
    const view = await rendered();
    await screen.findByText(NAME_CANARY);
    expect(screen.getByRole("heading").textContent).toBe("Applications acting as you");
    expect(screen.getByText("An application with no name")).toBeTruthy();
    expect(view.container.textContent).toContain(`Access goes to ${REDIRECT_CANARY}.`);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(2);
    expect(listConnectedApplications).toHaveBeenCalledWith({ basePath: "/mcp" });
  });

  test("says so when nothing is acting as you", async () => {
    listConnectedApplications.mockResolvedValue({ ok: true, value: [] });
    await rendered();
    await screen.findByText("None. Nothing is acting as you.");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  test("revoking one asks the Worker, then reads the list again", async () => {
    revokeConnectedApplication.mockResolvedValue({ ok: true, value: { revoked: true } });
    await rendered();
    const [first] = await screen.findAllByRole("button", { name: "Revoke" });
    listConnectedApplications.mockResolvedValue({ ok: true, value: APPLICATIONS.slice(1) });
    if (first) fireEvent.click(first);
    await waitFor(() => expect(screen.queryByText(NAME_CANARY)).toBeNull());
    expect(revokeConnectedApplication).toHaveBeenCalledWith("c1", { basePath: "/mcp" });
    expect(listConnectedApplications).toHaveBeenCalledTimes(2);
  });

  test("a refused revoke says so, and trying again reads the list afresh", async () => {
    revokeConnectedApplication.mockResolvedValue({ ok: false, failure: { code: "auth/forbidden", message: "No." } });
    await rendered();
    const [first] = await screen.findAllByRole("button", { name: "Revoke" });
    if (first) fireEvent.click(first);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByText(NAME_CANARY);
    expect(screen.getByText("Applications acting as you")).toBeTruthy();
    expect(listConnectedApplications).toHaveBeenCalledTimes(2);
  });

  test("a list that cannot be read offers to try again", async () => {
    listConnectedApplications.mockResolvedValue({ ok: false, failure: { code: "http/500", message: "No." } });
    await rendered();
    await screen.findByText("We couldn't load your applications.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  test("on a phone, the list is read from the Worker's origin with the bearer session's fetch", async () => {
    await rendered("ios");
    await screen.findByText(NAME_CANARY);
    const options = listConnectedApplications.mock.calls[0]?.[0];
    expect(options).toMatchObject({ origin: ORIGIN, basePath: "/mcp" });
    expect(typeof options?.fetch).toBe("function");
  });
});
