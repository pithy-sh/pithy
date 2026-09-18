// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/**
 * A published-shape `@pithy-sh/ui-react` tarball, built in memory: plain ustar, every file under
 * `package/templates/`, gzipped, with the `sha512-` integrity a packument would carry for it.
 *
 * For the suites that need the fetch path of the template report without the registry. `tarball.test.ts`
 * builds its own hostile variants; this is only ever the well-formed one.
 */
export function templateTarball(files: Record<string, string>): { bytes: Uint8Array; integrity: string } {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const [path, content] of Object.entries(files)) {
    const body = encoder.encode(content);
    const header = new Uint8Array(512);
    const put = (text: string, offset: number) => header.set(encoder.encode(text), offset);
    put(`package/templates/${path}`, 0);
    put("0000644\0", 100);
    put("0000000\0", 108);
    put("0000000\0", 116);
    put(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    put("00000000000\0", 136);
    put("        ", 148);
    put("0", 156);
    put("ustar\0", 257);
    put("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    blocks.push(header, padded);
  }
  blocks.push(new Uint8Array(1024));
  const tar = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.length;
  }
  const bytes = new Uint8Array(gzipSync(tar));
  return { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}
