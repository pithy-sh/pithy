// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { installedPackageBase, installedVersion } from "../project/installedPackage";
import { readFileOutcome, readOptionalFile } from "../project/readOptionalFile";
import { workspaceMembers } from "../project/workspaceMembers";
import { REACT_NATIVE_REACT } from "../ui/reactNative";

/**
 * **Does every Expo app run the React its React Native renderer was built from?**
 *
 * React Native ships a prebuilt renderer and refuses to start on any React but the one it was built from, so a
 * range like `^19.2.8` that resolves past the renderer gives an app that does not launch and an `expo-doctor` that
 * fails. The check reads what each app resolves, through the same chain the install links, never what its
 * `package.json` asks for. An app with no React Native or no React installed has nothing to compare, and an app
 * with no React DOM, as a native-only app has, compares React alone. A React Native whose renderer will not read,
 * or names no version, is `could-not-check`, never `ok`.
 *
 * Report only: the versions are the install's, not the project's files, and every app scaffolded with the old
 * range is in this state.
 */

/** Where React Native keeps its production Fabric renderer, which names the React it was built from. */
export const RENDERER_FILE = "Libraries/Renderer/implementations/ReactFabric-prod.js";

/** What runs `expo install` in the app's directory. */
const EXPO_INSTALL = "bunx expo install";

/** One Expo app whose React or React DOM differs from its renderer. */
export interface ExpoReactMismatch {
  /** The app's directory, from the project root. */
  app: string;
  /** The React version React Native's renderer was built from. */
  renderer: string;
  /** The React the app resolves. */
  react: string;
  /** The React DOM the app resolves, or `null` when it has none installed. */
  reactDom: string | null;
  /** The `expo install` command that pins React, the React DOM it has, and their types, run in the app's directory. */
  command: string;
}

/** What the check established. */
export interface ExpoReactCheck {
  /**
   * `mismatched` when an app's React is not its renderer's; otherwise `could-not-check` when the check threw or an
   * app's React Native renderer would not read, or named no version.
   */
  state: "ok" | "mismatched" | "could-not-check";
  /** One entry per mismatched app, in member order. */
  mismatched: ExpoReactMismatch[];
}

/** The React version a renderer build names, or `null` when it names none. */
export function rendererVersion(source: string): string | null {
  return /\bversion:\s*"(\d+\.\d+\.\d+[^"]*)"/.exec(source)?.[1] ?? null;
}

/**
 * The `expo install` that pins React, and React DOM unless `withReactDom` is false, to `renderer`. `@types/react`
 * takes the kit's range when the renderer is the kit's, and that renderer's minor otherwise.
 */
export function expoInstallCommand(renderer: string, withReactDom = true): string {
  const [major, minor] = renderer.split(".");
  const types = renderer === REACT_NATIVE_REACT.react ? REACT_NATIVE_REACT["@types/react"] : `~${major}.${minor}.0`;
  const reactDom = withReactDom ? ` react-dom@${renderer}` : "";
  return `${EXPO_INSTALL} react@${renderer}${reactDom} @types/react@${types}`;
}

/** Whether a member's `package.json` depends on React Native. */
async function isExpoApp(projectDir: string, member: string): Promise<boolean> {
  const raw = await readOptionalFile(join(projectDir, member, "package.json"));
  if (raw === null) return false;
  try {
    const manifest = JSON.parse(raw) as { dependencies?: Record<string, unknown> };
    return manifest.dependencies?.["react-native"] !== undefined;
  } catch {
    return false;
  }
}

/**
 * The renderer version the React Native a member resolves names, `null` when none is installed, and `unreadable`
 * when one is installed and its renderer is absent, will not open, or names no version.
 */
async function installedRenderer(projectDir: string, fromDir: string): Promise<string | "unreadable" | null> {
  const base = await installedPackageBase(projectDir, fromDir, "react-native");
  if (base === null) return null;
  const read = await readFileOutcome(join(base, "node_modules", "react-native", RENDERER_FILE));
  return (read.state === "read" ? rendererVersion(read.text) : null) ?? "unreadable";
}

/** Read every Expo app's React and React DOM against its renderer. Files only. */
export async function checkExpoReact(projectDir: string): Promise<ExpoReactCheck> {
  const mismatched: ExpoReactMismatch[] = [];
  let unreadable = false;
  for (const member of await workspaceMembers(projectDir)) {
    if (!(await isExpoApp(projectDir, member))) continue;
    const fromDir = join(projectDir, member);
    const renderer = await installedRenderer(projectDir, fromDir);
    const react = await installedVersion(projectDir, fromDir, "react");
    const reactDom = await installedVersion(projectDir, fromDir, "react-dom");
    if (renderer === null || react === null) continue;
    if (renderer === "unreadable") {
      unreadable = true;
      continue;
    }
    if (react === renderer && (reactDom === null || reactDom === renderer)) continue;
    mismatched.push({
      app: member,
      renderer,
      react,
      reactDom,
      command: expoInstallCommand(renderer, reactDom !== null),
    });
  }
  if (mismatched.length > 0) return { state: "mismatched", mismatched };
  return { state: unreadable ? "could-not-check" : "ok", mismatched };
}

/** One sentence for one mismatched app. */
function describeOne({ app, renderer, react, reactDom, command }: ExpoReactMismatch): string {
  const runs = [
    react === renderer ? null : `React ${react}`,
    reactDom === null || reactDom === renderer ? null : `React DOM ${reactDom}`,
  ]
    .filter((part) => part !== null)
    .join(" and ");
  return `${app} runs ${runs} on React Native's ${renderer} renderer, which takes React ${renderer} exactly, so the app will not launch. In ${app}, run \`${command}\`.`;
}

/** One line per mismatched app, none when every one matches, and one saying so when the check could not run. */
export function describeExpoReact(check: ExpoReactCheck): string[] {
  if (check.state === "could-not-check") {
    return ["Could not check the Expo apps' React against their React Native renderer."];
  }
  return check.mismatched.map(describeOne);
}

/** The remedy line under the findings. */
export const EXPO_REACT_ACTION =
  "React Native runs only on the React its renderer was built from, so pin react and react-dom to it exactly.";
