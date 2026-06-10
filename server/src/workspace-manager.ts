import path from "node:path";
import fs from "node:fs";

import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { RuntimeManager } from "./runtime-manager.ts";
import { createRootClone } from "./root-clone.ts";
import { WorkspaceStore } from "./workspace-store.ts";
import type { ModelInfo, SessionState, Workspace } from "./protocol.ts";

/**
 * Manages workspace tabs and their lazily-created Pi runtimes.
 *
 * A **workspace** (tab) is just a directory path the user is interested in. It
 * does NOT imply a running Pi runtime. A **runtime** is only created when the
 * user actually interacts with a session inside that workspace — the first
 * `switch_session` or `new_session` triggers lazy creation.
 *
 * This keeps the dashboard read-only until the user opts in: viewing sessions
 * in a directory costs nothing beyond a disk scan (SessionManager.list is
 * static). The model registry is process-global and always available.
 *
 * Tab lifecycle:
 *  1. Tabs persist (WorkspaceStore).
 *  2. On launch, sniff saved paths; drop any whose directory was deleted.
 *     Surviving paths are re-registered without spawning runtimes.
 *  3. Closing a tab disposes its runtime (if any) and removes the tab. It
 *     touches no files inside the workspace directory.
 */
export class WorkspaceManager {
  /** Normalised id → absolute directory path (persisted). */
  private paths = new Map<string, string>();
  /** Normalised id → RuntimeManager (lazy, NOT persisted). */
  private runtimes = new Map<string, RuntimeManager>();
  private activeId: string | null = null;
  private readonly store: WorkspaceStore;

  /** Process-global — model availability is the same regardless of workspace. */
  readonly sharedModels: ModelInfo[];

  // ---- callbacks ----

  onAgentEvent: (workspaceId: string, event: unknown) => void = () => {};
  onSessionReplaced: (state: SessionState) => void = () => {};
  onWorkspacesChanged: () => void = () => {};

  // ---- construction ----

  private constructor(store: WorkspaceStore) {
    this.store = store;
    // Standalone registry: model list is available even before the first runtime.
    const authStorage = AuthStorage.create();
    const registry = ModelRegistry.create(authStorage);
    this.sharedModels = registry.getAvailable().map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      reasoning: m.reasoning,
      available: true,
    }));
  }

  static async create(statePath: string): Promise<WorkspaceManager> {
    const mgr = new WorkspaceManager(new WorkspaceStore(statePath));
    await mgr.restore();
    return mgr;
  }

  // ---- id + helpers ----

  private static idFor(p: string): string {
    return path.resolve(p);
  }

  private static isDir(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  // ---- active / focus ----

  /** The active workspace entry (may not have a runtime yet). */
  get activeIdOrNull(): string | null {
    return this.activeId;
  }

  get activePath(): string | null {
    return this.activeId ? this.paths.get(this.activeId) ?? null : null;
  }

  /** The active runtime, if one has been started for the active workspace. */
  get activeRuntime(): RuntimeManager | undefined {
    return this.activeId ? this.runtimes.get(this.activeId) : undefined;
  }

  /** Resolve a workspace's path by id (or the active one). */
  resolvePath(workspaceId?: string): string {
    const id = workspaceId ?? this.activeId;
    const p = id ? this.paths.get(id) : undefined;
    if (p) return p;
    throw new Error(`No workspace: ${workspaceId ?? "(active)"}`);
  }

  /** Resolve a workspace's runtime (may be undefined — no session opened yet). */
  resolveRuntime(workspaceId?: string): RuntimeManager | undefined {
    const id = workspaceId ?? this.activeId;
    return id ? this.runtimes.get(id) : undefined;
  }

  /**
   * Resolve a runtime for session-scoped operations. Creates one lazily if the
   * workspace exists but hasn't had a session opened yet.
   */
  async ensureRuntime(workspaceId?: string): Promise<RuntimeManager> {
    const id = workspaceId ?? this.activeId;
    if (!id || !this.paths.has(id)) {
      throw new Error(`No workspace: ${workspaceId ?? "(active)"}`);
    }
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    const resolved = this.paths.get(id)!;
    return this.spawnRuntime(resolved);
  }

  // ---- workspace lifecycle ----

  async openWorkspace(cwd: string): Promise<void> {
    const resolved = WorkspaceManager.idFor(cwd);
    if (this.paths.has(resolved)) {
      // Already registered — just focus it.
      this.activeId = resolved;
      this.persist();
      this.onWorkspacesChanged();
      return;
    }
    if (!WorkspaceManager.isDir(resolved)) {
      throw new Error(`Not a directory: ${resolved}`);
    }
    this.paths.set(resolved, resolved);
    this.activeId = resolved;
    this.persist();
    this.onWorkspacesChanged();
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    const rt = this.runtimes.get(workspaceId);
    if (rt) {
      await rt.dispose();
      this.runtimes.delete(workspaceId);
    }
    this.paths.delete(workspaceId);
    if (this.activeId === workspaceId) {
      this.activeId = this.paths.keys().next().value ?? null;
    }
    this.persist();
    this.onWorkspacesChanged();
  }

  switchWorkspace(workspaceId: string): void {
    if (!this.paths.has(workspaceId)) {
      throw new Error(`No workspace: ${workspaceId}`);
    }
    this.activeId = workspaceId;
    this.persist();
    this.onWorkspacesChanged();
  }

  list(): Workspace[] {
    const entries: Workspace[] = [];
    for (const [id, p] of this.paths) {
      const rt = this.runtimes.get(id);
      entries.push({
        id,
        path: p,
        name: path.basename(p) || p,
        status: rt ? (rt.isStreaming ? "running" : "idle") : "offline",
      });
    }
    return entries;
  }

  /** Session-scoped commands call this to get a runtime (lazy-spawned if needed). */
  async switchSession(workspaceId: string | undefined, sessionPath: string): Promise<void> {
    const rt = await this.ensureRuntime(workspaceId);
    await rt.switchSession(sessionPath);
  }

  async newSession(workspaceId: string | undefined): Promise<void> {
    const rt = await this.ensureRuntime(workspaceId);
    await rt.newSession();
  }

  async cloneSession(workspaceId: string | undefined, sessionPath: string): Promise<void> {
    const cwd = this.resolvePath(workspaceId);
    const resolvedPath = path.resolve(sessionPath);
    const available = new Set((await SessionManager.list(cwd)).map((session) => path.resolve(session.path)));
    if (!available.has(resolvedPath)) {
      throw new Error(`Unknown session: ${resolvedPath}`);
    }

    const rt = this.resolveRuntime(workspaceId);
    const activeSessionFile = rt?.session.sessionFile ? path.resolve(rt.session.sessionFile) : null;
    if (rt?.isStreaming && activeSessionFile === resolvedPath) {
      throw new Error("Cannot clone the active session while it is running.");
    }

    const cloned = await createRootClone(resolvedPath);
    const nextRt = await this.ensureRuntime(workspaceId);
    await nextRt.switchSession(cloned.path);
  }

  async reloadSession(workspaceId: string | undefined): Promise<void> {
    const rt = this.resolveRuntime(workspaceId);
    if (!rt) return; // no runtime — nothing to reload
    await rt.reloadSession();
  }

  async deleteSessions(workspaceId: string | undefined, sessionPaths: string[]): Promise<void> {
    const cwd = this.resolvePath(workspaceId);
    const requested = [...new Set(sessionPaths.map((sessionPath) => path.resolve(sessionPath)))];
    if (requested.length === 0) return;

    const available = new Set((await SessionManager.list(cwd)).map((session) => path.resolve(session.path)));
    for (const sessionPath of requested) {
      if (!available.has(sessionPath)) {
        throw new Error(`Unknown session: ${sessionPath}`);
      }
    }

    const rt = this.resolveRuntime(workspaceId);
    const activeSessionFile = rt?.session.sessionFile ? path.resolve(rt.session.sessionFile) : null;
    if (activeSessionFile && requested.includes(activeSessionFile)) {
      throw new Error("Cannot delete the active session.");
    }

    await Promise.all(requested.map((sessionPath) => fs.promises.unlink(sessionPath)));
  }

  async pruneMissing(): Promise<boolean> {
    const gone = [...this.paths.keys()].filter((id) => {
      const p = this.paths.get(id);
      return !p || !WorkspaceManager.isDir(p);
    });
    for (const id of gone) {
      const rt = this.runtimes.get(id);
      if (rt) {
        await rt.dispose();
        this.runtimes.delete(id);
      }
      this.paths.delete(id);
    }
    if (gone.length > 0) {
      if (this.activeId && !this.paths.has(this.activeId)) {
        this.activeId = this.paths.keys().next().value ?? null;
      }
      this.persist();
      this.onWorkspacesChanged();
    }
    return gone.length > 0;
  }

  // ---- internals ----

  private async restore(): Promise<void> {
    const saved = this.store.load();
    const survivors = saved.workspaces
      .map((p) => WorkspaceManager.idFor(p))
      .filter((p, i, arr) => arr.indexOf(p) === i)
      .filter((p) => WorkspaceManager.isDir(p));

    for (const dir of survivors) {
      this.paths.set(dir, dir);
    }

    const wantActive = saved.activeId ? WorkspaceManager.idFor(saved.activeId) : null;
    this.activeId =
      wantActive && this.paths.has(wantActive)
        ? wantActive
        : (this.paths.keys().next().value ?? null);

    this.persist();
    this.onWorkspacesChanged();
  }

  /** Create and wire a runtime. Only called lazily by ensureRuntime(). */
  private async spawnRuntime(resolved: string): Promise<RuntimeManager> {
    const rt = await RuntimeManager.create(resolved, resolved);
    rt.onAgentEvent = (id, ev) => this.onAgentEvent(id, ev);
    rt.onSessionReplaced = (state) => this.onSessionReplaced(state);
    rt.onStatusChanged = () => this.onWorkspacesChanged();
    this.runtimes.set(resolved, rt);
    this.persist(); // status changed → notify
    this.onWorkspacesChanged();
    return rt;
  }

  private persist(): void {
    this.store.save({
      workspaces: [...this.paths.keys()],
      activeId: this.activeId,
    });
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((rt) => rt.dispose()));
    this.runtimes.clear();
    this.paths.clear();
    this.activeId = null;
  }
}
