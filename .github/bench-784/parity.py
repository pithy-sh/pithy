#!/usr/bin/env python3
"""Seed known errors into every typecheck program and compare tsc's diagnostics with bun check's.

Usage: parity.py <repo-root> <bun-binary> <out.json>

For each `tsc -p <config>` invocation, one seed file is written into the directory the config's first
`include` glob roots at, so the program picks it up as it would any source file. Both checkers run with
one-line output, the diagnostics are normalized to (file, line, col, code, message), and the two sets
are compared. Every seed is removed afterwards, including on failure. `tsc -b` solutions are skipped:
they compile nothing of their own.
"""
import json
import os
import re
import subprocess
import sys

root, bun, out = sys.argv[1], sys.argv[2], sys.argv[3]

SEED_NAME = "__parity_seed_784__"

# Each line is one deliberate error. Comments name what each probes.
SEED_TS = """\
// type mismatch
export const mismatch: number = "not a number";
// missing module
import { nothing } from "./__does_not_exist_784__";
export const useNothing = nothing;
// strict: implicit any
export function implicitAny(value) {
  return value;
}
// noUncheckedIndexedAccess
const list: number[] = [1];
export const indexed: number = list[0];
// verbatimModuleSyntax: a type imported as a value
import { SeedShape } from "./__parity_seed_784__.types";
export const shaped: SeedShape = { a: 1 };
// noImplicitOverride
class Base { run(): void {} }
export class Derived extends Base { run(): void {} }
// a lib the program may not load
export const title = document.title;
// a resolved library type, used wrongly
export const parsed: string = JSON.parse;
"""
SEED_TYPES = "export interface SeedShape { a: number }\n"
SEED_TSX = """\
export function Broken(): JSX.Element {
  return <div onClick={42} />;
}
"""

DIAG = re.compile(r"^(?P<file>.+?)\((?P<line>\d+),(?P<col>\d+)\): error (?P<code>TS\d+): (?P<msg>.*)$")


def load_jsonc(path):
    text = open(path).read()
    text = re.sub(r"(?m)^\s*//.*$", "", text)
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return json.loads(text)


def include_root(config_path):
    cfg = load_jsonc(config_path)
    includes = cfg.get("include")
    if not includes:
        return None, None, None
    first = includes[0]
    static = first.split("*")[0].rstrip("/")
    tsx = any(i.endswith(".tsx") for i in includes)
    seed_dir = os.path.normpath(os.path.join(os.path.dirname(config_path), static))
    # A config that names files rather than a glob: seed beside the first one.
    if os.path.isfile(seed_dir) or os.path.splitext(seed_dir)[1] in (".ts", ".tsx"):
        seed_dir = os.path.dirname(seed_dir)
    return seed_dir, tsx, includes


def diagnostics(cmd, cwd):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    found = set()
    for line in (p.stdout + p.stderr).splitlines():
        m = DIAG.match(line.strip())
        if m:
            path = os.path.normpath(os.path.join(cwd, m["file"]))
            found.add((os.path.relpath(path, root), int(m["line"]), int(m["col"]), m["code"], m["msg"].strip()))
    return p.returncode, found


def invocations():
    files = subprocess.run(["git", "ls-files", "*package.json"], cwd=root, capture_output=True, text=True, check=True).stdout.split()
    for f in sorted(files):
        if f == "package.json":
            continue
        script = json.load(open(os.path.join(root, f))).get("scripts", {}).get("typecheck")
        if not script:
            continue
        cwd = os.path.join(root, os.path.dirname(f))
        for part in script.split("&&"):
            args = part.split()
            yield os.path.dirname(f), cwd, args[1:]


results = []
for ws, cwd, flags in invocations():
    if flags[0] != "-p":
        results.append({"workspace": ws, "flags": " ".join(flags), "skipped": "a solution file compiles nothing of its own"})
        continue
    config = os.path.join(cwd, flags[1])
    seed_dir, tsx, includes = include_root(config)
    if seed_dir is None or not os.path.isdir(seed_dir):
        results.append({"workspace": ws, "flags": " ".join(flags), "skipped": f"no include root found ({seed_dir})"})
        continue
    written = [os.path.join(seed_dir, SEED_NAME + ".ts"), os.path.join(seed_dir, SEED_NAME + ".types.ts")]
    contents = [SEED_TS, SEED_TYPES]
    if tsx:
        written.append(os.path.join(seed_dir, SEED_NAME + ".tsx"))
        contents.append(SEED_TSX)
    # Every seed is added to the program explicitly, through a config that extends the real one, so a
    # program that names its files rather than a glob is seeded too, and every seed lands in every program.
    config_dir = os.path.dirname(config)
    probe = os.path.join(config_dir, SEED_NAME + ".tsconfig.json")
    written.append(probe)
    contents.append(json.dumps({
        "extends": "./" + os.path.basename(config),
        "include": [*includes, *(os.path.relpath(w, config_dir) for w in written[:-1])],
    }))
    probe_flags = ["-p", os.path.relpath(probe, cwd)]
    try:
        for path, body in zip(written, contents):
            with open(path, "w") as fh:
                fh.write(body)
        tsc_code, tsc_diags = diagnostics([os.path.join(cwd, "node_modules", ".bin", "tsc"), "--pretty", "false", *probe_flags], cwd)
        bun_code, bun_diags = diagnostics([bun, "check", "--no-pretty", "--all", *probe_flags], cwd)
    finally:
        for path in written:
            if os.path.exists(path):
                os.remove(path)
    entry = {
        "workspace": ws,
        "flags": " ".join(flags),
        "seed_dir": os.path.relpath(seed_dir, root),
        "tsc_exit": tsc_code,
        "bun_exit": bun_code,
        "tsc_count": len(tsc_diags),
        "bun_count": len(bun_diags),
        "only_tsc": sorted(tsc_diags - bun_diags),
        "only_bun": sorted(bun_diags - tsc_diags),
        "codes": sorted({d[3] for d in tsc_diags}),
    }
    results.append(entry)
    same = not entry["only_tsc"] and not entry["only_bun"]
    print(f"{ws:28} {' '.join(flags):32} tsc {len(tsc_diags):3} bun {len(bun_diags):3}  {'same' if same else 'DIFFER'}", flush=True)

json.dump(results, open(out, "w"), indent=1)
