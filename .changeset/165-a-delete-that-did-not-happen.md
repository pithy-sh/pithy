---
"@pithy-sh/cli": patch
---

A delete that did not happen no longer reports success.

`removeScaffoldPath` read every `realpath` failure as "nothing there", and `ensureScaffoldPath` read every `lstat` failure as "missing, and so is everything below it". Neither is true for `EACCES`, `ELOOP`, or a mount that went away. A `chmod 0600` on `apps/` — readable, not searchable — was enough: the gate cleared a path it had never seen, the function returned having removed nothing, and the caller printed success.

Through `pithy remove <cap>` on an ejected capability it is worse. Config and wrangler are unwired first, so the run ended with the capability unwired, its source entire on disk, and an audit record saying `capability/removed`, `outcome: "success"`. A false audit record is the one failure this project cannot treat as cosmetic.

The rule was already written down nine lines away, in `survivorsOf`: only `ENOENT` means gone; anything else the probe cannot answer is unknown. It is now one function all four sites share, so it cannot be true in one of them and forgotten in the others. A path nothing could be established about stops the command and says which errno stopped it, in `detail`, where the HTTP codec strips it.

The root's own resolution gets its own sentence too. Swallowed, its failure printed "it isn't inside the project" — advice to treat a path as hostile, about a target nothing had established anything about, because the project directory could not be resolved.

Tested with a non-searchable **ancestor**. The existing tests chmod the target to 0500/0300, which leaves it reachable through its parent, so both probes succeed and it is the `rm` that fails — which is exactly why this survived a suite that already chmods.
