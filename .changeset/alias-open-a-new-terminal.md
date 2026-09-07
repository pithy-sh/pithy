---
"@pithy-sh/cli": patch
---

`pithy alias` leads with the advice that works.

The command said `Reload your shell or run: source ~/.bashrc`, and sourcing is the half that can silently do nothing. An init above the block — atuin, fnm, mise, conda — commonly ends with a top-level `return` once it has already run, and inside `eval` that returns from the rc file itself, so every line below it is skipped. The alias is written correctly, the command exits 0, and the shell that asked for it never gets it. We append at the end of the file, which puts our block below every such init.

Opening a new terminal has none of that: the guard does not fire on a first load. So it goes first, and `source` stays as the faster option for anyone whose rc file runs to the end.
