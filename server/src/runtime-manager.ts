import {
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  SessionManager,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  getAgentDir,
  type AgentSession,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent";

import type {
  ModelInfo,
  SessionState,
  SessionStats,
  TranscriptItem,
  TreeNode,
} from "./protocol.ts";
import { messagesToTranscript } from "./transcript.ts";

/**
 * Owns a single Pi AgentSessionRuntime bound to one workspace (project cwd).
 *
 * The hard part this class encapsulates is *session replacement*. new/switch/
 * fork/import all swap `runtime.session` for a fresh instance, which silently
 * invalidates any event subscription bound to the old one. We register a single
 * `setRebindSession` callback so every swap re-attaches our listener and
 * notifies the host to push a fresh snapshot.
 *
 * One RuntimeManager == one workspace tab. The WorkspaceManager owns several
 * and decides which is active.
 */
export class RuntimeManager {
  private runtime!: AgentSessionRuntime;
  private unsubscribe?: () => void;

  /** Forward a raw AgentSession event to the host (tagged with workspaceId). */
  onAgentEvent: (workspaceId: string, event: unknown) => void = () => {};
  /** A session swap happened in this workspace; push a new snapshot. */
  onSessionReplaced: (state: SessionState) => void = () => {};
  /** Streaming/compaction state changed; host may want to refresh tab status. */
  onStatusChanged: (workspaceId: string) => void = () => {};

  private constructor(readonly id: string, private readonly cwd: string) {}

  static async create(id: string, cwd: string): Promise<RuntimeManager> {
    const mgr = new RuntimeManager(id, cwd);
    await mgr.init();
    return mgr;
  }

  private async init(): Promise<void> {
    const agentDir = getAgentDir();
    // Fixed, process-global services. The factory recreates cwd-bound services
    // on every replacement so a /switch into a different project still works.
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);

    const sessionManager = SessionManager.create(this.cwd);

    this.runtime = await createAgentSessionRuntime(
      async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
        const services: AgentSessionServices = await createAgentSessionServices({
          cwd,
          agentDir,
          authStorage,
          modelRegistry,
        });
        const result = await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
        });
        return { ...result, services, diagnostics: services.diagnostics };
      },
      { cwd: this.cwd, agentDir, sessionManager },
    );

    // Re-bind our event listener on every session replacement. Without this,
    // events stop flowing after the first /new, /switch, /fork, or /import.
    this.runtime.setRebindSession(async (session: AgentSession) => {
      this.attach(session);
      this.onSessionReplaced(this.snapshot());
    });

    this.attach(this.runtime.session);
  }

  /** (Re)subscribe to the active session's event stream. */
  private attach(session: AgentSession): void {
    this.unsubscribe?.();
    this.unsubscribe = session.subscribe((event) => {
      this.onAgentEvent(this.id, event);
      // Streaming flags ride the event stream; let the host refresh tab status.
      const t = (event as { type?: string }).type;
      if (
        t === "agent_start" ||
        t === "agent_end" ||
        t === "queue_update" ||
        t === "compaction_start" ||
        t === "compaction_end"
      ) {
        this.onStatusChanged(this.id);
      }
    });
  }

  get session(): AgentSession {
    return this.runtime.session;
  }

  get cwdPath(): string {
    return this.runtime.cwd;
  }

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    await this.runtime.dispose();
  }

  // ---- prompt / turn control ----

  async prompt(
    text: string,
    streamingBehavior?: "steer" | "followUp",
    images?: NonNullable<PromptOptions["images"]>,
  ): Promise<void> {
    const behavior = this.session.isStreaming
      ? streamingBehavior ?? "steer"
      : undefined;
    await this.session.prompt(text, { streamingBehavior: behavior, images });
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  clearQueue(): void {
    this.session.clearQueue();
  }

  async compact(customInstructions?: string): Promise<void> {
    await this.session.compact(customInstructions);
  }

  async exportHtml(outputPath: string): Promise<string> {
    return this.session.exportToHtml(outputPath);
  }

  // ---- session-replacement operations ----

  async newSession(): Promise<void> {
    await this.runtime.newSession();
  }

  async switchSession(sessionPath: string): Promise<void> {
    await this.runtime.switchSession(sessionPath);
  }

  /**
   * Re-read the active session from disk.
   *
   * The WebUI holds an in-memory `SessionManager` for whichever session it
   * opened. If another process (e.g. `pi -r` in a terminal) appends to the same
   * JSONL, our copy goes stale and a list refresh won't fix it — the *list*
   * re-reads disk, but the active session's transcript does not. `switchSession`
   * always does a fresh `SessionManager.open()` from disk, so re-opening the
   * current file is the cheapest way to pull in external appends. No-op when
   * sessions are disabled (no file) or while we're streaming (would clobber a
   * live turn).
   */
  async reloadSession(): Promise<void> {
    const file = this.session.sessionFile;
    if (!file || this.session.isStreaming) return;
    await this.runtime.switchSession(file);
  }

  async fork(entryId: string, position: "before" | "at" = "before"): Promise<string | undefined> {
    const result = await this.runtime.fork(entryId, { position });
    return result.selectedText;
  }

  async navigateTree(targetId: string, summarize = false): Promise<string | undefined> {
    const result = await this.session.navigateTree(targetId, { summarize });
    // navigateTree stays in the same file (no runtime swap), so push a snapshot.
    this.onSessionReplaced(this.snapshot());
    return result.editorText;
  }

  // ---- model / thinking ----

  /**
   * Only the models that have local auth configured. This is what the user can
   * actually switch to; the full registry (every provider Pi supports) is noise
   * in the primary selector.
   */
  listModels(): ModelInfo[] {
    const registry = this.session.modelRegistry;
    return registry.getAvailable().map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      reasoning: m.reasoning,
      thinkingLevels: getSupportedThinkingLevelsFromModel(m),
      available: true,
    }));
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const model = this.session.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
    await this.session.setModel(model);
  }

  setSessionName(name: string): void {
    this.session.setSessionName(name);
  }

  setThinkingLevel(level: string): void {
    this.session.setThinkingLevel(level as never);
  }

  // ---- history ----

  /** Active branch transcript, normalized for the UI. */
  history(): TranscriptItem[] {
    return messagesToTranscript(this.session.sessionManager.getBranch() as unknown[]);
  }

  // ---- state snapshot ----

  snapshot(): SessionState {
    const s = this.session;
    const stats = this.stats();
    const model = s.model;
    return {
      workspaceId: this.id,
      sessionId: s.sessionId,
      sessionFile: s.sessionFile,
      sessionName: s.sessionName,
      cwd: this.runtime.cwd,
      model: model
        ? {
            provider: model.provider,
            id: model.id,
            name: model.name,
            contextWindow: model.contextWindow,
            reasoning: model.reasoning,
            thinkingLevels: s.getAvailableThinkingLevels(),
            available: s.modelRegistry.hasConfiguredAuth(model),
          }
        : undefined,
      thinkingLevel: s.thinkingLevel,
      availableThinkingLevels: s.getAvailableThinkingLevels(),
      isStreaming: s.isStreaming,
      isCompacting: s.isCompacting,
      steeringMessages: [...s.getSteeringMessages()],
      followUpMessages: [...s.getFollowUpMessages()],
      stats,
      contextUsage: s.getContextUsage(),
    };
  }

  stats(): SessionStats {
    const raw = this.session.getSessionStats();
    return {
      sessionId: raw.sessionId,
      userMessages: raw.userMessages,
      assistantMessages: raw.assistantMessages,
      toolCalls: raw.toolCalls,
      totalMessages: raw.totalMessages,
      tokens: raw.tokens,
      cost: raw.cost,
      contextUsage: raw.contextUsage,
    };
  }

  /** Build a UI-friendly tree from the session manager's tree + active branch. */
  tree(): TreeNode[] {
    const sm = this.session.sessionManager;
    const activeIds = new Set(sm.getBranch().map((e) => e.id));
    const raw = sm.getTree() as unknown[];
    const toNode = (n: any): TreeNode => {
      const entry = n.entry ?? n;
      return {
        id: entry.id,
        parentId: entry.parentId ?? null,
        type: entry.type ?? "entry",
        label: labelForEntry(entry, n.label),
        preview: previewForEntry(entry),
        body: bodyForEntry(entry),
        timestamp: timestampForEntry(entry),
        onActiveBranch: activeIds.has(entry.id),
        children: Array.isArray(n.children) ? n.children.map(toNode) : [],
      };
    };
    return raw.map(toNode);
  }
}

type SessionModel = NonNullable<AgentSession["model"]>;

const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function getSupportedThinkingLevelsFromModel(model: SessionModel): string[] {
  if (!model.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });
}

function labelForEntry(n: any, label?: string): string {
  if (label) return label;
  switch (n.type) {
    case "message": {
      const role = n.message?.role ?? n.role ?? "message";
      if (role === "toolResult") return n.message?.toolName ? `tool: ${n.message.toolName}` : "tool";
      if (role === "bashExecution") return "tool: bash";
      return String(role);
    }
    case "compaction":
      return "compaction summary";
    case "branch_summary":
      return "branch summary";
    case "model_change":
      return "model change";
    default:
      return n.type ?? "entry";
  }
}

function previewForEntry(n: any): string {
  return truncate(bodyForEntry(n), 500);
}

function bodyForEntry(n: any): string {
  if (n.type === "message") {
    const msg = n.message ?? {};
    switch (msg.role) {
      case "user":
        return contentToText(msg.content);
      case "assistant":
        return contentToText(msg.content);
      case "toolResult": {
        const name = typeof msg.toolName === "string" ? msg.toolName : "tool";
        return `${name} -> ${contentToText(msg.content)}`;
      }
      case "bashExecution": {
        const command = String(msg.command ?? "");
        const output = String(msg.output ?? "");
        const exit = msg.exitCode == null ? "" : `\n(exit ${msg.exitCode})`;
        return `$ ${command}\n${output}${exit}`;
      }
      default:
        return contentToText(msg.content);
    }
  }
  if (n.type === "branch_summary") return String(n.summary ?? "");
  if (n.type === "compaction") return String(n.summary ?? "");
  if (n.type === "model_change") return `${n.provider ?? "model"} / ${n.modelId ?? ""}`.trim();
  if (n.type === "thinking_level_change") return String(n.thinkingLevel ?? "");
  return n.type ? String(n.type) : "entry";
}

function timestampForEntry(n: any): string | undefined {
  const value = n.timestamp;
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  return undefined;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
    else if (block.type === "toolCall") {
      const name = typeof block.name === "string" ? block.name : "tool";
      parts.push(`${name}(${safeJson(block.arguments)})`);
    } else if (block.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("");
}

function safeJson(value: unknown): string {
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function truncate(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
