---
"@pithy-sh/cli": patch
---

A capability that is installed and broken no longer disappears without a word.

`availableManifests` caught every failure from loading a manifest and skipped the package. The catch is there to skip packages that ship no manifest, which is ordinary — `@pithy-sh/cli` is not a capability. It also swallowed a manifest that **is** there and is **invalid**, so a schema refusal made the capability vanish from `pithy add --list`, `pithy upgrade` and `pithy doctor` with nothing said anywhere. The three commands an adopter runs *because* something is missing were the three that stayed silent.

Missing and invalid are different answers and this code gave them the same one. Only `ENOENT` is a silent skip now. A parse failure, a schema refusal, or a file that will not open is reported, naming the package and the reason — and the reason is the schema's own refusal text, so it reads the same as `loadManifest`'s on the direct path.

Each caller reports it the way it reports: `pithy add --list` names the package on stderr and still prints the other fifteen entries, because one broken package must not cost the listing; `pithy upgrade` prints a warning above the Workers, since manifests install once at the project root and belong to no Worker; `pithy doctor` carries a `manifests` check in `Project health` that fails the exit, so CI gates on it. `--json` carries `manifestFaults` on both commands.

`loadManifest` had the same shape on its own path: every read failure became "No capability named X is installed", which for an unreadable file sends the adopter to `pithy add` — the command that has just declined to run. It now tells the two apart.

Third instance of this defect. `readDevVarsSource` read every errno on `.dev.vars` as absence, and `readDevJson` did the same for `dev.json`; both now say only `ENOENT` means gone. Tests cover missing, unparseable, schema-invalid and unreadable separately, because they were one case in the code.
