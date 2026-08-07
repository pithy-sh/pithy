---
"@pithy-sh/cli": patch
---

`pithy worker remove` and `pithy remove` no longer `rm -rf` through a symlink.

Both built a path out of a name — `apps/<name>`, and `apps/<worker>/capabilities/<cap>` for an ejected
capability — and handed it straight to a recursive delete. Reproduced with the real CLI: a project
scaffolded `--name replay --worker board`, `apps` replaced with a link to a directory outside it, then
`pithy worker remove board`. The link's destination and everything under it was gone, and the command
printed "Removed replay-board." and "Done."

Every other escape in this series writes a file somewhere it should not, and recovery is deleting the
file. These remove a tree, and there is nothing to recover.

`removeScaffoldPath` is the one answer, and the `rm` lives inside it so no caller can route around it. Its
gate is stricter than the write gate: every component between the project and the target must be a real
directory, **and** the path must still resolve inside the project once the kernel has walked it — which
catches a bind mount, a hard-linked directory, and a link swapped in after the check. The project root is
never a valid target. Refusals are `PithyError` with an action that names a delete, not a write.
