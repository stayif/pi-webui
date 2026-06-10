/**
 * Wire protocol shared between server and web.
 *
 * The server owns this file; the web app imports it via the `@protocol` Vite
 * alias. Keep it dependency-free and type-only so both sides can consume it.
 */

/** A workspace tab. May or may not have an active runtime yet. */
export interface Workspace {
  /** Stable id for this workspace (the absolute, normalized cwd). */
  id: string;
  /** Absolute project directory. */
  path: string;
  /** Short display name (directory basename). */
  name: string;
  /**
   * Runtime liveness.
   * `offline`  — tab added but no session has been opened yet (no pi runtime)
   * `idle`     — runtime is live, not streaming
   * `running`  — runtime is streaming
   */
  status: "offline" | "idle" | "running" | "error";
  /** Read-only Pi settings default for this cwd (project settings over global). */
  defaultModel?: ModelInfo;
  /** Default thinking level after applying the model's advertised capabilities. */
  defaultThinkingLevel?: string;
  /** Thinking levels advertised by the default model. */
  defaultThinkingLevels?: string[];
}

/** Session summary as shown in the session list. Mirrors Pi's SessionInfo. */
export interface SessionSummary {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: string; // ISO
  modified: string; // ISO
  messageCount: number;
  firstMessage: string;
}

/** One node in the session tree (mirrors Pi's getTree()). */
export interface TreeNode {
  id: string;
  parentId: string | null;
  type: string;
  /** Short human label for the entry (role, summary marker, etc.). */
  label: string;
  /** True if this node is on the current active branch (leaf → root). */
  onActiveBranch: boolean;
  children: TreeNode[];
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  /** Thinking levels advertised by Pi's model metadata for this model. */
  thinkingLevels: string[];
  /** Whether auth is configured locally for this model's provider. */
  available: boolean;
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface SessionStats {
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: ContextUsage;
}

export interface PromptTextAttachment {
  type: "text";
  name: string;
  text: string;
}

export interface PromptImageAttachment {
  type: "image";
  name: string;
  mimeType: string;
  data: string;
}

export type PromptAttachment = PromptTextAttachment | PromptImageAttachment;

/** Snapshot of one workspace's active session, sent on connect and after swaps. */
export interface SessionState {
  workspaceId: string;
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  cwd: string;
  model?: ModelInfo;
  thinkingLevel: string;
  availableThinkingLevels: string[];
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMessages: string[];
  followUpMessages: string[];
  stats: SessionStats;
  contextUsage?: ContextUsage;
}

/**
 * A normalized transcript item. Both stored history and the live event stream
 * are flattened into this single shape, so the frontend renders hydrated
 * history and live updates identically.
 *
 * `kind` drives where the item is shown:
 *  - `user` / `assistant`  → center chat column (final conversation)
 *  - `reasoning` / `tool`  → right activity column (thinking + execution log)
 *  - `system`              → activity column (notices, summaries, errors)
 *  - `divider`             → client-only chat separator, never persisted to Pi
 *
 * This split is presentation only; the underlying Pi stream is one continuous
 * sequence of events.
 */
export interface TranscriptItem {
  id: string;
  /** Stable Pi session entry id when this item came from a concrete entry. */
  sourceEntryId?: string;
  kind: "user" | "assistant" | "reasoning" | "tool" | "system" | "divider";
  text: string;
  /** Activity sub-type, used for filtering/coloring the right column. */
  activity?: "reasoning" | "tool" | "shell" | "file" | "network" | "system" | "error";
  /** Tool name for `kind: "tool"`. */
  toolName?: string;
  /** True for tool/system items that represent an error. */
  isError?: boolean;
}

// ---- Client → Server WebSocket messages ----
//
// Session-scoped actions carry a `workspaceId`. If omitted, the server applies
// them to the active workspace.

interface WorkspaceScoped {
  workspaceId?: string;
}

export type ClientMessage =
  | ({ type: "prompt"; text: string; attachments?: PromptAttachment[]; streamingBehavior?: "steer" | "followUp" } & WorkspaceScoped)
  | ({ type: "abort" } & WorkspaceScoped)
  | ({ type: "clear_queue" } & WorkspaceScoped)
  | ({ type: "compact"; customInstructions?: string } & WorkspaceScoped)
  | ({ type: "set_model"; provider: string; modelId: string } & WorkspaceScoped)
  | ({ type: "set_session_name"; name: string } & WorkspaceScoped)
  | ({ type: "set_thinking_level"; level: string } & WorkspaceScoped)
  | ({ type: "new_session" } & WorkspaceScoped)
  | ({ type: "switch_session"; sessionPath: string } & WorkspaceScoped)
  | ({ type: "clone_session"; sessionPath: string } & WorkspaceScoped)
  | ({ type: "delete_sessions"; sessionPaths: string[] } & WorkspaceScoped)
  | ({ type: "reload_session" } & WorkspaceScoped)
  | ({ type: "fork"; entryId: string; position?: "before" | "at" } & WorkspaceScoped)
  | ({ type: "navigate_tree"; targetId: string; summarize?: boolean } & WorkspaceScoped)
  // workspace lifecycle
  | { type: "open_workspace"; path: string }
  | { type: "open_workspace_picker" }
  | { type: "close_workspace"; workspaceId: string }
  | { type: "switch_workspace"; workspaceId: string }
  | { type: "get_state" };

// ---- Server → Client WebSocket messages ----

export type ServerMessage =
  /** Current workspace list and which one is active. */
  | { type: "workspaces"; workspaces: Workspace[]; activeId: string | null }
  /** Full session snapshot for one workspace. */
  | { type: "state"; state: SessionState }
  /** A raw Pi AgentSession event, tagged with its workspace, for live render. */
  | { type: "agent_event"; workspaceId: string; event: unknown }
  /** Session was replaced (new/switch/fork/tree). UI should refetch history. */
  | { type: "session_replaced"; state: SessionState }
  /** Pi-native user-message fork selected text for pre-filling the composer. */
  | { type: "fork_prefill"; workspaceId: string; text: string }
  | { type: "error"; message: string };
