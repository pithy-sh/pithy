// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { SupportConfig } from "../config/config";
import { type HandlerDeps, reclassifyConversation } from "./handlers";

/**
 * The classification worker classifies only when `ai.enabled` is on, so a reclassify on a project with it
 * off would start a run that classifies nothing. The route refuses before it dispatches or audits.
 */
describe("reclassifyConversation", () => {
  test("refuses with classification off, and neither dispatches nor records a success", async () => {
    const dispatchClassify = vi.fn().mockResolvedValue(true);
    const emit = vi.fn();
    const deps = {
      config: SupportConfig.parse({ ai: { enabled: false } }),
      dispatchClassify,
      emit,
    } as unknown as HandlerDeps;
    await expect(reclassifyConversation(deps, "thread-1", "ada@example.com")).rejects.toMatchObject({
      payload: { code: "support/classification_failed", message: expect.stringMatching(/classification is off/i) },
    });
    expect(dispatchClassify).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
