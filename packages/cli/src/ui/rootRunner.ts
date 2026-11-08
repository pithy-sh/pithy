// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { readOptionalFile } from "../project/readOptionalFile";

/**
 * Whether the project's root `vitest.config.ts` leaves `apps/<app>` to a runner of its own, so the screen tests an
 * Expo app is seeded with run under the app's config and never in the root's plain-Node `node` project, where a
 * screen that imports `react-native` cannot load.
 *
 * Read from the file's text, not by running it: `pithy ui add` runs before an install, when the config's own
 * imports may not resolve. Two signs count, outside comments: the `ownRunners(` call the starter's config has made
 * since it learned to leave such an app out, or the app's own exclusion, `apps/<app>/**`, written in a string.
 * No root config at all is a yes, since nothing collects the app's tests. Anything else is a no, because a test
 * seeded into a config this cannot read is a red run nobody asked for.
 */
export async function rootLeavesApp(projectDir: string, app: string): Promise<boolean> {
  const text = await readOptionalFile(join(projectDir, "vitest.config.ts"));
  if (text === null) return true;
  const code = blankComments(text);
  if (/\bownRunners\s*\(/.test(code)) return true;
  return ['"', "'", "`"].some((quote) => code.includes(`${quote}apps/${app}/**${quote}`));
}

/** The one line that tells the adopter how to get the screen tests a run left out. */
export function screenTestsRemedy(app: string, retry: string): string {
  return `Add "apps/${app}/**" to the node project's exclude in the root vitest.config.ts, then run ${retry} to add them.`;
}
