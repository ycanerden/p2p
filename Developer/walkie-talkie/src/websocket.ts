import { messageEvents, joinRoom, getRoomPasswordHash } from "./rooms.js";

// ── WebSocket handler for Bun ─────────────────────────────────────────────
// Provides real-time push messaging alongside SSE.
// Connect: ws://host/ws?room=CODE&name=YOUR_NAME
//
// Unlike OpenAgents (HTTP polling at 2-15s intervals), Mesh pushes
// messages instantly over WebSocket with SSE as fallback.

interface WsData {
  room: string;
  name: string;
}

const wsClients = new Map<WebSocket, WsData>();

export const websocket = {
  open(ws: WebSocket) {
    const data = (ws as any).data as WsData;
    if (!data?.room || !data?.name) {
      ws.close(4000, "Missing room or name");
      return;
    }

    joinRoom(data.room, data.name);
    wsClients.set(ws, data);
    console.log(`[ws] ${data.name} connected to ${data.room}`);

    // Listen for room messages
    const onMessage = (event: any) => {
      if (event.room_code !== data.room) return;
      if (event.message.from === data.name) return;

      const isTargeted = event.message.to !== undefined;
      const isForMe = isTargeted ? event.message.to === data.name : true;
      if (!isForMe) return;

      try {
        ws.send(JSON.stringify({
          event: "message",
          data: event.message,
        }));
      } catch {}
    };

    messageEvents.on("message", onMessage);
    (ws as any)._meshListener = onMessage;

    // Send welcome
    ws.send(JSON.stringify({
      event: "connected",
      data: { room: data.room, name: data.name, protocol: "mesh-ws-v1" },
    }));
  },

  message(ws: WebSocket, message: string | Buffer) {
    // Handle ping/pong keepalive from client
    try {
      const parsed = JSON.parse(message.toString());
      if (parsed.type === "ping") {
        ws.send(JSON.stringify({ event: "pong", ts: Date.now() }));
      }
    } catch {}
  },

  close(ws: WebSocket) {
    const data = wsClients.get(ws);
    if (data) {
      console.log(`[ws] ${data.name} disconnected from ${data.room}`);
      const listener = (ws as any)._meshListener;
      if (listener) messageEvents.off("message", listener);
      wsClients.delete(ws);
    }
  },
};

// Upgrade HTTP request to WebSocket
export function handleWsUpgrade(req: Request, server: any): Response | undefined {
  const url = new URL(req.url);
  if (url.pathname !== "/ws") return undefined;

  const room = url.searchParams.get("room");
  const name = url.searchParams.get("name");
  if (!room || !name) {
    return new Response(JSON.stringify({ error: "Missing ?room=CODE&name=YOUR_NAME" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Password check
  const hash = getRoomPasswordHash(room);
  if (hash) {
    const accessToken = url.searchParams.get("access_token");
    if (!accessToken || accessToken !== `${room}.${hash}`) {
      return new Response(JSON.stringify({ error: "room_protected" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const upgraded = server.upgrade(req, { data: { room, name } });
  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }
  return undefined;
}

export function getWsClientCount(): number {
  return wsClients.size;
}
