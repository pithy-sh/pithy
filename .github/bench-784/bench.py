#!/usr/bin/env python3
"""Time `tsc -p` against `bun check -p` for every typecheck invocation in the kit.

Usage: bench.py <repo-root> <bun-binary> <runs> <out.json>

Each invocation is run once per checker as a warm-up, then <runs> times per checker, alternating
tsc / bun so machine load lands on both alike. Wall-clock and peak RSS come from /usr/bin/time.
"""
import json
import os
import re
import statistics
import subprocess
import sys

root, bun, runs, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]


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
            assert args[0] == "tsc", part
            yield os.path.dirname(f), cwd, args[1:]


def timed(cmd, cwd):
    p = subprocess.run(["/usr/bin/time", "-f", "TIME %e %M", *cmd], cwd=cwd, capture_output=True, text=True)
    m = re.search(r"TIME ([\d.]+) (\d+)\s*$", p.stderr)
    out_text = p.stdout + p.stderr[: m.start()] if m else p.stdout + p.stderr
    return float(m.group(1)), int(m.group(2)) // 1024, p.returncode, out_text


results = []
for ws, cwd, flags in invocations():
    tsc = [os.path.join(cwd, "node_modules", ".bin", "tsc"), *flags]
    chk = [bun, "check", "--no-pretty", *flags]
    rows = {"tsc": [], "bun": []}
    for name, cmd in (("tsc", tsc), ("bun", chk)):
        timed(cmd, cwd)  # warm-up
    last = {}
    for _ in range(runs):
        for name, cmd in (("tsc", tsc), ("bun", chk)):
            t, rss, code, text = timed(cmd, cwd)
            rows[name].append((t, rss))
            last[name] = (code, text)
    entry = {"workspace": ws, "flags": " ".join(flags)}
    for name in rows:
        entry[name] = {
            "median_s": statistics.median(t for t, _ in rows[name]),
            "peak_rss_mb": max(r for _, r in rows[name]),
            "exit": last[name][0],
            "output": last[name][1].strip()[:2000],
        }
    results.append(entry)
    print(f"{ws:28} {' '.join(flags):32} tsc {entry['tsc']['median_s']:6.2f}s  bun {entry['bun']['median_s']:6.2f}s  exit {entry['tsc']['exit']}/{entry['bun']['exit']}", flush=True)

json.dump(results, open(out, "w"), indent=1)
