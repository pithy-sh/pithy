// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/** Whether two byte strings are equal. Every input compared here is public, so the early exit leaks nothing. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** SHA-256 over the parts, in order. */
export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const message = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    message.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", message));
}
