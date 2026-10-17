// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { pithyCommand } from "@pithy-sh/core/src/cli/command";

/**
 * **The four shims `pithy completion <shell>` prints (#765).**
 *
 * Each does one thing: on Tab, hand `pithy __complete` the line up to the cursor as one argument, and offer
 * what comes back. None holds a command, a flag or a value, so none goes stale when the CLI grows — the
 * binary on the PATH answers, which is also why completion follows `pithy` on the PATH and nothing else.
 * `bun run pithy`, `bunx pithy` and `npx pithy` start some other program first and get none.
 *
 * Every shim covers `pithy` and `p.`, the shortcut `pithy alias` installs, and both call `pithy` itself:
 * `p. <Tab>` completes as `pithy <Tab>` does. bash, zsh and PowerShell register `p.` by name, which costs
 * nothing where nobody defined it; fish's alias wraps `pithy` and inherits its completion.
 *
 * Each candidate line is `value`, or `value<TAB>description`. bash and PowerShell show the value; zsh and
 * fish show both. stderr is discarded, so nothing the binary might print lands in the command line.
 *
 * **Every command line here is built** (`ci/runnableCommands.test.ts`): `pithy completion <shell>` comes from
 * the builder, and `pithy` is otherwise never followed by a bare word — `p.` is named first, and the hidden
 * `__complete` is the one word the gate does not read as a command, which `scripts.test.ts` ties to
 * `COMPLETE_COMMAND`.
 */

/** The shells completion covers. nushell, which `pithy alias` covers, completes differently and is not one. */
export const COMPLETION_SHELLS = ["bash", "zsh", "fish", "powershell"] as const;

/** One of {@link COMPLETION_SHELLS}. */
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** Whether `name` is a shell completion covers. */
export function isCompletionShell(name: string): name is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(name);
}

/** `pithy completion <shell>`, as the builder spells it. */
function printing(shell: CompletionShell): string {
  return pithyCommand("completion", { args: [shell] });
}

/**
 * bash. The line comes from `COMP_LINE` rather than `COMP_WORDS`, because bash splits words on `=` and `:`
 * and the binary should see `--env=st` as typed. The candidates come back in that whole-word spelling, so
 * the part of the word bash does not count as the current one is taken off each before it is offered.
 */
const BASH = `# Tab completion for pithy, in bash. Load it with: eval "$(${printing("bash")})"
_pithy_complete() {
  local line="\${COMP_LINE:0:COMP_POINT}"
  local word="\${line##*[[:space:]]}"
  local current="\${COMP_WORDS[COMP_CWORD]}"
  local prefix="\${word%"$current"}"
  local candidate
  COMPREPLY=()
  while IFS= read -r candidate; do
    candidate="\${candidate%%$'\\t'*}"
    [[ -n "$candidate" ]] && COMPREPLY+=("\${candidate#"$prefix"}")
  done < <(command pithy __complete "$line" 2>/dev/null)
}
complete -F _pithy_complete p. pithy
`;

/**
 * zsh. `_describe` shows the description beside each value, so a colon in a value is escaped. `compinit` is
 * loaded first when the rc file has not loaded it yet, since `compdef` does not exist without it.
 */
const ZSH = `#compdef p. pithy
# Tab completion for pithy, in zsh. Load it with: eval "$(${printing("zsh")})"
_pithy() {
  local -a candidates
  local line value description
  for line in "\${(@f)$(command pithy __complete "\${(j: :)words[1,CURRENT]}" 2>/dev/null)}"; do
    [[ -z "$line" ]] && continue
    value="\${line%%$'\\t'*}"
    description="\${line#*$'\\t'}"
    [[ "$description" == "$line" ]] && description=""
    if [[ -n "$description" ]]; then
      candidates+=("\${value//:/\\\\:}:$description")
    else
      candidates+=("\${value//:/\\\\:}")
    fi
  done
  (( \${#candidates} )) && _describe -t values value candidates
}
if ! (( $+functions[compdef] )); then
  autoload -Uz compinit && compinit
fi
compdef _pithy p. pithy
`;

/**
 * fish. `commandline -cp` is the current command's text up to the cursor; fish shows the description after
 * the tab itself. `-f` keeps fish from mixing file names into a list the binary decided. `p.` is not
 * registered here: fish's `alias p. pithy`, the line `pithy alias` writes, wraps `pithy` and inherits these,
 * and registering it as well would ask the binary twice for every Tab.
 */
const FISH = `# Tab completion for pithy, in fish. Load it with: ${printing("fish")} | source
function __pithy_complete
    command pithy __complete (commandline -cp | string collect) 2>/dev/null
end
complete -c pithy -f -a '(__pithy_complete)'
`;

/**
 * PowerShell, 7 and Windows PowerShell 5.1 alike. The command's own text is cut at the cursor, and padded
 * with the spaces the parser left off its extent when the cursor sits past them. No `?:` or `??`, which
 * 5.1 does not parse. `-Native` covers `p.` too, though `pithy alias` makes it a function: a function with
 * no `param` block binds nothing, and PowerShell hands its arguments to the native completer registered
 * under its name. `scripts.test.ts` asks a real `pwsh` for both, where one is installed.
 */
const POWERSHELL = `# Tab completion for pithy, in PowerShell. Load it with: ${printing("powershell")} | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName 'p.', 'pithy' -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $text = $commandAst.Extent.Text
    $length = $cursorPosition - $commandAst.Extent.StartOffset
    if ($length -gt $text.Length) { $text = $text.PadRight($length) } else { $text = $text.Substring(0, $length) }
    & pithy __complete $text 2>$null | ForEach-Object {
        $parts = $_ -split "\`t", 2
        $tip = $parts[0]
        if ($parts.Length -gt 1 -and $parts[1]) { $tip = $parts[1] }
        [System.Management.Automation.CompletionResult]::new($parts[0], $parts[0], 'ParameterValue', $tip)
    }
}
`;

const SCRIPTS: Record<CompletionShell, string> = { bash: BASH, zsh: ZSH, fish: FISH, powershell: POWERSHELL };

/** The script `pithy completion <shell>` prints. */
export function completionScript(shell: CompletionShell): string {
  return SCRIPTS[shell];
}

/**
 * The one line `pithy completion` writes into the rc file: load the script from the binary on the PATH,
 * and do nothing at all where there is none, so a shell starts cleanly on a machine `pithy` has left. An
 * `if`, never `&&`: a missing binary must not leave the rc file ending on a failed status.
 */
const LOADING_LINES: Record<CompletionShell, string> = {
  bash: `if command -v pithy >/dev/null 2>&1; then eval "$(${printing("bash")})"; fi`,
  zsh: `if command -v pithy >/dev/null 2>&1; then eval "$(${printing("zsh")})"; fi`,
  fish: `if type -q pithy; ${printing("fish")} | source; end`,
  powershell: `if (Get-Command pithy -ErrorAction SilentlyContinue) { ${printing("powershell")} | Out-String | Invoke-Expression }`,
};

/** The line that loads completion for `shell`. */
export function loadingLine(shell: CompletionShell): string {
  return LOADING_LINES[shell];
}
