// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "../capability/capability";
import { createBackend } from "../createBackend";
import { phi, pii } from "../privacy/classes";
import {
  composedRetention,
  effectiveRetention,
  forgetRetention,
  retentionComposition,
  subjectClasses,
} from "./composed";

/** A capability that owns a user deletion, the way auth does: its window, and the actions its purge records. */
const owner = defineCapability({
  name: "owner",
  requiredBindings: [],
  purgeWindow: { subject: "user", days: 30 },
  lifecycleAuditActions: ["owner/user_suspended", "owner/user_reinstated", "owner/user_restored"],
  erasureRecords: {
    subject: "user",
    resourceType: "user",
    auditActions: {
      deleted: ["owner/user_deleted"],
      step: "owner/purge_step",
      failed: "owner/purge_failed",
      purged: "owner/purged",
    },
    read: () => ({ history: async () => [], subjectsIn: async () => [] }),
  },
});

afterEach(() => forgetRetention());

describe("retentionComposition", () => {
  test("reads each capability's window and every lifecycle action its purge records", () => {
    expect(retentionComposition([owner])).toEqual({
      purgeWindows: [{ subject: "user", days: 30 }],
      lifecycleActions: [
        "owner/user_suspended",
        "owner/user_reinstated",
        "owner/user_restored",
        "owner/user_deleted",
        "owner/purge_step",
        "owner/purge_failed",
        "owner/purged",
      ],
    });
  });
});

describe("effectiveRetention", () => {
  test("refuses a rule under the floor for a composed lifecycle action", () => {
    expect(() => effectiveRetention({ audit: { prefixes: { "owner/": "30d" } } }, [owner])).toThrow(
      /floor of 365 for owner\//,
    );
  });

  test("refuses a short prefix that covers only a restore or a reinstatement", () => {
    expect(() => effectiveRetention({ audit: { prefixes: { "owner/user_re": "30d" } } }, [owner])).toThrow(
      /owner\/user_reinstated|owner\/user_restored/,
    );
  });

  test("holds a suspension, a reinstatement and a restore at the floor under a short default", () => {
    const retention = effectiveRetention({ audit: { default: "30d" } }, [owner]);
    for (const action of ["owner/user_suspended", "owner/user_reinstated", "owner/user_restored"]) {
      expect(retention.audit.rules).toContainEqual({ prefix: action, days: 365, source: "floor" });
    }
  });
});

describe("createBackend", () => {
  test("records the block as it takes effect, so a Workflow reads the policy the routes report", () => {
    createBackend({ capabilities: [owner], retention: { purgeWindows: { user: "60d" } } });
    expect(composedRetention()?.purgeWindows).toEqual([{ subject: "user", days: 60, source: "policy" }]);
  });

  test("refuses at assembly a block that keeps controlplane/* under the floor", () => {
    expect(() =>
      createBackend({ capabilities: [owner], retention: { audit: { prefixes: { "controlplane/": "90d" } } } }),
    ).toThrow(/floor/);
  });

  test("records the empty policy when the config names none", () => {
    createBackend({ capabilities: [owner] });
    expect(composedRetention()?.purgeWindows).toEqual([{ subject: "user", days: 30, source: "capability" }]);
    expect(composedRetention()?.audit.defaultDays).toBeNull();
  });
});

describe("subjectClasses", () => {
  test("reads the classes marked on the schemas of capabilities that purge the subject, and no others", () => {
    const holder = defineCapability({
      name: "holder",
      requiredBindings: [],
      purge: [{ subject: "user", summary: "Deletes the profile.", erase: async () => {} }],
      databases: {
        app: {
          binding: "DB",
          tables: {
            pithyHolderProfiles: z
              .object({ id: z.string().describe("Id."), email: pii(z.string()).describe("The address.") })
              .describe("A profile."),
          },
        },
      },
    });
    const bystander = defineCapability({
      name: "bystander",
      requiredBindings: [],
      databases: {
        app: {
          binding: "DB",
          tables: {
            pithyBystanderNotes: z
              .object({ id: z.string().describe("Id."), note: phi(z.string()).describe("A note.") })
              .describe("A note."),
          },
        },
      },
    });
    expect(subjectClasses([holder, bystander], "user")).toEqual(["pii"]);
    expect(subjectClasses([holder, bystander], "organization")).toEqual([]);
  });
});
