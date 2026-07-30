// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { AuditAction, type AuditEventInput } from "../../audit/auditEvent";
import type { AuditEmit } from "../../audit/recorder";
import type { Logger } from "../../logger/logger";
import { ControlPlaneAuditActions, safeEmit } from "./actions";

/** A minimal spy logger — enough to prove a swallowed failure is still recorded somewhere. */
function spyLogger(): { log: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn,
    error: () => {},
    child: () => log,
  };
  return { log, warn };
}

const event: AuditEventInput = {
  action: ControlPlaneAuditActions.callAllowed,
  outcome: "success",
  actorType: "control-plane",
};

describe("ControlPlaneAuditActions", () => {
  test("every action code is a valid core AuditAction in the controlplane domain", () => {
    for (const code of Object.values(ControlPlaneAuditActions)) {
      expect(AuditAction.parse(code)).toBe(code);
      expect(code.startsWith("controlplane/")).toBe(true);
    }
  });

  // The hyphen is why the domain is one word. `control-plane/call_allowed` would fail the pattern,
  // and the failure would land in whichever capability emitted it rather than here.
  test("no action code carries a hyphen", () => {
    for (const code of Object.values(ControlPlaneAuditActions)) {
      expect(code).not.toContain("-");
    }
  });

  test("the codes are the ones the seam's routes and gate emit", () => {
    expect(Object.values(ControlPlaneAuditActions)).toEqual([
      "controlplane/call_allowed",
      "controlplane/call_denied",
      "controlplane/key_registered",
      "controlplane/key_expired",
      "controlplane/connection_registered",
      "controlplane/connection_updated",
      "controlplane/connection_removed",
    ]);
  });
});

describe("safeEmit", () => {
  test("forwards the event to the recorder unchanged", async () => {
    const emit = vi.fn<AuditEmit>(async () => {});
    await safeEmit(emit, event);
    expect(emit).toHaveBeenCalledExactlyOnceWith(event);
  });

  test("resolves when the recorder rejects", async () => {
    const emit: AuditEmit = async () => {
      throw new Error("D1 write failed");
    };
    await expect(safeEmit(emit, event)).resolves.toBeUndefined();
  });

  test("resolves when the recorder throws synchronously", async () => {
    const emit = (() => {
      throw new Error("no binding");
    }) as unknown as AuditEmit;
    await expect(safeEmit(emit, event)).resolves.toBeUndefined();
  });

  test("records the swallowed failure on the logger when one is given", async () => {
    const { log, warn } = spyLogger();
    const emit: AuditEmit = async () => {
      throw new Error("D1 write failed");
    };
    await safeEmit(emit, event, log);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ action: event.action });
  });

  test("stays silent on the logger when the emit succeeds", async () => {
    const { log, warn } = spyLogger();
    await safeEmit(async () => {}, event, log);
    expect(warn).not.toHaveBeenCalled();
  });
});
