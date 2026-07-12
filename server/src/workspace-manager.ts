import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import {
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  SessionManager,
  getAgentDir,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";

import { RuntimeManager, type ProjectTrustResolver } from "./runtime-manager.ts";
import { getProjectTrustStatus } from "./project-trust.ts";
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
  /** One lazy runtime creation per workspace avoids duplicate trust prompts. */
  private startingRuntimes = new Map<string, Promise<RuntimeManager>>();
  private activeId: string | null = null;
  private readonly store: WorkspaceStore;
  private readonly agentDir = getAgentDir();
  private readonly trustStore = new ProjectTrustStore(this.agentDir);

  /** Process-global — model availability is the same regardless of workspace. */
  readonly sharedModels: ModelInfo[];
  private readonly modelRegistry: ModelRegistry;

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
    this.modelRegistry = registry;
    this.sharedModels = registry.getAvailable().map(modelToInfo);
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
  async ensureRuntime(
    workspaceId?: string,
    resolveProjectTrust?: ProjectTrustResolver,
  ): Promise<RuntimeManager> {
    const id = workspaceId ?? this.activeId;
    if (!id || !this.paths.has(id)) {
      throw new Error(`No workspace: ${workspaceId ?? "(active)"}`);
    }
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    const starting = this.startingRuntimes.get(id);
    if (starting) return starting;
    const resolved = this.paths.get(id)!;
    const created = this.spawnRuntime(resolved, resolveProjectTrust);
    this.startingRuntimes.set(id, created);
    try {
      return await created;
    } finally {
      if (this.startingRuntimes.get(id) === created) this.startingRuntimes.delete(id);
    }
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
      const defaults = this.resolveWorkspaceDefaults(p);
      entries.push({
        id,
        path: p,
        name: path.basename(p) || p,
        status: rt ? (rt.isBusy ? "running" : "idle") : "offline",
        ...defaults,
      });
    }
    return entries;
  }

  /** Session-scoped commands call this to get a runtime (lazy-spawned if needed). */
  async switchSession(
    workspaceId: string | undefined,
    sessionPath: string,
    resolveProjectTrust?: ProjectTrustResolver,
  ): Promise<void> {
    const cwd = this.resolvePath(workspaceId);
    await this.assertKnownSession(cwd, sessionPath);
    const rt = await this.ensureRuntime(workspaceId, resolveProjectTrust);
    await rt.switchSession(sessionPath);
  }

  async newSession(workspaceId: string | undefined, resolveProjectTrust?: ProjectTrustResolver): Promise<void> {
    const rt = await this.ensureRuntime(workspaceId, resolveProjectTrust);
    await rt.newSession();
  }

  async cloneSession(
    workspaceId: string | undefined,
    sessionPath: string,
    resolveProjectTrust?: ProjectTrustResolver,
  ): Promise<void> {
    const cwd = this.resolvePath(workspaceId);
    const resolvedPath = await this.assertKnownSession(cwd, sessionPath);

    const rt = await this.ensureRuntime(workspaceId, resolveProjectTrust);
    await rt.cloneSession(resolvedPath);
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

    const available = new Set((await SessionManager.list(cwd, this.sessionDirFor(cwd))).map((session) => path.resolve(session.path)));
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
  private async spawnRuntime(resolved: string, resolveProjectTrust?: ProjectTrustResolver): Promise<RuntimeManager> {
    const rt = await RuntimeManager.create(
      resolved,
      resolved,
      this.sessionDirFor(resolved),
      resolveProjectTrust,
    );
    if (!this.paths.has(resolved)) {
      await rt.dispose();
      throw new Error("Workspace was closed while starting Pi.");
    }
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

  private resolveWorkspaceDefaults(cwd: string): Pick<Workspace, "defaultModel" | "defaultThinkingLevel" | "defaultThinkingLevels"> {
    const settings = this.settingsForWorkspace(cwd);
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    const configuredModel = provider && modelId ? this.modelRegistry.find(provider, modelId) : undefined;
    const model = configuredModel && this.modelRegistry.hasConfiguredAuth(configuredModel)
      ? configuredModel
      : (this.modelRegistry.getAvailable()[0] ?? undefined);
    if (!model) return {};

    const thinkingLevels = getSupportedThinkingLevelsFromModel(model);
    const requestedThinking = settings.getDefaultThinkingLevel() ?? "medium";
    return {
      defaultModel: modelToInfo(model),
      defaultThinkingLevel: clampThinkingLevel(requestedThinking, thinkingLevels),
      defaultThinkingLevels: thinkingLevels,
    };
  }

  private async assertKnownSession(cwd: string, sessionPath: string): Promise<string> {
    const resolvedPath = path.resolve(sessionPath);
    const session = (await SessionManager.list(cwd, this.sessionDirFor(cwd))).find(
      (candidate) => path.resolve(candidate.path) === resolvedPath,
    );
    if (!session || path.resolve(session.cwd) !== path.resolve(cwd)) {
      throw new Error(`Unknown session: ${resolvedPath}`);
    }
    return resolvedPath;
  }

  sessionDirFor(cwd: string): string | undefined {
    const running = this.runtimes.get(WorkspaceManager.idFor(cwd));
    if (running) return running.sessionDir;
    const envSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    if (envSessionDir) return expandSessionDir(envSessionDir);
    return this.settingsForWorkspace(cwd).getSessionDir();
  }

  private settingsForWorkspace(cwd: string): SettingsManager {
    const trust = getProjectTrustStatus(cwd, this.agentDir, this.trustStore);
    return SettingsManager.create(cwd, this.agentDir, { projectTrusted: trust.trusted });
  }
}

type RegistryModel = ReturnType<ModelRegistry["getAvailable"]>[number];

const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function modelToInfo(model: RegistryModel): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    thinkingLevels: getSupportedThinkingLevelsFromModel(model),
    available: true,
  };
}

function getSupportedThinkingLevelsFromModel(model: RegistryModel): string[] {
  if (!model.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function clampThinkingLevel(level: string, availableLevels: string[]): string {
  if (availableLevels.includes(level)) return level;
  const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level as never);
  if (requestedIndex === -1) return availableLevels[0] ?? "off";
  for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i += 1) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (candidate && availableLevels.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i -= 1) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (candidate && availableLevels.includes(candidate)) return candidate;
  }
  return availableLevels[0] ?? "off";
}

function expandSessionDir(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}
