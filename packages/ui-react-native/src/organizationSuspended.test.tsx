// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { createMemoryAdapter, RouterProvider } from "../templates/src/router";

afterEach(cleanup);

test("claims its route and its role, so a refusal anywhere can send somebody here", async () => {
  const suspended = await import("../templates/src/routes/pithy/organization-suspended");
  expect(suspended.path).toBe("/organization-suspended");
  expect(suspended.role).toBe("organization-suspended");
});

test("says the organization is suspended, that their own account is not, who to ask, and goes home", async () => {
  const { default: OrganizationSuspended } = await import("../templates/src/routes/pithy/organization-suspended");
  const adapter = createMemoryAdapter("/organization-suspended");
  render(
    <RouterProvider adapter={adapter}>
      <OrganizationSuspended />
    </RouterProvider>,
  );
  expect(screen.getByRole("heading").textContent).toBe("This organization is suspended.");
  expect(document.body.textContent).toContain("Your own account is not affected.");
  expect(document.body.textContent).toContain("Ask one of them.");
  fireEvent.click(screen.getByRole("link"));
  expect(adapter.path()).toBe("/");
});
