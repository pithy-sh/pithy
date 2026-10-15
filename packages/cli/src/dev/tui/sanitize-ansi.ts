// SPDX-FileCopyrightText: Vadym Demedes <vadimdemedes@hey.com>
// SPDX-FileCopyrightText: Sindre Sorhus <sindresorhus@gmail.com>
// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * A vendored copy of Ink's ANSI sanitizer (7.1.1's `build/sanitize-ansi.js` and its tokenizer,
 * called from `squash-text-nodes.js` on every `<Text>` child). Ink keeps both internal — the package
 * exports neither — so the resize rebuild vendors the equivalent.
 *
 * **Why the rebuild needs it.** On the normal path every committed line reaches the screen through
 * `<Text>`, and `<Text>` sanitizes: a worker's stray cursor move, screen erase, `ESC c` reset, DCS
 * string, or C1 control never touches the terminal. The rebuild restates lines straight to stdout,
 * and a worker's line is the child's own bytes behind a prefix, so without the same sanitizer a drag
 * can let a sequence the normal path always swallowed reach the terminal live. Same rules: keep
 * SGR (color, bold) and OSC (hyperlinks) sequences, strip everything else. The store keeps raw text;
 * sanitizing happens at the write, exactly where `<Text>`'s does.
 *
 * Standards references (Ink's, kept): ECMA-48 control functions and CSI byte classes
 * (https://ecma-international.org/publications-and-standards/standards/ecma-48/), xterm CSI
 * parameter format (https://invisible-island.net/xterm/ecma-48-parameter-format.html), OSC
 * BEL-termination (https://www.xfree86.org/current/ctlseqs.html).
 */

type Token =
  | { type: "text" | "osc" | "dcs" | "pm" | "apc" | "sos" | "st" | "c1" | "invalid"; value: string }
  | {
      type: "csi";
      value: string;
      parameterString: string;
      intermediateString: string;
      finalCharacter: string;
    }
  | { type: "esc"; value: string; intermediateString: string; finalCharacter: string };

const bellCharacter = "\u0007";
const escapeCharacter = "\u001B";
const stringTerminatorCharacter = "\u009C";
const csiCharacter = "\u009B";
const oscCharacter = "\u009D";
const dcsCharacter = "\u0090";
const pmCharacter = "\u009E";
const apcCharacter = "\u009F";
const sosCharacter = "\u0098";

const inRange = (character: string | undefined, lo: number, hi: number): boolean => {
  const codePoint = character?.codePointAt(0);
  return codePoint !== undefined && codePoint >= lo && codePoint <= hi;
};
const isCsiParameterCharacter = (c: string | undefined): boolean => inRange(c, 0x30, 0x3f);
const isCsiIntermediateCharacter = (c: string | undefined): boolean => inRange(c, 0x20, 0x2f);
const isCsiFinalCharacter = (c: string | undefined): boolean => inRange(c, 0x40, 0x7e);
const isEscapeIntermediateCharacter = (c: string | undefined): boolean => inRange(c, 0x20, 0x2f);
const isEscapeFinalCharacter = (c: string | undefined): boolean => inRange(c, 0x30, 0x7e);
const isC1ControlCharacter = (c: string | undefined): boolean => inRange(c, 0x80, 0x9f);

const readCsiSequence = (
  text: string,
  fromIndex: number,
): { endIndex: number; parameterString: string; intermediateString: string; finalCharacter: string } | undefined => {
  let index = fromIndex;
  while (index < text.length && isCsiParameterCharacter(text[index])) index++;
  const parameterString = text.slice(fromIndex, index);
  const intermediateStartIndex = index;
  while (index < text.length && isCsiIntermediateCharacter(text[index])) index++;
  const intermediateString = text.slice(intermediateStartIndex, index);
  const finalCharacter = text[index];
  if (finalCharacter === undefined || !isCsiFinalCharacter(finalCharacter)) return undefined;
  return { endIndex: index + 1, parameterString, intermediateString, finalCharacter };
};

const findControlStringTerminatorIndex = (
  text: string,
  fromIndex: number,
  allowBellTerminator: boolean,
): number | undefined => {
  for (let index = fromIndex; index < text.length; index++) {
    const character = text[index];
    if (allowBellTerminator && character === bellCharacter) return index + 1;
    if (character === stringTerminatorCharacter) return index + 1;
    if (character === escapeCharacter) {
      const followingCharacter = text[index + 1];
      // Tmux escapes ESC bytes in a payload as ESC ESC.
      if (followingCharacter === escapeCharacter) {
        index++;
        continue;
      }
      if (followingCharacter === "\\") return index + 2;
    }
  }
  return undefined;
};

const readEscapeSequence = (
  text: string,
  fromIndex: number,
): { endIndex: number; intermediateString: string; finalCharacter: string } | undefined => {
  let index = fromIndex;
  while (index < text.length && isEscapeIntermediateCharacter(text[index])) index++;
  const intermediateString = text.slice(fromIndex, index);
  const finalCharacter = text[index];
  if (finalCharacter === undefined || !isEscapeFinalCharacter(finalCharacter)) return undefined;
  return { endIndex: index + 1, intermediateString, finalCharacter };
};

// Centralized so the ESC and C1 introducer paths cannot diverge.
type ControlString = { type: "osc" | "dcs" | "pm" | "apc" | "sos"; allowBellTerminator: boolean };
const getControlStringFromEscapeIntroducer = (character: string): ControlString | undefined => {
  switch (character) {
    case "]":
      return { type: "osc", allowBellTerminator: true };
    case "P":
      return { type: "dcs", allowBellTerminator: false };
    case "^":
      return { type: "pm", allowBellTerminator: false };
    case "_":
      return { type: "apc", allowBellTerminator: false };
    case "X":
      return { type: "sos", allowBellTerminator: false };
    default:
      return undefined;
  }
};
const getControlStringFromC1Introducer = (character: string): ControlString | undefined => {
  switch (character) {
    case oscCharacter:
      return { type: "osc", allowBellTerminator: true };
    case dcsCharacter:
      return { type: "dcs", allowBellTerminator: false };
    case pmCharacter:
      return { type: "pm", allowBellTerminator: false };
    case apcCharacter:
      return { type: "apc", allowBellTerminator: false };
    case sosCharacter:
      return { type: "sos", allowBellTerminator: false };
    default:
      return undefined;
  }
};

export const hasAnsiControlCharacters = (text: string): boolean => {
  if (text.includes(escapeCharacter)) return true;
  for (const character of text) if (isC1ControlCharacter(character)) return true;
  return false;
};

const malformedFromIndex = (tokens: Token[], text: string, textStartIndex: number, fromIndex: number): Token[] => {
  if (fromIndex > textStartIndex) tokens.push({ type: "text", value: text.slice(textStartIndex, fromIndex) });
  // Treat the remainder as invalid so callers can drop it as one unsafe unit.
  tokens.push({ type: "invalid", value: text.slice(fromIndex) });
  return tokens;
};

export const tokenizeAnsi = (text: string): Token[] => {
  if (!hasAnsiControlCharacters(text)) return [{ type: "text", value: text }];
  const tokens: Token[] = [];
  let textStartIndex = 0;
  const flushText = (upto: number): void => {
    if (upto > textStartIndex) tokens.push({ type: "text", value: text.slice(textStartIndex, upto) });
  };
  for (let index = 0; index < text.length; ) {
    const character = text[index] as string;
    if (character === escapeCharacter) {
      const followingCharacter = text[index + 1];
      if (followingCharacter === undefined) return malformedFromIndex(tokens, text, textStartIndex, index);
      if (followingCharacter === "[") {
        const csiSequence = readCsiSequence(text, index + 2);
        if (csiSequence === undefined) return malformedFromIndex(tokens, text, textStartIndex, index);
        flushText(index);
        tokens.push({
          type: "csi",
          value: text.slice(index, csiSequence.endIndex),
          parameterString: csiSequence.parameterString,
          intermediateString: csiSequence.intermediateString,
          finalCharacter: csiSequence.finalCharacter,
        });
        index = csiSequence.endIndex;
        textStartIndex = index;
        continue;
      }
      const escapeControlString = getControlStringFromEscapeIntroducer(followingCharacter);
      if (escapeControlString !== undefined) {
        const terminator = findControlStringTerminatorIndex(text, index + 2, escapeControlString.allowBellTerminator);
        if (terminator === undefined) return malformedFromIndex(tokens, text, textStartIndex, index);
        flushText(index);
        tokens.push({ type: escapeControlString.type, value: text.slice(index, terminator) });
        index = terminator;
        textStartIndex = index;
        continue;
      }
      const escapeSequence = readEscapeSequence(text, index + 1);
      if (escapeSequence === undefined) {
        // Incomplete escape sequences with intermediates are malformed control strings.
        if (isEscapeIntermediateCharacter(followingCharacter))
          return malformedFromIndex(tokens, text, textStartIndex, index);
        flushText(index);
        // Ignore a lone ESC and keep tokenizing.
        index++;
        textStartIndex = index;
        continue;
      }
      flushText(index);
      tokens.push({
        type: "esc",
        value: text.slice(index, escapeSequence.endIndex),
        intermediateString: escapeSequence.intermediateString,
        finalCharacter: escapeSequence.finalCharacter,
      });
      index = escapeSequence.endIndex;
      textStartIndex = index;
      continue;
    }
    if (character === csiCharacter) {
      const csiSequence = readCsiSequence(text, index + 1);
      if (csiSequence === undefined) return malformedFromIndex(tokens, text, textStartIndex, index);
      flushText(index);
      tokens.push({
        type: "csi",
        value: text.slice(index, csiSequence.endIndex),
        parameterString: csiSequence.parameterString,
        intermediateString: csiSequence.intermediateString,
        finalCharacter: csiSequence.finalCharacter,
      });
      index = csiSequence.endIndex;
      textStartIndex = index;
      continue;
    }
    const c1ControlString = getControlStringFromC1Introducer(character);
    if (c1ControlString !== undefined) {
      const terminator = findControlStringTerminatorIndex(text, index + 1, c1ControlString.allowBellTerminator);
      if (terminator === undefined) return malformedFromIndex(tokens, text, textStartIndex, index);
      flushText(index);
      tokens.push({ type: c1ControlString.type, value: text.slice(index, terminator) });
      index = terminator;
      textStartIndex = index;
      continue;
    }
    if (character === stringTerminatorCharacter) {
      flushText(index);
      tokens.push({ type: "st", value: character });
      index++;
      textStartIndex = index;
      continue;
    }
    // Remaining C1 controls are standalone functions: strip them as one character each.
    if (isC1ControlCharacter(character)) {
      flushText(index);
      tokens.push({ type: "c1", value: character });
      index++;
      textStartIndex = index;
      continue;
    }
    index++;
  }
  if (textStartIndex < text.length) tokens.push({ type: "text", value: text.slice(textStartIndex) });
  return tokens;
};

const sgrParametersRegex = /^[\d:;]*$/;

/**
 * Strip ANSI sequences that would fight the writer's own layout. Kept: SGR (colors, bold — CSI,
 * final `m`, numeric/`:`/`;` parameters, no intermediates) and OSC (hyperlinks and friends, ESC ]
 * or the C1 introducer). Stripped: cursor movement, screen and line clearing, `ESC c` reset, DCS,
 * C1 controls, malformed tails — every other control sequence.
 */
export function sanitizeAnsi(text: string): string {
  if (!hasAnsiControlCharacters(text)) return text;
  let output = "";
  for (const token of tokenizeAnsi(text)) {
    if (token.type === "text" || token.type === "osc") {
      output += token.value;
      continue;
    }
    if (
      token.type === "csi" &&
      token.finalCharacter === "m" &&
      token.intermediateString === "" &&
      sgrParametersRegex.test(token.parameterString)
    ) {
      output += token.value;
    }
  }
  return output;
}

/** The text a terminal shows for `text`: every token's payload that occupies cells. Used for width. */
export function visibleText(text: string): string {
  let output = "";
  for (const token of tokenizeAnsi(text)) {
    if (token.type === "text") output += token.value;
  }
  return output;
}
