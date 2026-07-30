// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ProfileOverride } from "@pithy-sh/cloudflare/src/tokens/profiles";
import type { ProjectConfig } from "../project/config";

/**
 * Build the engine's profile-override resolver from `pithy.config.ts`'s `tokens.overrides`. A profile
 * with no configured override resolves to `undefined` (its predefined defaults stand). This is the
 * config half of overriding a profile; a `--permission` / `--store` flag is the per-mint half and
 * wins over this.
 */
export function tokenOverrideResolver(config: ProjectConfig): (profile: string) => ProfileOverride | undefined {
  const overrides = config.tokens?.overrides ?? {};
  return (profile) => overrides[profile];
}
