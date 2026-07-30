// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/** The copyright line every source file carries. Free-form by design — the gate never asserts it. */
export const COPYRIGHT_LINE = "SPDX-FileCopyrightText: 2026 Pithy";

/** Build the canonical two-line SPDX header for a license id. */
export function buildHeader(license: string): string {
  return `// ${COPYRIGHT_LINE}\n// SPDX-License-Identifier: ${license}`;
}

const IDENTIFIER = /^\s*\/\/\s*SPDX-License-Identifier:\s*(\S+)\s*$/;
const LINE_COMMENT = /^\s*\/\//;

/** Is this the interpreter line a CLI entry point opens with? */
export function isShebang(line: string): boolean {
  return line.startsWith("#!");
}

/**
 * The declared license of `source`, or `null` if it carries no header.
 *
 * Only the file's opening comment block counts — the scan stops at the first line that is neither
 * blank nor a `//` comment. An `SPDX-License-Identifier` mentioned further down (in a doc comment
 * that documents this very convention, say) is prose, not a header, and must not satisfy the gate.
 */
export function readIdentifier(source: string): string | null {
  return locateIdentifier(source.split("\n"))?.license ?? null;
}

/**
 * Where the identifier sits in `lines`, and what it says. `null` when the leading comments have none.
 *
 * Block comments are scanned *through*, not stopped at. Nearly every module here opens with a `/** … *\/`
 * docblock, so treating one as the end of the header region would call a file with its header just
 * below the docblock headerless — and {@link applyHeader} would then write a second header above it.
 */
function locateIdentifier(lines: string[]): { index: number; license: string } | null {
  let i = lines[0] !== undefined && isShebang(lines[0]) ? 1 : 0;
  let inBlock = false;

  for (; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed === "") continue;

    if (inBlock) {
      const end = trimmed.indexOf("*/");
      if (end === -1) continue;
      inBlock = false;
      // Code sharing the closing line ends the header region, the same as code on its own line.
      if (trimmed.slice(end + 2).trim() !== "") return null;
      continue;
    }

    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      if (end === -1) {
        inBlock = true;
        continue;
      }
      if (trimmed.slice(end + 2).trim() !== "") return null;
      continue;
    }

    if (!LINE_COMMENT.test(trimmed)) return null;
    const match = IDENTIFIER.exec(trimmed);
    if (match?.[1] !== undefined) return { index: i, license: match[1] };
  }
  return null;
}

/**
 * Does this file mention an SPDX licence identifier at all, in any comment syntax?
 *
 * Deliberately laxer than {@link readIdentifier}, and used for the opposite purpose: the scaffolded
 * template trees are checked for the *absence* of a header, and they hold `.css`, `.html` and
 * `.jsonc` files that cannot carry a `//` comment. Matching only the TypeScript form would let a
 * stamped stylesheet ship into the adopter's repo unflagged — which is the whole thing the carve-out
 * exists to prevent. A template has no reason to name an SPDX identifier in any form.
 */
export function mentionsSpdx(source: string): boolean {
  return source.includes("SPDX-License-Identifier");
}

/**
 * `source` with a header declaring `license` — inserted when absent, corrected when wrong.
 *
 * Correcting rewrites only the identifier line, so a copyright line someone has edited by hand
 * survives. A file already declaring `license` is returned untouched, which is what makes `--fix`
 * idempotent and keeps it from reverting a deliberate copyright change.
 */
export function applyHeader(source: string, license: string): string {
  const lines = source.split("\n");
  const found = locateIdentifier(lines);

  if (found?.license === license) return source;

  if (found !== null) {
    const corrected = [...lines];
    corrected[found.index] = `// SPDX-License-Identifier: ${license}`;
    return corrected.join("\n");
  }

  const shebang = lines[0] !== undefined && isShebang(lines[0]) ? lines[0] : null;
  const body = lines.slice(shebang === null ? 0 : 1);
  while (body[0] !== undefined && body[0].trim() === "") body.shift();

  const prefix = shebang === null ? "" : `${shebang}\n`;
  return `${prefix}${buildHeader(license)}\n\n${body.join("\n")}`;
}
