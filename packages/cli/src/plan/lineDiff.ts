// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **The diff a plan carries for one file (#697)**: unified format, hunks only, three lines of context — the
 * shape `git diff` prints, so a person reviewing a `--dry-run` reads the change the way they will read it
 * in their own history afterwards.
 *
 * The common head and tail are trimmed before anything is compared, because a command's edit is almost
 * always a few lines in a file that otherwise stays put. What is left between them is compared line by
 * line with a longest-common-subsequence table. A middle too large for that table is said as a rewrite of
 * the whole middle, which is still a true diff, only a coarser one.
 */

const CONTEXT = 3;
/** The largest middle compared line by line: rows times columns. Past it, the middle is one replacement. */
const MAX_CELLS = 4_000_000;

type Op = { kind: " " | "-" | "+"; line: string };

/**
 * A text as lines, and whether its last line ends in a newline. A line ends at `\n` and nothing else: a `\r`
 * before it is content, as `git` reads it by default, so a write that only swaps CRLF for LF is a diff and not
 * an empty one.
 */
function split(text: string): { rows: string[]; trailing: boolean } {
  if (text === "") return { rows: [], trailing: true };
  const rows = text.split("\n");
  const trailing = rows[rows.length - 1] === "";
  if (trailing) rows.pop();
  return { rows, trailing };
}

/** The edit script turning `a` into `b`, as a longest common subsequence would align them. */
function align(a: readonly string[], b: readonly string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const ops: Op[] = a.slice(0, head).map((line) => ({ kind: " ", line }));
  ops.push(...alignMiddle(midA, midB));
  ops.push(...a.slice(a.length - tail).map((line): Op => ({ kind: " ", line })));
  return ops;
}

function alignMiddle(a: readonly string[], b: readonly string[]): Op[] {
  const removed = a.map((line): Op => ({ kind: "-", line }));
  const added = b.map((line): Op => ({ kind: "+", line }));
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_CELLS) return [...removed, ...added];
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] as string });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      ops.push({ kind: "-", line: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: "+", line: b[j] as string });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ kind: "-", line: a[i++] as string });
  while (j < b.length) ops.push({ kind: "+", line: b[j++] as string });
  return ops;
}

/** `start,count` as unified diff writes it: the count dropped when it is one, the start 0 when it is none. */
function range(start: number, count: number): string {
  if (count === 0) return `${start - 1},0`;
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** The marker `git` writes after a line that ends its file without a newline. */
const NO_NEWLINE = "\\ No newline at end of file";

/**
 * A side's lines as the diff compares them: a last line with no newline carries that fact in its identity, as
 * `git` compares it. So `b` at the end of a file and `b` followed by a newline are different lines, and the
 * change between them is a `-` and a `+`, each marked on the side that lacks the newline. Equal on both sides,
 * it stays context, and the marker follows the context line. The fact is carried as a trailing `\n`, which
 * no row `split` returns can contain, so it cannot collide with content.
 */
function keyed(side: { rows: string[]; trailing: boolean }): string[] {
  if (side.trailing || side.rows.length === 0) return side.rows;
  return [...side.rows.slice(0, -1), `${side.rows[side.rows.length - 1]}\n`];
}

/** The unified diff from `before` to `after`, hunks only, or `""` when they are the same text. */
export function unifiedDiff(before: string, after: string): string {
  if (before === after) return "";
  const ops = align(keyed(split(before)), keyed(split(after)));
  const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  if (changed.length === 0) return "";

  // Each change claims its context; claims that touch or overlap are one hunk.
  const spans: [number, number][] = [];
  for (const index of changed) {
    const start = Math.max(0, index - CONTEXT);
    const end = Math.min(ops.length - 1, index + CONTEXT);
    const previous = spans[spans.length - 1];
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else spans.push([start, end]);
  }

  const out: string[] = [];
  // Line numbers before each op, on each side.
  const lineA: number[] = [];
  const lineB: number[] = [];
  let numberA = 1;
  let numberB = 1;
  for (const op of ops) {
    lineA.push(numberA);
    lineB.push(numberB);
    if (op.kind !== "+") numberA += 1;
    if (op.kind !== "-") numberB += 1;
  }
  for (const [start, end] of spans) {
    const slice = ops.slice(start, end + 1);
    const countA = slice.filter((op) => op.kind !== "+").length;
    const countB = slice.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${range(lineA[start] ?? 1, countA)} +${range(lineB[start] ?? 1, countB)} @@`);
    for (const op of slice) {
      if (op.line.endsWith("\n")) out.push(`${op.kind}${op.line.slice(0, -1)}`, NO_NEWLINE);
      else out.push(`${op.kind}${op.line}`);
    }
  }
  return `${out.join("\n")}\n`;
}
