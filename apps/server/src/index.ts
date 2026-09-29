import {
  ROOM_CODE_LENGTH,
  SERVER_TICK_RATE,
  type CreateRoomResponse,
} from "@couch-movers/shared";

import { RoomDurableObject } from "./room";

export { RoomDurableObject };

export interface Env {
  ROOMS: DurableObjectNamespace;
}

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROOM_ROUTE = /^\/api\/rooms\/([A-Z]{6})\/websocket$/i;
const ROOM_INFO_ROUTE = /^\/api\/rooms\/([A-Z]{6})$/i;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(corsHeaders)) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function randomRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);

  let code = "";
  for (const byte of bytes) {
    code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
  }
  return code;
}

async function createRoom(env: Env): Promise<Response> {
  // A deterministic Durable Object name gives every room exactly one authority.
  // Initialization is conditional, so a rare random-code collision is harmless.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const roomCode = randomRoomCode();
    const id = env.ROOMS.idFromName(roomCode);
    const stub = env.ROOMS.get(id);
    const result = await stub.fetch("https://room.internal/initialize", {
      method: "POST",
      headers: { "X-Room-Code": roomCode },
    });

    if (result.status === 201) {
      const response: CreateRoomResponse = { roomCode };
      return json(response, 201, { "Cache-Control": "no-store" });
    }
    if (result.status !== 409) {
      return json(
        { error: "ROOM_CREATE_FAILED", message: "Could not create the room." },
        503,
      );
    }
  }

  return json(
    { error: "ROOM_CODE_EXHAUSTED", message: "Could not reserve a room code. Try again." },
    503,
  );
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "couch-movers-server",
        tickRate: SERVER_TICK_RATE,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/rooms") {
      return createRoom(env);
    }

    const infoMatch = ROOM_INFO_ROUTE.exec(url.pathname);
    if (infoMatch && request.method === "GET") {
      const roomCode = infoMatch[1]?.toUpperCase();
      if (!roomCode) {
        return json({ error: "BAD_ROOM_CODE", message: "Room codes contain six letters." }, 400);
      }
      const id = env.ROOMS.idFromName(roomCode);
      const status = await env.ROOMS.get(id).fetch("https://room.internal/status");
      return status.ok
        ? json({ exists: true }, 200, { "Cache-Control": "no-store" })
        : json({ error: "ROOM_NOT_FOUND", message: "That room code does not exist." }, 404, { "Cache-Control": "no-store" });
    }

    const match = ROOM_ROUTE.exec(url.pathname);
    if (match) {
      if (request.method !== "GET") {
        return json({ error: "METHOD_NOT_ALLOWED", message: "Use a WebSocket GET request." }, 405);
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "UPGRADE_REQUIRED", message: "A WebSocket upgrade is required." }, 426);
      }

      const roomCode = match[1]?.toUpperCase();
      if (!roomCode) {
        return json({ error: "BAD_ROOM_CODE", message: "Room codes contain six letters." }, 400);
      }

      const id = env.ROOMS.idFromName(roomCode);
      return env.ROOMS.get(id).fetch(request);
    }

    return json({ error: "NOT_FOUND", message: "Route not found." }, 404);
  },
};

export default worker;
