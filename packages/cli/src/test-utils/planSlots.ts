// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * **What the plan gates read off a payload schema (#697).** Every `--dry-run` payload carries `plan` as
 * `Plan` itself, never a copy, and `plan/dryRun.test.ts` holds every command to it. The walk is a test's
 * question, so it lives with the tests rather than in the shipped `plan/plan.ts`.
 */

/** The schemas under every `plan` key of a payload, through unions and optionals. */
export function planSlots(schema: z.ZodType): z.ZodType[] {
  const found: z.ZodType[] = [];
  const visit = (node: z.ZodType): void => {
    if (node instanceof z.ZodUnion || node instanceof z.ZodDiscriminatedUnion) {
      for (const option of node.options as readonly z.ZodType[]) visit(option);
      return;
    }
    if (!(node instanceof z.ZodObject)) return;
    const slot = (node.shape as Record<string, z.ZodType | undefined>).plan;
    if (slot === undefined) return;
    found.push(slot instanceof z.ZodOptional ? (slot.unwrap() as z.ZodType) : slot);
  };
  visit(schema);
  return found;
}
