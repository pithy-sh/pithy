// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { emailSenderBinding } from "./senderBinding";

describe("emailSenderBinding", () => {
  test("hands back the bound Workflow in every deployed environment", () => {
    const sender = { create: async () => ({}) };
    expect(emailSenderBinding({ EMAIL_SENDER: sender })).toBe(sender);
    expect(emailSenderBinding({ EMAIL_SENDER: sender, ENVIRONMENT: "prod" })).toBe(sender);
  });

  test("stands a loopback dispatcher in for the absent binding under pithy dev", () => {
    // The whole of pithy-sh/pithy#410 on this side: locally there is no `<project>-dev-email` script to
    // bind, so the seam was empty and every immediate send was born undispatched. `pithy dev` writes
    // `EMAIL_ORIGIN` into the app Worker's vars, and that is the address this stands in with.
    const resolved = emailSenderBinding({ ENVIRONMENT: "dev", EMAIL_ORIGIN: "http://localhost:8797" });
    expect(typeof resolved?.create).toBe("function");
  });

  test("stands nothing in outside dev, so a deployed miswiring stays the loud failure it is", () => {
    expect(emailSenderBinding({ ENVIRONMENT: "prod", EMAIL_ORIGIN: "http://localhost:8797" })).toBeUndefined();
    expect(emailSenderBinding({ EMAIL_ORIGIN: "http://localhost:8797" })).toBeUndefined();
  });

  test("stands nothing in when no email host published an address", () => {
    expect(emailSenderBinding({ ENVIRONMENT: "dev" })).toBeUndefined();
  });

  test("takes the local host over the binding in dev — a cross-script binding reaches nothing there", () => {
    const sender = { create: async () => ({}) };
    const resolved = emailSenderBinding({
      EMAIL_SENDER: sender,
      ENVIRONMENT: "dev",
      EMAIL_ORIGIN: "http://localhost:8797",
    });
    expect(resolved).not.toBe(sender);
    expect(typeof resolved?.create).toBe("function");
  });
});
