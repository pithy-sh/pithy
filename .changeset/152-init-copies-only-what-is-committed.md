---
"@pithy-sh/cli": patch
---

`pithy init` from a checkout copied the maintainer's `.dev.vars` into the adopter's new project.

`cp(templateDir(), targetDir, { recursive: true })` had no filter, so the starter arrived as it sits on
the machine running the command — gitignored files included. Reproduced: a `.dev.vars` holding a live
`CLOUDFLARE_API_TOKEN` landed in a brand-new project at mode 0664, because `cp` copies the source file's
mode, and `seedDevVars` then found a `.dev.vars` already there and left it exactly as it was. `git status`
said nothing, because the file is ignored.

#145 read the git index to decide what the published tarball carries, and stopped at the packer.
`pithy init` is the other reader of the same directory. Both ask `committedFiles` now — one module, in
`src/`, importing nothing but `node:child_process` and `node:path`, which the packing scripts reach by
rooting their program one directory higher. The collision gate reads the same allowlist, so `pithy init`
never refuses over a file the copy would not write. An installed CLI has no index beside its vendored
template and copies it as it stands: `prepack` built that copy from this same list.
