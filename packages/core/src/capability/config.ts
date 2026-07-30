// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { Capability } from "./capability";

/** Compose each capability's config schema into one object keyed by capability name. */
export function composeConfig(capabilities: Capability[]): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};
  for (const cap of capabilities) {
    if (cap.config) shape[cap.name] = cap.config;
  }
  return z.object(shape);
}

/** Validate raw config input against the composed schema; throws on mismatch. */
export function loadConfig(capabilities: Capability[], input: unknown): Record<string, Record<string, unknown>> {
  return composeConfig(capabilities).parse(input) as Record<string, Record<string, unknown>>;
}
