// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Box, Text } from "ink";
import { dim } from "../../terminal/style";
import { type PickerIdentity, pickerView } from "./picker";

/** How many identities the picker shows at once. */
export const PICKER_ROWS = 10;

/**
 * Who to sign in as — shown **instead of** the roster, for as long as the question is open.
 *
 * `l` used to print the whole list into the stream as prose. That is fine for three identities and a
 * wall of output for twenty-nine, and past nine there was no digit left to bind at all, so it fell back
 * to a prompt that cannot run while Ink holds the terminal. A windowed list answers all three: every
 * identity is reachable with the arrows, the window keeps it to ten rows, and nothing is written to the
 * stream until something is actually opened.
 *
 * Replacing the roster rather than sitting under it is deliberate: the roster answers *what is running*
 * and this answers *who*, and only one of those is being asked.
 */
export function IdentityPicker(props: {
  identities: readonly PickerIdentity[];
  selected: number;
  query: string;
  columns: number;
}): React.ReactElement {
  const view = pickerView(props.identities, props.selected, PICKER_ROWS, props.query);
  const rule = "─".repeat(Math.max(0, Math.min(props.columns, 72)));

  return (
    <Box flexDirection="column">
      <Text wrap="truncate">{dim(rule)}</Text>
      {/* The query is echoed because it has to be: a filter you cannot see is a list that mysteriously
          has the wrong things in it. The block cursor marks where typing lands. */}
      <Text wrap="truncate">
        {"  Sign in as  "}
        {props.query === "" ? dim("type to filter") : `${props.query}█`}
        {view.position === "" ? "" : `   ${dim(view.position)}`}
      </Text>
      {view.rows.map((row) => (
        <Text key={row.userId} wrap="truncate">
          {row.marked ? "▸ " : "  "}
          {row.email}
        </Text>
      ))}
      <Text wrap="truncate">{dim(rule)}</Text>
      {/* `⏎` rather than the word, because the bar is read at a glance and the glyph is the key. No
          `1–9 jump`: the numbers were places in the whole list, so while the window showed 8-17 that hint
          pointed at rows which were not on screen — and a digit is filter text now. */}
      <Text wrap="truncate">
        {dim(props.query === "" ? "  ↑↓ select   ⏎ sign in   esc cancel" : "  ↑↓ select   ⏎ sign in   esc clear")}
      </Text>
    </Box>
  );
}
