import type { TranscriptItem } from "@protocol";

/**
 * Live event → transcript folding.
 *
 * The server hydrates history into `TranscriptItem[]` (see server transcript.ts);
 * this module produces the *same* item shapes from the live Pi event stream, so
 * a streaming turn and a hydrated one render identically.
 *
 * Streaming an assistant turn interleaves thinking and text blocks, each keyed
 * by a `contentIndex`. We keep a per-message map from contentIndex → item id so
 * deltas land in the right item. `reset()` is called at each message boundary.
 */
export interface StreamCursor {
  /** contentIndex → transcript item id, for the message being streamed. */
  blocks: Map<number, string>;
  currentMessageId?: string;
}

export function newCursor(): StreamCursor {
  return { blocks: new Map() };
}

let seq = 0;
const liveId = () => `l${seq++}`;

type Setter = (fn: (items: TranscriptItem[]) => TranscriptItem[]) => void;

/**
 * Fold one raw Pi event into the transcript. Returns true if the event implies
 * a streaming-state change the caller may want to reflect (agent_start/settled).
 *
 * Defensive about shapes: the SDK union is large and may grow, so unrecognized
 * events are ignored rather than throwing.
 */
export function applyEvent(
  event: unknown,
  setItems: Setter,
  cursor: StreamCursor,
): "start" | "settled" | null {
  const e = event as { type?: string; [k: string]: unknown };
  switch (e.type) {
    case "agent_start":
      return "start";

    case "agent_end":
      cursor.blocks.clear();
      cursor.currentMessageId = undefined;
      return null;

    case "agent_settled":
      return "settled";

    case "message_start":
      cursor.blocks.clear();
      {
        const message = (e as { message?: { id?: unknown; role?: unknown } }).message;
        const fallbackId = (e as { messageId?: unknown }).messageId;
        cursor.currentMessageId =
          typeof message?.id === "string"
            ? message.id
            : typeof fallbackId === "string"
              ? fallbackId
              : undefined;
      }
      return null;

    case "message_update": {
      const ev = (e as {
        assistantMessageEvent?: {
          type?: string;
          contentIndex?: number;
          delta?: string;
        };
      }).assistantMessageEvent;
      if (!ev || typeof ev.contentIndex !== "number") return null;
      const idx = ev.contentIndex;

      switch (ev.type) {
        case "text_start": {
          const id = liveId();
          cursor.blocks.set(idx, id);
          setItems((items) => [
            ...items,
            {
              id,
              sourceEntryId: cursor.currentMessageId,
              kind: "assistant",
              text: "",
            },
          ]);
          break;
        }
        case "text_delta": {
          const id = cursor.blocks.get(idx);
          if (id && ev.delta) appendText(setItems, id, ev.delta);
          break;
        }
        case "thinking_start": {
          const id = liveId();
          cursor.blocks.set(idx, id);
          setItems((items) => [
            ...items,
            {
              id,
              sourceEntryId: cursor.currentMessageId,
              kind: "reasoning",
              text: "",
              activity: "reasoning",
            },
          ]);
          break;
        }
        case "thinking_delta": {
          const id = cursor.blocks.get(idx);
          if (id && ev.delta) appendText(setItems, id, ev.delta);
          break;
        }
      }
      return null;
    }

    case "tool_execution_start": {
      const name = (e as { toolName?: string }).toolName ?? "tool";
      const args = (e as { args?: unknown }).args;
      setItems((items) => [
        ...items,
        {
          id: liveId(),
          sourceEntryId:
            typeof (e as { messageId?: unknown }).messageId === "string"
              ? String((e as { messageId?: unknown }).messageId)
              : undefined,
          kind: "tool",
          toolName: name,
          text: formatToolCall(name, args),
          activity: "tool",
        },
      ]);
      break;
    }

    case "tool_execution_end": {
      const name = (e as { toolName?: string }).toolName ?? "tool";
      const isError = (e as { isError?: boolean }).isError === true;
      const result = (e as { result?: unknown }).result;
      const text = resultToText(result);
      if (text) {
        setItems((items) => [
          ...items,
          {
            id: liveId(),
            sourceEntryId:
              typeof (e as { messageId?: unknown }).messageId === "string"
                ? String((e as { messageId?: unknown }).messageId)
                : undefined,
            kind: "tool",
            toolName: name,
            text: `${name} → ${truncate(text, 600)}`,
            activity: isError ? "error" : "tool",
            isError,
          },
        ]);
      }
      break;
    }

    case "compaction_start":
      setItems((items) => [
        ...items,
        { id: liveId(), kind: "system", text: "Compacting context…", activity: "system" },
      ]);
      break;

    case "compaction_end":
      {
        const errorMessage = (e as { errorMessage?: unknown }).errorMessage;
        const aborted = (e as { aborted?: unknown }).aborted === true;
        const willRetry = (e as { willRetry?: unknown }).willRetry === true;
        const text =
          typeof errorMessage === "string" && errorMessage
            ? `Compaction failed: ${errorMessage}`
            : aborted
              ? "Compaction aborted."
              : willRetry
                ? "Context compacted. Retrying prompt."
                : "Context compacted.";
        setItems((items) => [
          ...items,
          {
            id: liveId(),
            kind: "system",
            text,
            activity: typeof errorMessage === "string" && errorMessage ? "error" : "system",
            isError: typeof errorMessage === "string" && errorMessage.length > 0,
          },
        ]);
      }
      break;

    case "auto_retry_start": {
      const attempt = numberField(e.attempt);
      const maxAttempts = numberField(e.maxAttempts);
      const delayMs = numberField(e.delayMs);
      const errorMessage = typeof e.errorMessage === "string" ? e.errorMessage : "provider request failed";
      const attemptText =
        attempt != null && maxAttempts != null
          ? `attempt ${attempt}/${maxAttempts}`
          : attempt != null
            ? `attempt ${attempt}`
            : "retry";
      const delayText = delayMs != null ? ` in ${formatDelay(delayMs)}` : "";
      setItems((items) => [
        ...items,
        {
          id: liveId(),
          kind: "system",
          text: `Provider retry scheduled (${attemptText}${delayText}): ${truncate(errorMessage, 900)}`,
          activity: "error",
          isError: true,
        },
      ]);
      break;
    }

    case "auto_retry_end": {
      const success = (e as { success?: unknown }).success === true;
      const attempt = numberField(e.attempt);
      const finalError = typeof e.finalError === "string" ? e.finalError : "";
      setItems((items) => [
        ...items,
        {
          id: liveId(),
          kind: "system",
          text: success
            ? `Provider retry succeeded${attempt != null ? ` on attempt ${attempt}` : ""}.`
            : `Provider retry failed${attempt != null ? ` after attempt ${attempt}` : ""}: ${truncate(finalError || "unknown error", 900)}`,
          activity: success ? "system" : "error",
          isError: !success,
        },
      ]);
      break;
    }

    case "extension_error": {
      const message =
        typeof e.message === "string"
          ? e.message
          : typeof e.error === "string"
            ? e.error
            : "extension error";
      setItems((items) => [
        ...items,
        {
          id: liveId(),
          kind: "system",
          text: `Extension error: ${truncate(message, 900)}`,
          activity: "error",
          isError: true,
        },
      ]);
      break;
    }
  }
  return null;
}

function appendText(setItems: Setter, id: string, delta: string): void {
  setItems((items) =>
    items.map((it) => (it.id === id ? { ...it, text: it.text + delta } : it)),
  );
}

function formatToolCall(name: string, args: unknown): string {
  if (args && typeof args === "object") {
    try {
      return `${name}(${truncate(JSON.stringify(args), 300)})`;
    } catch {
      /* fall through */
    }
  }
  return `${name}()`;
}

function resultToText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((b) =>
        b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "",
      )
      .join("");
  }
  if (typeof result === "object" && "output" in result) {
    return String((result as { output: unknown }).output);
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatDelay(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 100) / 10}s`;
}
