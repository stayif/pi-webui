import { randomUUID } from "node:crypto";
import type { WSContext } from "hono/ws";

import type { ProjectTrustRequest, ProjectTrustResolution, ProjectTrustResolver } from "./runtime-manager.ts";
import type { WorkspaceManager } from "./workspace-manager.ts";
import type { ClientMessage, PromptAttachment, ServerMessage } from "./protocol.ts";

export const MAX_CLIENT_MESSAGE_BYTES = 5 * 1024 * 1024;
const PROJECT_TRUST_TIMEOUT_MS = 60_000;

interface PendingProjectTrust {
  ws: WSContext;
  request: ProjectTrustRequest;
  resolve: (resolution: ProjectTrustResolution) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Bridges Pi event streams to WebSocket clients and routes commands back.
 */
export class WsBridge {
  private clients = new Set<WSContext>();
  private pendingProjectTrust = new Map<string, PendingProjectTrust>();

  constructor(private readonly mgr: WorkspaceManager) {
    mgr.onAgentEvent = (workspaceId, event) => {
      this.broadcast({ type: "agent_event", workspaceId, event });
      const eventType = (event as { type?: string }).type;
      if (
        eventType === "queue_update" ||
        eventType === "compaction_start" ||
        eventType === "compaction_end"
      ) {
        const rt = this.mgr.resolveRuntime(workspaceId);
        if (rt) this.broadcast({ type: "state", state: rt.snapshot() });
      }
    };
    mgr.onSessionReplaced = (state) => {
      this.broadcast({ type: "session_replaced", state });
    };
    mgr.onWorkspacesChanged = () => {
      this.broadcastWorkspaces();
    };
  }

  add(ws: WSContext): void {
    this.clients.add(ws);
    this.send(ws, {
      type: "workspaces",
      workspaces: this.mgr.list(),
      activeId: this.mgr.activeIdOrNull,
    });
    const active = this.mgr.activeRuntime;
    if (active) this.send(ws, { type: "state", state: active.snapshot() });
  }

  remove(ws: WSContext): void {
    this.clients.delete(ws);
    for (const [requestId, pending] of this.pendingProjectTrust) {
      if (pending.ws !== ws) continue;
      clearTimeout(pending.timeout);
      this.pendingProjectTrust.delete(requestId);
      pending.reject(new Error("Project trust request was cancelled because the browser disconnected."));
    }
  }

  async handle(ws: WSContext, raw: string): Promise<void> {
    if (Buffer.byteLength(raw, "utf8") > MAX_CLIENT_MESSAGE_BYTES) {
      this.send(ws, { type: "error", message: "message is too large" });
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(ws, { type: "error", message: "invalid JSON" });
      return;
    }
    try {
      await this.dispatch(ws, msg);
    } catch (err) {
      this.send(ws, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async dispatch(ws: WSContext, msg: ClientMessage): Promise<void> {
    // Convenience: resolve workspaceId from message or active.
    const wid = ("workspaceId" in msg ? (msg as { workspaceId?: string }).workspaceId : undefined);

    switch (msg.type) {
      // ---- workspace lifecycle (no runtime needed) ----
      case "open_workspace": {
        await this.mgr.openWorkspace(msg.path);
        this.broadcastWorkspaces();
        break;
      }
      case "close_workspace":
        this.cancelProjectTrustForWorkspace(msg.workspaceId);
        await this.mgr.closeWorkspace(msg.workspaceId);
        this.broadcastWorkspaces();
        break;
      case "switch_workspace":
        this.mgr.switchWorkspace(msg.workspaceId);
        this.broadcastWorkspaces();
        { const rt = this.mgr.activeRuntime;
          if (rt) this.broadcast({ type: "state", state: rt.snapshot() }); }
        break;

      // ---- session lifecycle (lazy-spawn runtime) ----
      case "switch_session":
        await this.mgr.switchSession(wid, msg.sessionPath, this.projectTrustResolver(ws));
        break;
      case "new_session":
        await this.mgr.newSession(wid, this.projectTrustResolver(ws));
        break;
      case "clone_session":
        await this.mgr.cloneSession(wid, msg.sessionPath, this.projectTrustResolver(ws));
        break;
      case "delete_sessions":
        await this.mgr.deleteSessions(wid, msg.sessionPaths);
        break;
      case "reload_session":
        await this.mgr.reloadSession(wid);
        break;

      // ---- session-scoped operations (need runtime) ----
      case "prompt": {
        const rt = await this.mgr.ensureRuntime(wid, this.projectTrustResolver(ws));
        const prepared = preparePrompt(msg.text, msg.attachments ?? []);
        await rt.prompt(prepared.text, msg.streamingBehavior, prepared.images);
        break;
      }
      case "abort": {
        const rt = await this.mgr.ensureRuntime(wid, this.projectTrustResolver(ws));
        await rt.abort();
        break;
      }
      case "clear_queue": {
        const rt = await this.mgr.ensureRuntime(wid, this.projectTrustResolver(ws));
        rt.clearQueue();
        this.broadcast({ type: "state", state: rt.snapshot() });
        break;
      }
      case "compact": {
        const rt = await this.mgr.ensureRuntime(wid, this.projectTrustResolver(ws));
        try {
          await rt.compact(msg.customInstructions);
        } finally {
          // Pi emits compaction_end before clearing its internal controller.
          // Publish once more after compact() returns so the UI receives false.
          this.broadcast({ type: "state", state: rt.snapshot() });
        }
        break;
      }
      case "set_model": {
        const rt = await this.mgr.ensureRuntime(wid, this.projectTrustResolver(ws));
        await rt.setModel(msg.provider, msg.modelId);
        // Model changed — push fresh snapshot.
        this.broadcast({ type: "state", state: rt.snapshot() });
        break;
      }
      case "set_session_name": {
        const rt = await this.mgr.ensureRuntime(wid, this.projectTrustResolver(ws));
        rt.setSessionName(msg.name);
        this.broadcast({ type: "state", state: rt.snapshot() });
        break;
      }
      case "set_thinking_level": {
        const rt = await this.mgr.ensureRuntime(wid, this.projectTrustResolver(ws));
        rt.setThinkingLevel(msg.level);
        this.broadcast({ type: "state", state: rt.snapshot() });
        break;
      }
      case "fork": {
        const rt = await this.mgr.ensureRuntime(wid, this.projectTrustResolver(ws));
        const selectedText = await rt.fork(msg.entryId, msg.position ?? "before");
        if (selectedText && rt.id) {
          this.broadcast({ type: "fork_prefill", workspaceId: rt.id, text: selectedText });
        }
        break;
      }
      case "navigate_tree": {
        const rt = await this.mgr.ensureRuntime(wid, this.projectTrustResolver(ws));
        const editorText = await rt.navigateTree(msg.targetId, msg.summarize);
        if (editorText && rt.id) {
          this.broadcast({ type: "composer_prefill", workspaceId: rt.id, text: editorText });
        }
        break;
      }
      case "resolve_project_trust":
        this.resolveProjectTrust(ws, msg);
        break;
      case "get_state": {
        await this.mgr.pruneMissing();
        this.broadcastWorkspaces();
        const rt = this.mgr.activeRuntime;
        if (rt) this.broadcast({ type: "state", state: rt.snapshot() });
        break;
      }
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  }

  private broadcastWorkspaces(): void {
    this.broadcast({
      type: "workspaces",
      workspaces: this.mgr.list(),
      activeId: this.mgr.activeIdOrNull,
    });
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      try {
        ws.send(data);
      } catch {
        // Drop dead sockets silently.
      }
    }
  }

  private send(ws: WSContext, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }

  private projectTrustResolver(ws: WSContext): ProjectTrustResolver {
    return async (request) => await this.requestProjectTrust(ws, request);
  }

  private requestProjectTrust(ws: WSContext, request: ProjectTrustRequest): Promise<ProjectTrustResolution> {
    for (const pending of this.pendingProjectTrust.values()) {
      if (pending.request.workspaceId === request.workspaceId) {
        return Promise.reject(new Error("Awaiting a project trust decision for this workspace."));
      }
    }
    const requestId = randomUUID();
    return new Promise<ProjectTrustResolution>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingProjectTrust.delete(requestId);
        reject(new Error("Project trust request timed out."));
      }, PROJECT_TRUST_TIMEOUT_MS);
      this.pendingProjectTrust.set(requestId, { ws, request, resolve, reject, timeout });
      this.send(ws, { type: "project_trust_request", requestId, workspaceId: request.workspaceId, cwd: request.cwd });
    });
  }

  private resolveProjectTrust(
    ws: WSContext,
    msg: Extract<ClientMessage, { type: "resolve_project_trust" }>,
  ): void {
    const pending = this.pendingProjectTrust.get(msg.requestId);
    if (!pending || pending.ws !== ws || pending.request.workspaceId !== msg.workspaceId) {
      throw new Error("Unknown or expired project trust request.");
    }
    if (typeof msg.trusted !== "boolean" || typeof msg.remember !== "boolean") {
      throw new Error("Invalid project trust response.");
    }
    clearTimeout(pending.timeout);
    this.pendingProjectTrust.delete(msg.requestId);
    pending.resolve({ trusted: msg.trusted, remember: msg.remember });
  }

  private cancelProjectTrustForWorkspace(workspaceId: string): void {
    for (const [requestId, pending] of this.pendingProjectTrust) {
      if (pending.request.workspaceId !== workspaceId) continue;
      clearTimeout(pending.timeout);
      this.pendingProjectTrust.delete(requestId);
      pending.reject(new Error("Project trust request was cancelled because the workspace was closed."));
    }
  }
}

function preparePrompt(text: string, attachments: PromptAttachment[]): {
  text: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
} {
  if (attachments.length === 0) return { text };

  const fileBlocks: string[] = [];
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];

  for (const attachment of attachments) {
    if (attachment.type === "text") {
      fileBlocks.push(`<file name="${escapeFileName(attachment.name)}">\n${attachment.text}\n</file>`);
    } else {
      images.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
      fileBlocks.push(`<file name="${escapeFileName(attachment.name)}"></file>`);
    }
  }

  const body = text.trim();
  const fileText = fileBlocks.join("\n");
  return {
    text: body ? `${fileText}\n\n${body}` : fileText,
    images: images.length > 0 ? images : undefined,
  };
}

function escapeFileName(name: string): string {
  return name.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
