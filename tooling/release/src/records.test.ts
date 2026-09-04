// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { SnapshotEntry } from "./changesets";
import { joinRecords, ReleaseRecord } from "./records";

const PUBLISHED = new Date("2026-08-14T09:12:00.000Z");

function changeset(entry: Partial<SnapshotEntry> & Pick<SnapshotEntry, "bumps">): SnapshotEntry {
  return { id: "x", note: "A note.", security: false, exposure: null, ...entry };
}

function join(options: { snapshot?: SnapshotEntry[]; before?: Record<string, string>; after: Record<string, string> }) {
  return joinRecords({
    snapshot: options.snapshot ?? [],
    before: new Map(Object.entries(options.before ?? {})),
    after: new Map(Object.entries(options.after)),
    published: PUBLISHED,
  });
}

describe("joinRecords", () => {
  it("writes one record per package that was released", () => {
    const records = join({
      snapshot: [changeset({ bumps: [{ name: "@pithy-sh/auth", bump: "patch" }], note: "A fix." })],
      before: { "@pithy-sh/auth": "1.4.1" },
      after: { "@pithy-sh/auth": "1.4.2" },
    });

    expect(records).toEqual([
      {
        package: "@pithy-sh/auth",
        version: "1.4.2",
        major: 1,
        minor: 4,
        patch: 2,
        prerelease: null,
        bump: "patch",
        published: "2026-08-14T09:12:00.000Z",
        note: "A fix.",
        security: false,
        exposure: null,
      },
    ]);
  });

  it("carries the security flag and the exposure through", () => {
    const [record] = join({
      snapshot: [
        changeset({
          bumps: [{ name: "@pithy-sh/auth", bump: "patch" }],
          note: "Refresh-token reuse now revokes the whole family.",
          security: true,
          exposure: "A revoked refresh token stayed valid until its natural expiry.",
        }),
      ],
      before: { "@pithy-sh/auth": "1.4.1" },
      after: { "@pithy-sh/auth": "1.4.2" },
    });

    expect(record?.security).toBe(true);
    expect(record?.exposure).toBe("A revoked refresh token stayed valid until its natural expiry.");
  });

  it("leaves an unflagged release carrying no flag and no exposure", () => {
    const [record] = join({
      snapshot: [changeset({ bumps: [{ name: "@pithy-sh/auth", bump: "patch" }] })],
      before: { "@pithy-sh/auth": "1.4.1" },
      after: { "@pithy-sh/auth": "1.4.2" },
    });

    expect(record?.security).toBe(false);
    expect(record?.exposure).toBeNull();
  });

  // The version that was published is the truth. A `fixed` group promotes a package's patch to the
  // group's minor, so the declared bump and what actually shipped genuinely disagree — and only one of
  // them is what an adopter's lockfile will hold.
  it("derives the bump from the versions rather than from what the changeset asked for", () => {
    const [record] = join({
      snapshot: [changeset({ bumps: [{ name: "@pithy-sh/core", bump: "patch" }] })],
      before: { "@pithy-sh/core": "1.4.1" },
      after: { "@pithy-sh/core": "1.5.0" },
    });

    expect(record?.bump).toBe("minor");
  });

  it("derives every bump level from the version delta", () => {
    const records = join({
      before: { "@pithy-sh/a": "1.4.1", "@pithy-sh/b": "1.4.1", "@pithy-sh/c": "1.4.1" },
      after: { "@pithy-sh/a": "2.0.0", "@pithy-sh/b": "1.5.0", "@pithy-sh/c": "1.4.2" },
    });

    expect(records.map((record) => record.bump)).toEqual(["major", "minor", "patch"]);
  });

  // A package that only moved because something it depends on moved still has a version an adopter
  // can be behind. Dropping it would under-report the gap, which is the failure this whole record
  // exists to prevent.
  it("records a package bumped only by its dependencies, with no note of its own", () => {
    const [record] = join({
      snapshot: [changeset({ bumps: [{ name: "@pithy-sh/core", bump: "minor" }] })],
      before: { "@pithy-sh/core": "1.4.1", "@pithy-sh/cli": "1.4.1" },
      after: { "@pithy-sh/core": "1.5.0", "@pithy-sh/cli": "1.4.2" },
    });

    expect(record?.package).toBe("@pithy-sh/cli");
    expect(record?.note).toBeNull();
    expect(record?.security).toBe(false);
  });

  it("skips a package whose version did not move", () => {
    const records = join({
      before: { "@pithy-sh/auth": "1.4.1", "@pithy-sh/core": "1.4.1" },
      after: { "@pithy-sh/auth": "1.4.2", "@pithy-sh/core": "1.4.1" },
    });

    expect(records.map((record) => record.package)).toEqual(["@pithy-sh/auth"]);
  });

  it("records a package's first ever publish", () => {
    const records = join({
      snapshot: [changeset({ bumps: [{ name: "@pithy-sh/auth", bump: "minor" }] })],
      after: { "@pithy-sh/auth": "0.1.0" },
    });

    expect(records[0]?.version).toBe("0.1.0");
    expect(records[0]?.bump).toBe("minor");
  });

  it("gathers every changeset that named the package into one record", () => {
    const [record] = join({
      snapshot: [
        changeset({ id: "a", bumps: [{ name: "@pithy-sh/auth", bump: "patch" }], note: "First fix." }),
        changeset({ id: "b", bumps: [{ name: "@pithy-sh/auth", bump: "patch" }], note: "Second fix." }),
      ],
      before: { "@pithy-sh/auth": "1.4.1" },
      after: { "@pithy-sh/auth": "1.4.2" },
    });

    expect(record?.note).toBe("First fix.\n\nSecond fix.");
  });

  it("flags the whole release when any one of its changesets was flagged", () => {
    const [record] = join({
      snapshot: [
        changeset({ id: "a", bumps: [{ name: "@pithy-sh/auth", bump: "patch" }], note: "A typo." }),
        changeset({
          id: "b",
          bumps: [{ name: "@pithy-sh/auth", bump: "patch" }],
          note: "A hole.",
          security: true,
          exposure: "The exposure.",
        }),
      ],
      before: { "@pithy-sh/auth": "1.4.1" },
      after: { "@pithy-sh/auth": "1.4.2" },
    });

    expect(record?.security).toBe(true);
    expect(record?.exposure).toBe("The exposure.");
  });

  it("keeps every exposure when more than one changeset was flagged", () => {
    const [record] = join({
      snapshot: [
        changeset({
          id: "a",
          bumps: [{ name: "@pithy-sh/auth", bump: "patch" }],
          security: true,
          exposure: "The first exposure.",
        }),
        changeset({
          id: "b",
          bumps: [{ name: "@pithy-sh/auth", bump: "patch" }],
          security: true,
          exposure: "The second exposure.",
        }),
      ],
      after: { "@pithy-sh/auth": "1.4.2" },
    });

    expect(record?.exposure).toBe("The first exposure.\n\nThe second exposure.");
  });

  it("orders records by package name, so two runs of one release compare equal", () => {
    const records = join({
      after: { "@pithy-sh/vite": "0.1.0", "@pithy-sh/auth": "0.1.0", "@pithy-sh/core": "0.1.0" },
    });

    expect(records.map((record) => record.package)).toEqual(["@pithy-sh/auth", "@pithy-sh/core", "@pithy-sh/vite"]);
  });

  // The one invariant #92 asks for by name: the split can never drift from what was published.
  it("splits every version into components that rebuild the published string", () => {
    const records = join({
      after: { "@pithy-sh/a": "0.1.0", "@pithy-sh/b": "10.20.30", "@pithy-sh/c": "2.0.0-beta.3" },
    });

    for (const record of records) {
      const rebuilt = `${record.major}.${record.minor}.${record.patch}${
        record.prerelease === null ? "" : `-${record.prerelease}`
      }`;
      expect(rebuilt).toBe(record.version);
    }
  });

  it("produces records that satisfy the wire contract", () => {
    const records = join({
      snapshot: [
        changeset({ bumps: [{ name: "@pithy-sh/auth", bump: "patch" }], security: true, exposure: "The exposure." }),
      ],
      after: { "@pithy-sh/auth": "1.4.2" },
    });

    expect(() => ReleaseRecord.array().parse(records)).not.toThrow();
  });

  it("refuses a version the registry could not have published", () => {
    expect(() => join({ after: { "@pithy-sh/auth": "not-a-version" } })).toThrow(/@pithy-sh\/auth/);
  });

  it("is empty when nothing was released", () => {
    expect(join({ before: { "@pithy-sh/auth": "1.4.1" }, after: { "@pithy-sh/auth": "1.4.1" } })).toEqual([]);
  });
});

describe("ReleaseRecord", () => {
  it("refuses a record whose components contradict its version", () => {
    // Not a shape the join can produce — this holds the schema itself to the contract, so a future
    // producer cannot introduce the drift the columns exist to prevent.
    const drifted = {
      package: "@pithy-sh/auth",
      version: "1.4.2",
      major: 1,
      minor: 4,
      patch: 3,
      prerelease: null,
      bump: "patch",
      published: "2026-08-14T09:12:00.000Z",
      note: "A fix.",
      security: false,
      exposure: null,
    };

    expect(() => ReleaseRecord.parse(drifted)).toThrow();
  });

  it("refuses an exposure on a record that is not flagged", () => {
    expect(() =>
      ReleaseRecord.parse({
        package: "@pithy-sh/auth",
        version: "1.4.2",
        major: 1,
        minor: 4,
        patch: 2,
        prerelease: null,
        bump: "patch",
        published: "2026-08-14T09:12:00.000Z",
        note: "A fix.",
        security: false,
        exposure: "An exposure nobody flagged.",
      }),
    ).toThrow();
  });

  it("refuses a published date that is not ISO-8601", () => {
    expect(() =>
      ReleaseRecord.parse({
        package: "@pithy-sh/auth",
        version: "1.4.2",
        major: 1,
        minor: 4,
        patch: 2,
        prerelease: null,
        bump: "patch",
        published: "14 August 2026",
        note: "A fix.",
        security: false,
        exposure: null,
      }),
    ).toThrow();
  });
});
