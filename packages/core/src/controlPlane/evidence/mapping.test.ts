// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { controlplane } from "../capability";
import { ControlPlaneEvidenceResponse } from "../http/responses";
import {
  EVIDENCE_CONTROL_IDS,
  EVIDENCE_CONTROLS,
  EVIDENCE_MAPPING_VERSION,
  EvidenceSource,
  EvidenceState,
} from "./mapping";

describe("the evidence mapping table (#821)", () => {
  test("is versioned with a positive whole number", () => {
    expect(Number.isInteger(EVIDENCE_MAPPING_VERSION)).toBe(true);
    expect(EVIDENCE_MAPPING_VERSION).toBeGreaterThan(0);
  });

  test("pins the seven controls and their references, so moving one is a reviewed edit and a new version", () => {
    // Changing any row below is a change to the table: bump EVIDENCE_MAPPING_VERSION in the same commit.
    expect(EVIDENCE_MAPPING_VERSION).toBe(1);
    expect(EVIDENCE_CONTROL_IDS.map((id) => [id, EVIDENCE_CONTROLS[id].soc2, EVIDENCE_CONTROLS[id].iso27001])).toEqual([
      ["audit-logging", ["CC7.2"], ["A.8.15"]],
      ["route-verification", ["CC6.1"], ["A.5.15"]],
      ["management-access", ["CC6.2", "CC6.3"], ["A.5.18"]],
      ["key-rotation", ["CC6.1"], ["A.8.24"]],
      ["change-history", ["CC8.1"], ["A.8.32"]],
      ["data-protection", ["C1.1"], ["A.8.24"]],
      ["csrf", ["CC6.6"], ["A.8.26"]],
    ]);
  });

  test("has three states and none of them is a verdict", () => {
    expect(EvidenceState.options).toEqual(["evidenced", "gap", "not-derivable"]);
  });
});

describe("the pack's vocabulary is evidence, never a verdict (#821)", () => {
  const VERDICT = /compliant|passed|failed/i;

  test("no field, enum or description in the response schema says compliant, passed or failed", () => {
    const schema = JSON.stringify(z.toJSONSchema(ControlPlaneEvidenceResponse, { io: "output" }));
    expect(schema).not.toMatch(VERDICT);
    expect(schema).toContain("evidenced");
  });

  test("nor does the table, the source vocabulary, or the route the manifest advertises", () => {
    expect(JSON.stringify(EVIDENCE_CONTROLS)).not.toMatch(VERDICT);
    expect(JSON.stringify(EvidenceSource.options)).not.toMatch(VERDICT);
    const route = (controlplane().adminRoutes ?? []).find((candidate) => candidate.path.endsWith("/evidence"));
    expect(route?.scope).toBe("evidence:read");
    expect(route?.summary).not.toMatch(VERDICT);
  });
});
