// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Finding an entitlement gate in source text — the pure half of the composition check.
 *
 * `pithy doctor` scans a Worker's own source for calls to the gates in `./require`, because the runtime
 * cannot tell the two failing cases apart: a legitimately unentitled user and a Worker that forgot to
 * compose a provider both produce a 403. Walking a directory needs the filesystem. Deciding whether one
 * string of source gates does not, and the halves are split here so the second can be used on its own.
 *
 * On its own, because an adopter has the same question about their own source with the answer inverted:
 * not *where a gate must exist* but *where one may not*. No control-plane route in the Pithy dashboard may
 * gate on a subscription — a customer's data must not become unreachable over a billing problem of ours —
 * and a gate that is never reached at runtime is precisely the one a runtime test misses. That assertion
 * is a few lines over `import.meta.glob(…, "?raw")`, provided it can import these rules rather than restate
 * them. A restated copy drifts, and drifts quietly: both copies keep passing while they disagree.
 *
 * It lives beside the gates it names rather than in the CLI. A rename in `./require` is then one file's
 * work, core is the package every adopter already depends on, and core's no-`node:` rule is asserted over
 * every module here (`../worker-safety.test.ts`) — which is what makes this importable from a program
 * typed for the Workers runtime at all. The CLI composes it; see `entitlementGap.ts` there.
 *
 * The scan is textual, deliberately. Loading a Worker's routes to inspect them would execute the code
 * under audit, and the question is not subtle enough to need a parser: a call to one of two named helpers.
 */

/**
 * A call to either gate. `\b` before the name keeps `myRequireEntitlement(` out, and requiring the open
 * paren keeps a bare import or a re-export out — importing a gate is not applying one, and reporting an
 * unused import would make the check noise rather than signal.
 */
const GATE_CALL = /\brequire(?:Any)?Entitlement\s*\(/;

/**
 * The source with its comments blanked, so a `// TODO: requireEntitlement("pro")` is not read as a gate.
 *
 * **String-aware, and it has to be.** Doing this with two regexes over raw source looks equivalent and is
 * not: a `/*` inside a string literal opens a comment the scanner never sees closed, and everything up to
 * the next `*&#47;` in the file vanishes. A Worker with `app.get("/assets/*", …)` followed by any doc comment
 * loses whatever sat between them — so a real gate goes unseen and the check reports clean. The same trap
 * in reverse is `https://`, whose `//` is not a comment.
 *
 * So this walks the source once, tracking which of code / string / template / line comment / block comment
 * it is in, and replaces comment characters with spaces rather than removing them — offsets stay put, which
 * keeps anything reported against this text meaningful. A real parser would be the third option and is far
 * more than a two-identifier search needs.
 */
export function withoutComments(source: string): string {
  const out: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];

    if (char === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      const end = close === -1 ? source.length : close + 2;
      // Newlines are kept so line structure survives; everything else becomes a space.
      out.push(source.slice(index, end).replace(/[^\n]/g, " "));
      index = end;
      continue;
    }
    if (char === "/" && next === "/") {
      const newline = source.indexOf("\n", index);
      const end = newline === -1 ? source.length : newline;
      out.push(" ".repeat(end - index));
      index = end;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      // Consume the whole literal, escapes included, so nothing inside it is read as code or as a comment.
      let scan = index + 1;
      while (scan < source.length && source[scan] !== char) {
        // A newline ends an unterminated quoted string; a template literal may legally span lines.
        if (source[scan] === "\n" && char !== "`") break;
        scan += source[scan] === "\\" ? 2 : 1;
      }
      const end = Math.min(scan + 1, source.length);
      out.push(source.slice(index, end));
      index = end;
      continue;
    }
    out.push(char);
    index += 1;
  }
  return out.join("");
}

/** Whether this source applies an entitlement gate, comments and string literals discounted. */
export function callsGate(source: string): boolean {
  return GATE_CALL.test(withoutComments(source));
}

/**
 * The files, of those given, that apply an entitlement gate — sorted, so a finding reads as a set.
 *
 * Takes the sources rather than a directory, which is what keeps this half free of `node:fs`. The CLI
 * hands it a walked `src/`; a test in a Workers-typed program hands it `import.meta.glob(…, "?raw")`,
 * which is the only way that program can read files at all.
 */
export function gateCallSites(sources: Readonly<Record<string, string>>): string[] {
  return Object.entries(sources)
    .filter(([, source]) => callsGate(source))
    .map(([file]) => file)
    .sort((a, b) => a.localeCompare(b));
}
