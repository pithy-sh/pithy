// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PaymentsVerificationFailedError } from "../error/errors";
import { PAYMENTS_PAUSE_RESUMPTION, pauseResumesAt } from "./pause";
import { PaymentsRail } from "./rail";
import { PurchaseStatus } from "./status";

/**
 * The three facts a pause can be in, and the gates that keep them apart.
 *
 * Every date here is a literal an author typed and a provider could have sent. None is derived from the
 * code under test, from a duration, or from another field of the same fixture — which is the property the
 * whole issue turns on: the resume date is the provider's or it does not exist.
 */

/** A resume date no arithmetic in this package could arrive at. Nothing else in the file computes one. */
const RESUME_AT = "2026-10-01T00:00:00Z";

describe("pauseResumesAt", () => {
  test("a paused subscription carries the provider's own instant, unchanged", () => {
    expect(pauseResumesAt({ rail: "google", status: "paused", reported: RESUME_AT })).toEqual(
      new Date("2026-10-01T00:00:00.000Z"),
    );
  });

  test("a paused subscription the provider dated with nothing is paused indefinitely", () => {
    // The state Play has when a user pauses without an auto-resume, and Paddle has when `scheduled_change`
    // is null. Null here means "the provider said none", which is a different sentence from "not paused".
    for (const reported of [null, undefined, ""]) {
      expect(pauseResumesAt({ rail: "google", status: "paused", reported })).toBeNull();
    }
  });

  test("no status but `paused` may carry one, whatever the provider reported", () => {
    // The fallback available when #369 was filed was a period end, and a period end is not a resumption.
    // A live subscription's next date is its renewal; a canceled one's is when access stops. Neither is
    // this field, and the rule is enforced here rather than trusted at eight call sites.
    for (const status of PurchaseStatus.options.filter((option) => option !== "paused")) {
      expect(pauseResumesAt({ rail: "paddle", status, reported: RESUME_AT }), status).toBeNull();
    }
  });

  test("an unreadable date is refused rather than stored as an Invalid Date", () => {
    // `SQLiteDate` encodes an Invalid Date as NaN, which no read can tell from an instant. The delivery is
    // recorded and repairable; a NaN in the column is neither.
    expect(() => pauseResumesAt({ rail: "lemonSqueezy", status: "paused", reported: "next spring" })).toThrow(
      PaymentsVerificationFailedError,
    );
  });

  test("the refusal names the rail and the value for an operator, and neither reaches a client", () => {
    try {
      pauseResumesAt({ rail: "paddle", status: "paused", reported: "soon" });
      expect.unreachable("an unreadable resume date must be refused");
    } catch (error) {
      const payload = (error as PaymentsVerificationFailedError).payload;
      expect(payload.detail).toContain("paddle");
      expect(payload.detail).toContain("soon");
      // The public half says nothing about a provider's field. The HTTP codec strips `detail`, and this is
      // the boundary that makes the operator's context safe to write.
      expect(payload.message).not.toContain("soon");
    }
  });
});

describe("PAYMENTS_PAUSE_RESUMPTION", () => {
  test("covers every rail, so a sixth cannot arrive without an answer", () => {
    // The structural half is `satisfies Record<PaymentsRail, …>`, which is a compile error. This is the
    // half that fails in CI with the rail named, and it is what makes a null on a paused row readable:
    // every rail either reads a field or states why there is none.
    expect(Object.keys(PAYMENTS_PAUSE_RESUMPTION).sort()).toEqual([...PaymentsRail.options].sort());
  });

  test("every entry says something — a field to read, or a reason there is none", () => {
    for (const [rail, source] of Object.entries(PAYMENTS_PAUSE_RESUMPTION)) {
      if ("field" in source) expect(source.field.length, rail).toBeGreaterThan(0);
      else expect(source.none.length, rail).toBeGreaterThan(20);
    }
  });

  test("the rails that map a paused status are the rails that read a field, with Stripe stated", () => {
    // Anti-vacuity: the table is only worth anything if it matches what the rails actually do. Apple and
    // Stripe are the two `{ none }` entries — Apple because StoreKit has no paused state at all, Stripe
    // because its `paused` is a trial without a payment method and carries no date. Every rail that can
    // report a dated pause reads the field it declares.
    const reading = Object.entries(PAYMENTS_PAUSE_RESUMPTION)
      .filter(([, source]) => "field" in source)
      .map(([rail]) => rail)
      .sort();
    expect(reading).toEqual(["google", "lemonSqueezy", "paddle"]);
  });
});

/** This file's own directory, for the source scans below. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Every rail module's source, so the scan reads what ships rather than what a test re-declares.
 *
 * **Node's own recursive listing, not a recursion written here.** `packages/cli`'s
 * `ci/sourceFiles.test.ts` refuses a hand-rolled directory walk anywhere in the repository — there were
 * six copies once — and offers two ways out: route through `ci/sourceFiles.ts`, or declare the module
 * as debt. Neither applies. This package cannot reach that helper (`cli` depends on the capabilities,
 * not the other way round), and debt is the wrong answer to a walk that need not exist: `readdirSync`
 * has done this since Node 18, and the gate names it as explicitly not a walk.
 */
function railSources(): { path: string; source: string }[] {
  const root = join(HERE, "..", "rails");
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path, source: readFileSync(path, "utf8") };
    });
}

describe("the date is never computed (#369, acceptance 2)", () => {
  test("every rail source is scanned, so an empty scan cannot pass for a clean one", () => {
    const sources = railSources();
    expect(sources.length).toBeGreaterThan(20);
    // Tied to the declaration rather than to a number an author kept in step: every rail declaring a
    // field must contain the assignment, so a rail that declares one and never writes it fails here.
    const declared = Object.values(PAYMENTS_PAUSE_RESUMPTION).filter((source) => "field" in source).length;
    expect(sources.filter(({ source }) => source.includes("resumesAt: pauseResumesAt(")).length).toBe(declared);
  });

  test("no rail assigns a resume date from anything but the shared reader", () => {
    // The one shape allowed at a rail: `resumesAt: pauseResumesAt({…})`, whose only date input is the
    // string the provider sent. A clock, an arithmetic expression, or a period end assigned here is what
    // this scan exists to catch — and it is why the fix is one function rather than a rule per rail.
    for (const { path, source } of railSources()) {
      for (const line of source.split("\n")) {
        if (!line.includes("resumesAt:")) continue;
        expect(line, `${path}: ${line.trim()}`).toMatch(/resumesAt: (pauseResumesAt\(|null)/);
      }
    }
  });

  test("the reader itself computes nothing — no clock, no arithmetic, no fallback field", () => {
    const source = readFileSync(join(HERE, "pause.ts"), "utf8");
    const body = source.slice(source.indexOf("export function pauseResumesAt"));
    for (const forbidden of ["Date.now", "getTime() +", "setMonth", "setDate", "expiresAt", "periodEnd"]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });
});
