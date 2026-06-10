import type { TranscriptItem } from "./protocol.ts";

/**
 * Normalize Pi's stored `AgentMessage[]` (the active-branch history) into the
 * flat `TranscriptItem[]` the UI renders. This must produce the same item
 * shapes the live event stream produces (see web/src/transcript.ts), so a
 * hydrated session looks identical to one built live.
 *
 * Stored message shapes (from the Pi SDK):
 *  - user:              { role: "user", content: string | ContentBlock[] }
 *  - assistant:         { role: "assistant", content: (text|thinking|toolCall)[] }
 *  - toolResult:        { role: "toolResult", toolName, content, isError }
 *  - bashExecution:     { role: "bashExecution", command, output, exitCode }
 *  - custom:            { role: "custom", content, display }
 *  - branchSummary:     { role: "branchSummary", summary }
 *  - compactionSummary: { role: "compactionSummary", summary }
 *
 * Content blocks: { type: "text", text } | { type: "thinking", thinking }
 *               | { type: "toolCall", name, arguments } | { type: "image", ... }
 *
 * The mapping is deliberately defensive: the SDK union is large and may grow,
 * so unknown shapes degrade to a readable system line rather than throwing.
 */
export function messagesToTranscript(messages: unknown[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let seq = 0;
  const id = () => `h${seq++}`;

  for (const raw of messages) {
    const entry = raw as {
      type?: string;
      id?: string;
      message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean; [k: string]: unknown };
      [k: string]: unknown;
    };

    if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      const sourceEntryId = typeof entry.id === "string" ? entry.id : undefined;
      switch (msg.role) {
        case "user": {
          const text = contentToText(msg.content);
          if (text.trim()) items.push({ id: id(), sourceEntryId, kind: "user", text });
          break;
        }
        case "assistant": {
          const blocks = Array.isArray(msg.content) ? msg.content : [];
          for (const b of blocks as Array<Record<string, unknown>>) {
            if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
              items.push({ id: id(), sourceEntryId, kind: "assistant", text: b.text });
            } else if (
              b.type === "thinking" &&
              typeof b.thinking === "string" &&
              b.thinking.trim()
            ) {
              items.push({
                id: id(),
                sourceEntryId,
                kind: "reasoning",
                text: b.thinking,
                activity: "reasoning",
              });
            } else if (b.type === "toolCall") {
              const name = typeof b.name === "string" ? b.name : "tool";
              items.push({
                id: id(),
                sourceEntryId,
                kind: "tool",
                toolName: name,
                text: formatToolCall(name, b.arguments),
                activity: "tool",
              });
            }
          }
          break;
        }
        case "toolResult": {
          const name = typeof msg.toolName === "string" ? msg.toolName : "tool";
          const isError = msg.isError === true;
          const text = contentToText(msg.content);
          items.push({
            id: id(),
            sourceEntryId,
            kind: "tool",
            toolName: name,
            text: `${name} → ${truncate(text, 600)}`,
            activity: isError ? "error" : "tool",
            isError,
          });
          break;
        }
        case "bashExecution": {
          const cmd = String(msg.command ?? "");
          const out = String(msg.output ?? "");
          const code = msg.exitCode;
          items.push({
            id: id(),
            sourceEntryId,
            kind: "tool",
            toolName: "bash",
            text: `$ ${cmd}\n${truncate(out, 600)}${
              code != null ? `\n(exit ${code})` : ""
            }`,
            activity: typeof code === "number" && code !== 0 ? "error" : "tool",
            isError: typeof code === "number" && code !== 0,
          });
          break;
        }
        case "custom": {
          if (msg.display === false) break;
          const text = contentToText(msg.content);
          if (text.trim()) items.push({ id: id(), sourceEntryId, kind: "system", text, activity: "system" });
          break;
        }
        default:
          break;
      }
      continue;
    }

    const m = raw as { role?: string; id?: string; [k: string]: unknown };
    const sourceEntryId = typeof m.id === "string" ? m.id : undefined;
    switch (m.role ?? entry.type) {
      case "user": {
        const text = contentToText(m.content);
        if (text.trim()) items.push({ id: id(), sourceEntryId, kind: "user", text });
        break;
      }
      case "assistant": {
        const blocks = Array.isArray(m.content) ? m.content : [];
        for (const b of blocks as Array<Record<string, unknown>>) {
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            items.push({ id: id(), sourceEntryId, kind: "assistant", text: b.text });
          } else if (
            b.type === "thinking" &&
            typeof b.thinking === "string" &&
            b.thinking.trim()
          ) {
            items.push({
              id: id(),
              sourceEntryId,
              kind: "reasoning",
              text: b.thinking,
              activity: "reasoning",
            });
          } else if (b.type === "toolCall") {
            const name = typeof b.name === "string" ? b.name : "tool";
            items.push({
              id: id(),
              sourceEntryId,
              kind: "tool",
              toolName: name,
              text: formatToolCall(name, b.arguments),
              activity: "tool",
            });
          }
        }
        break;
      }
      case "toolResult": {
        const name = typeof m.toolName === "string" ? m.toolName : "tool";
        const isError = m.isError === true;
        const text = contentToText(m.content);
        items.push({
          id: id(),
          sourceEntryId,
          kind: "tool",
          toolName: name,
          text: `${name} → ${truncate(text, 600)}`,
          activity: isError ? "error" : "tool",
          isError,
        });
        break;
      }
      case "bashExecution": {
        const cmd = String(m.command ?? "");
        const out = String(m.output ?? "");
        const code = m.exitCode;
        items.push({
          id: id(),
          sourceEntryId,
          kind: "tool",
          toolName: "bash",
          text: `$ ${cmd}\n${truncate(out, 600)}${
            code != null ? `\n(exit ${code})` : ""
          }`,
          activity: typeof code === "number" && code !== 0 ? "error" : "tool",
          isError: typeof code === "number" && code !== 0,
        });
        break;
      }
      case "custom": {
        if (m.display === false) break;
        const text = contentToText(m.content);
        if (text.trim()) items.push({ id: id(), sourceEntryId, kind: "system", text, activity: "system" });
        break;
      }
      case "branchSummary":
      case "branch_summary": {
        items.push({
          id: id(),
          sourceEntryId,
          kind: "system",
          text: `Branch summary: ${truncate(String(m.summary ?? ""), 400)}`,
          activity: "system",
        });
        break;
      }
      case "compactionSummary":
      case "compaction": {
        items.push({
          id: id(),
          sourceEntryId,
          kind: "system",
          text: `Compaction summary: ${truncate(String(m.summary ?? ""), 400)}`,
          activity: "system",
        });
        break;
      }
      default:
        // Unknown / future message role — keep it visible but unobtrusive.
        break;
    }
  }

  return items;
}

/** Flatten a string or ContentBlock[] into plain text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "thinking" && typeof b.thinking === "string")
      parts.push(b.thinking);
    else if (b.type === "image") parts.push("[image]");
  }
  return parts.join("");
}

function formatToolCall(name: string, args: unknown): string {
  if (args && typeof args === "object") {
    try {
      const json = JSON.stringify(args);
      return `${name}(${truncate(json, 300)})`;
    } catch {
      /* fall through */
    }
  }
  return `${name}()`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
