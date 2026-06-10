import { useCallback, useEffect, useRef, useState } from "react";

import type { ClientMessage, ServerMessage } from "@protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

/**
 * Single WebSocket connection to the pi-webui server.
 *
 * Auto-reconnects with a small backoff. Exposes a `send` for ClientMessages and
 * delivers every ServerMessage to the provided handler. The handler is kept in
 * a ref so re-renders don't tear down the socket.
 */
export function usePiSocket(onMessage: (msg: ServerMessage) => void) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const socketRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      socketRef.current = ws;
      setStatus("connecting");

      ws.onopen = () => setStatus("open");
      ws.onmessage = (evt) => {
        try {
          handlerRef.current(JSON.parse(evt.data as string) as ServerMessage);
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        setStatus("closed");
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  return { status, send };
}
