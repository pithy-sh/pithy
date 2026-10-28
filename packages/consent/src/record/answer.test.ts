// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConsentPurpose } from "@pithy-sh/core/src/consent/purpose";
import { describe, expect, test } from "vitest";
import { type AnswerRow, deciding, standing, standingGrant } from "./answer";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const DAY = 86_400_000;
const WINDOW = 30 * DAY;

const purpose = ConsentPurpose.parse({
  id: "clinic.storage",
  summary: "Store my health record.",
  noticeVersion: 2,
  minimumMethod: "typed",
});

function row(over: Partial<AnswerRow> = {}): AnswerRow {
  return {
    subjectKind: "account",
    action: "grant",
    noticeVersion: 2,
    method: "typed",
    expiresAt: null,
    recordedAt: new Date(NOW.getTime() - DAY),
    merged: false,
    ...over,
  };
}

describe("standing", () => {
  test("a current grant at the minimum, under the current notice, is granted", () => {
    expect(standing(purpose, [row()], NOW, WINDOW)).toBe("granted");
  });

  test("nothing recorded, or a purpose nobody declared, is no", () => {
    expect(standing(purpose, [], NOW, WINDOW)).toBe("never_granted");
    expect(standing(undefined, [row()], NOW, WINDOW)).toBe("unknown_purpose");
  });

  test("a withdrawal after the grant is no, and a grant after the withdrawal is yes again", () => {
    const withdrawn = row({ action: "withdraw", recordedAt: NOW });
    expect(standing(purpose, [row(), withdrawn], NOW, WINDOW)).toBe("withdrawn");
    const renewed = row({ recordedAt: new Date(NOW.getTime() + 1) });
    expect(standing(purpose, [row(), withdrawn, renewed], new Date(NOW.getTime() + 2), WINDOW)).toBe("granted");
  });

  test("an expired grant is no, at its expiry exactly", () => {
    expect(standing(purpose, [row({ expiresAt: NOW })], NOW, WINDOW)).toBe("expired");
    expect(standing(purpose, [row({ expiresAt: new Date(NOW.getTime() + 1) })], NOW, WINDOW)).toBe("granted");
  });

  test("a grant under an older notice version is no until renewed", () => {
    expect(standing(purpose, [row({ noticeVersion: 1 })], NOW, WINDOW)).toBe("stale_notice");
  });

  test("a grant below the purpose's minimum method is no", () => {
    expect(standing(purpose, [row({ method: "click" })], NOW, WINDOW)).toBe("below_minimum");
    expect(standing(purpose, [row({ method: "provider" })], NOW, WINDOW)).toBe("granted");
  });

  test("a visitor's unmerged grant ages out on the window, and a merged one does not", () => {
    const old = new Date(NOW.getTime() - WINDOW);
    expect(standing(purpose, [row({ subjectKind: "visitor", recordedAt: old })], NOW, WINDOW)).toBe("visitor_expired");
    expect(standing(purpose, [row({ subjectKind: "visitor", recordedAt: old, merged: true })], NOW, WINDOW)).toBe(
      "granted",
    );
  });
});

describe("deciding and standingGrant", () => {
  test("the latest row decides, and a tie goes to the one written later", () => {
    const grant = row({ recordedAt: NOW });
    const withdraw = row({ action: "withdraw", recordedAt: NOW });
    expect(deciding([grant, withdraw])).toBe(withdraw);
    expect(standingGrant([grant, withdraw])).toBeUndefined();
    expect(standingGrant([withdraw, grant])).toBe(grant);
  });
});
