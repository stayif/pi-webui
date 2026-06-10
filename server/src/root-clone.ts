import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

export interface RootCloneResult {
  path: string;
  sessionId: string;
}

/**
 * Create a WebUI-specific root clone of one session's active path.
 *
 * This intentionally differs from Pi's native `/clone`: Pi records
 * `parentSession`, while WebUI root clone is independent so it can be pinned as
 * a top-level session. Only the active branch is copied; external child session
 * files and sibling branches are not copied.
 */
export async function createRootClone(sourcePath: string): Promise<RootCloneResult> {
  const source = SessionManager.open(sourcePath);
  const branch = source.getBranch();
  if (branch.length === 0) {
    throw new Error("Cannot clone session: no current entry selected.");
  }
  validateBranch(branch);

  const timestamp = new Date().toISOString();
  const sessionId = randomUUID();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionDir = source.getSessionDir();
  const newSessionFile = path.join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
  const tmpFile = `${newSessionFile}.tmp`;
  const header: SessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: source.getCwd(),
  };

  await fs.promises.mkdir(sessionDir, { recursive: true });
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(tmpFile, "wx");
    await handle.writeFile(`${JSON.stringify(header)}\n`);
    for (const entry of branch) {
      await handle.writeFile(`${JSON.stringify(entry)}\n`);
    }
    await handle.close();
    handle = undefined;
    await fs.promises.rename(tmpFile, newSessionFile);

    const clone = SessionManager.open(newSessionFile);
    if (clone.getHeader()?.parentSession) {
      throw new Error("Root clone validation failed: clone has parentSession.");
    }
    if (clone.getBranch().length === 0) {
      throw new Error("Root clone validation failed: cloned branch is empty.");
    }
    return { path: newSessionFile, sessionId };
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.promises.unlink(tmpFile).catch(() => {});
    await fs.promises.unlink(newSessionFile).catch(() => {});
    throw err;
  }
}

function validateBranch(branch: SessionEntry[]): void {
  let previousId: string | null = null;
  for (const [index, entry] of branch.entries()) {
    if (entry.parentId !== previousId) {
      throw new Error(
        `Cannot clone session: active branch is not contiguous at entry ${entry.id} (${index}).`,
      );
    }
    previousId = entry.id;
  }
}
