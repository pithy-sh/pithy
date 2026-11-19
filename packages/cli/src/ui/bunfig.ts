// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The project's `bunfig.toml`, which an Expo app needs installed with Bun's hoisted linker.
 *
 * Bun's default for a workspace is the isolated linker, and under it the peer loop between `expo`, `@expo/cli` and
 * `expo-router` installs `expo` twice, which `expo-doctor`'s duplicate check fails and Metro can bundle twice. The
 * hoisted linker installs it once. Bun reads `bunfig.toml` from the directory `bun install` runs in, the project
 * root, and the setting is ignored by every other package manager.
 */

/** The file's name at the project root. */
export const BUNFIG = "bunfig.toml";

/** The setting, as it is written into the `[install]` table. */
const LINKER_LINE = 'linker = "hoisted"';

/**
 * The `bunfig.toml` text with `[install] linker = "hoisted"` set, or `null` when nothing is to change: a linker the
 * file already names is the adopter's choice and is kept. `null` text is a project with no `bunfig.toml`.
 *
 * Read line by line rather than parsed, so every other line, comments included, is written back as it was.
 */
export function withHoistedLinker(text: string | null): string | null {
  if (text === null) return `[install]\n${LINKER_LINE}\n`;
  const lines = text.split("\n");
  let table = "";
  let installHeader = -1;
  for (const [index, line] of lines.entries()) {
    const header = /^\s*\[\s*([^\]\s]+)\s*\]\s*(#.*)?$/.exec(line);
    if (header) {
      table = header[1] ?? "";
      if (table === "install" && installHeader === -1) installHeader = index;
      continue;
    }
    if (table === "install" && /^\s*"?linker"?\s*=/.test(line)) return null;
    if (table === "" && /^\s*install\s*\.\s*linker\s*=/.test(line)) return null;
  }
  if (installHeader !== -1) {
    lines.splice(installHeader + 1, 0, LINKER_LINE);
    return lines.join("\n");
  }
  const body = text.endsWith("\n") ? text : `${text}\n`;
  return `${body}\n[install]\n${LINKER_LINE}\n`;
}
