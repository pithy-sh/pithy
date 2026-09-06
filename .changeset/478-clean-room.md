---
"@pithy-sh/cli": patch
---

A release is now driven from outside the workspace before it ships.

Three defects reached the registry in one day and not one was visible from inside this repository. `workspace:*` published unrewritten, so twenty of twenty-two packages could not be installed — in a workspace that range resolves perfectly. `pithy ui add` crashed on the manifest `pithy init` had just written, for any adopter whose resolver landed below zod 4.4.0 — the lockfile here resolves above it. The `pithy` binary is raw TypeScript behind a `bun` shebang — Bun is always installed here. Every gate that existed asserted about the checkout.

`bun run clean-room` packs what would be published, installs it into an empty directory with nothing else on disk, and runs the commands an adopter runs first. Kit packages are overridden to their own fresh tarballs, so it tests the release being cut rather than the one before it.

**`--floors` is the half that matters most.** A range is a promise about every version in it, and nothing tested the bottom of ours. Pinned at its declared floor, the kit died on `z.codec is not a function` — the API the entire data layer is built from, absent below zod 4.1.0. No amount of reading manifests would have found that; installing at the floor found it on the first run.
