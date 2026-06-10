import type { WSContext } from "hono/ws";

import type { WorkspaceManager } from "./workspace-manager.ts";
import type { ClientMessage, PromptAttachment, ServerMessage } from "./protocol.ts";

/**
 * Bridges Pi event streams to WebSocket clients and routes commands back.
 */
export class WsBridge {
  private clients = new Set<WSContext>();

  constructor(private readonly mgr: WorkspaceManager) {
    mgr.onAgentEvent = (workspaceId, event) => {
      this.broadcast({ type: "agent_event", workspaceId, event });
      if ((event as { type?: string }).type === "queue_update") {
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
  }

  async handle(ws: WSContext, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(ws, { type: "error", message: "invalid JSON" });
      return;
    }
    try {
      await this.dispatch(msg);
    } catch (err) {
      this.send(ws, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async dispatch(msg: ClientMessage): Promise<void> {
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
        await this.mgr.switchSession(wid, msg.sessionPath);
        break;
      case "new_session":
        await this.mgr.newSession(wid);
        break;
      case "clone_session":
        await this.mgr.cloneSession(wid, msg.sessionPath);
        break;
      case "delete_sessions":
        await this.mgr.deleteSessions(wid, msg.sessionPaths);
        break;
      case "reload_session":
        await this.mgr.reloadSession(wid);
        break;

      // ---- session-scoped operations (need runtime) ----
      case "prompt": {
        const rt = await this.mgr.ensureRuntime(wid);
        const prepared = preparePrompt(msg.text, msg.attachments ?? []);
        await rt.prompt(prepared.text, msg.streamingBehavior, prepared.images);
        break;
      }
      case "abort": {
        const rt = await this.mgr.ensureRuntime(wid);
        await rt.abort();
        break;
      }
      case "clear_queue": {
        const rt = await this.mgr.ensureRuntime(wid);
        rt.clearQueue();
        this.broadcast({ type: "state", state: rt.snapshot() });
        break;
      }
      case "compact": {
        const rt = await this.mgr.ensureRuntime(wid);
        await rt.compact(msg.customInstructions);
        break;
      }
      case "set_model": {
        const rt = await this.mgr.ensureRuntime(wid);
        await rt.setModel(msg.provider, msg.modelId);
        // Model changed — push fresh snapshot.
        this.broadcast({ type: "state", state: rt.snapshot() });
        break;
      }
      case "set_session_name": {
        const rt = await this.mgr.ensureRuntime(wid);
        rt.setSessionName(msg.name);
        this.broadcast({ type: "state", state: rt.snapshot() });
        break;
      }
      case "set_thinking_level": {
        const rt = await this.mgr.ensureRuntime(wid);
        rt.setThinkingLevel(msg.level);
        this.broadcast({ type: "state", state: rt.snapshot() });
        break;
      }
      case "fork": {
        const rt = await this.mgr.ensureRuntime(wid);
        const selectedText = await rt.fork(msg.entryId, msg.position ?? "before");
        if (selectedText && rt.id) {
          this.broadcast({ type: "fork_prefill", workspaceId: rt.id, text: selectedText });
        }
        break;
      }
      case "navigate_tree": {
        const rt = await this.mgr.ensureRuntime(wid);
        await rt.navigateTree(msg.targetId, msg.summarize);
        break;
      }
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
