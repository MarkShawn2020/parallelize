import { useEffect, useReducer, useState } from "react";
import { WS_PATH } from "../../src/core/api";
import type { SwarmEvent } from "../../src/core/types";
import { initialRunView, reduce, type RunView } from "./state";

export type ConnectionStatus = "connecting" | "live" | "offline";

const MAX_BACKOFF_MS = 5000;
const BASE_BACKOFF_MS = 250;

const reduceBatch = (s: RunView, batch: SwarmEvent[]): RunView => batch.reduce(reduce, s);

export function useRunStream(): { view: RunView; status: ConnectionStatus } {
  const [view, dispatch] = useReducer(reduceBatch, initialRunView);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let attempt = 0;
    let disposed = false;
    let queue: SwarmEvent[] = [];

    // A replay on connect can be thousands of events; apply them once per frame, not once each.
    const flush = () => {
      frame = 0;
      const batch = queue;
      queue = [];
      dispatch(batch);
    };

    const connect = () => {
      setStatus("connecting");
      const ws = new WebSocket(streamUrl());
      socket = ws;
      ws.onopen = () => {
        attempt = 0;
        setStatus("live");
      };
      ws.onmessage = (msg: MessageEvent<unknown>) => {
        const e = parseEvent(msg.data);
        if (!e) return;
        queue.push(e);
        if (!frame) frame = requestAnimationFrame(flush);
      };
      // onerror is always followed by onclose, which owns the retry.
      ws.onclose = () => {
        if (disposed) return;
        setStatus("offline");
        retry = setTimeout(connect, Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt));
        attempt += 1;
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      cancelAnimationFrame(frame);
      socket?.close();
    };
  }, []);

  return { view, status };
}

function streamUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${WS_PATH}`;
}

export function parseEvent(data: unknown): SwarmEvent | null {
  if (typeof data !== "string") return null;
  try {
    const v: unknown = JSON.parse(data);
    if (typeof v !== "object" || v === null) return null;
    const { type, runId } = v as { type?: unknown; runId?: unknown };
    return typeof type === "string" && typeof runId === "string" ? (v as SwarmEvent) : null;
  } catch {
    return null;
  }
}
