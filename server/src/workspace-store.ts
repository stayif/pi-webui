import fs from "node:fs";
import path from "node:path";

/**
 * Persisted WebUI tab state.
 *
 * Design boundary: pi-webui is an independent dashboard over the user's local
 * Pi runtime. It reads and faithfully forwards the user's sessions, but it must
 * never write its own bookkeeping into `~/.pi` — that directory belongs to the
 * Pi CLI. So WebUI-only state (which tabs the user opened) lives *inside this
 * project*, in a gitignored file at the repo root. This keeps pi-webui cleanly
 * separable as a standalone open-source app.
 *
 * Tabs are user state, not derived state: there is no on-disk marker for "a pi
 * runtime is running in directory X" (the CLI writes no lock/pid file, and a
 * tab is *our* embedded runtime, not the terminal's separate process). So we
 * remember which directories the user opened and restore them next launch,
 * rather than auto-discovering — and never auto-spawn runtimes the user didn't
 * ask for.
 */
export interface WorkspaceStoreData {
  /** Absolute, normalized project directories, in tab order. */
  workspaces: string[];
  /** Last active workspace path, restored on launch if still present. */
  activeId: string | null;
}

export class WorkspaceStore {
  /** @param file Absolute path to the state file (project-local, gitignored). */
  constructor(private readonly file: string) {}

  load(): WorkspaceStoreData {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<WorkspaceStoreData>;
      const workspaces = Array.isArray(parsed.workspaces)
        ? parsed.workspaces.filter((p): p is string => typeof p === "string")
        : [];
      const activeId = typeof parsed.activeId === "string" ? parsed.activeId : null;
      return { workspaces, activeId };
    } catch {
      // Missing or corrupt file → empty state. The caller seeds a default.
      return { workspaces: [], activeId: null };
    }
  }

  save(data: WorkspaceStoreData): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
    } catch {
      // Persistence is best-effort; a failed write must not crash the server.
    }
  }
}
