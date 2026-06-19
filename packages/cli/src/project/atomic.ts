import { rename, unlink, writeFile } from "node:fs/promises";

/** Write `content` to `path` atomically: write to a sibling `.tmp` file first, then rename. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content);
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
