#!/usr/bin/env node

/**
 * Live four-player regression for passive damage at the start of a job.
 * Geometry audits catch authored overlaps; this catches physics settling,
 * gravity, cat patrols, and collision callbacks that still alter the score.
 */

const HTTP_BASE = (process.env.COUCH_MOVERS_SERVER_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const DEFAULT_TIMEOUT_MS = 7_000;
const PLAYING_TIMEOUT_MS = 13_000;
const DEFAULT_STAGES_TO_CHECK = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const STAGES_TO_CHECK = process.env.COUCH_MOVERS_STAGE_NUMBERS
  ? process.env.COUCH_MOVERS_STAGE_NUMBERS.split(",").map((value) => Number(value.trim()) - 1)
  : DEFAULT_STAGES_TO_CHECK;
const COLORS = ["tomato", "sunny", "mint", "sky"];
const HATS = ["cap", "hardhat", "cowboy", "crown"];
const openClients = new Set();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TestClient {
  constructor(name, url) {
    this.name = name;
    this.url = url;
    this.socket = null;
    this.messages = [];
    this.waiters = new Set();
    this.intentionalClose = false;
  }

  async connect() {
    assert(typeof globalThis.WebSocket === "function", "Node 22+ is required");
    const socket = new WebSocket(this.url);
    this.socket = socket;
    openClients.add(this);
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    });
    socket.addEventListener("close", (event) => {
      if (this.intentionalClose) return;
      this.rejectWaiters(new Error(`${this.name} disconnected unexpectedly (${event.code})`));
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} could not connect`)), DEFAULT_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`${this.name} WebSocket failed to open`));
      }, { once: true });
    });
  }

  send(message) {
    assert(this.socket?.readyState === WebSocket.OPEN, `${this.name} is not connected`);
    this.socket.send(JSON.stringify(message));
  }

  waitFor(predicate, description, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`${this.name} timed out waiting for ${description}`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  rejectWaiters(error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  async close() {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      openClients.delete(this);
      return;
    }
    this.intentionalClose = true;
    const closed = new Promise((resolve) => this.socket.addEventListener("close", resolve, { once: true }));
    this.socket.close(1000, "spawn safety check complete");
    await Promise.race([closed, delay(500)]);
    openClients.delete(this);
  }
}

async function fetchJson(path, init = {}) {
  const response = await fetch(`${HTTP_BASE}${path}`, { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  const text = await response.text();
  assert(response.ok, `${init.method ?? "GET"} ${path} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function websocketUrl(roomCode) {
  const url = new URL(HTTP_BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/rooms/${roomCode}/websocket`;
  return url.toString();
}

async function checkStage(levelIndex) {
  const { roomCode } = await fetchJson("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const clients = Array.from({ length: 4 }, (_, index) => new TestClient(`stage ${levelIndex + 1} player ${index + 1}`, websocketUrl(roomCode)));
  try {
    await Promise.all(clients.map((client) => client.connect()));
    clients.forEach((client, index) => client.send({
      type: "hello",
      profile: { color: COLORS[index], hat: HATS[index] },
    }));
    await Promise.all(clients.map((client) => client.waitFor((message) => message.type === "welcome", "welcome")));
    const host = clients.find((client) => client.messages.some((message) => (
      message.type === "welcome" && message.room.players.some((player) => player.host && player.id === message.playerId)
    )));
    assert(host, `stage ${levelIndex + 1} did not assign a host`);
    await host.waitFor(
      (message) => message.type === "room_state" && message.room.players.filter((player) => !player.spectator).length === 4,
      "four-player room state",
    );
    host.send({ type: "select_level", levelIndex });
    const levelState = await host.waitFor(
      (message) => message.type === "level_state" && message.level.number === levelIndex + 1,
      "selected level state",
    );
    clients.forEach((client) => client.send({ type: "set_ready", ready: true }));
    await host.waitFor(
      (message) => message.type === "room_state" && message.room.players.filter((player) => !player.spectator).every((player) => player.ready),
      "ready crew",
    );
    host.send({ type: "start_game" });
    await host.waitFor(
      (message) => message.type === "snapshot" && message.phase === "playing",
      "playing snapshot",
      PLAYING_TIMEOUT_MS,
    );
    const settled = await host.waitFor(
      (message) => message.type === "snapshot" && message.phase === "playing" && message.elapsedMs >= 1_000,
      "one second of idle physics",
      PLAYING_TIMEOUT_MS,
    );
    assert(settled.couch.hp === settled.couch.maxHp, `${levelState.level.title}: passive couch damage (${settled.couch.hp} HP)`);
    assert(settled.score.itemsPenalty === 0, `${levelState.level.title}: passive item penalty ($${settled.score.itemsPenalty})`);
    assert(settled.breakables.every((item) => !item.broken), `${levelState.level.title}: a prop broke before anyone moved`);
    return levelState.level.title;
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
}

async function main() {
  console.log("COUCH MOVERS spawn-safety regression");
  console.log(`Target: ${HTTP_BASE}`);
  const health = await fetchJson("/health");
  assert(health?.ok === true, "server health response was not OK");
  for (const levelIndex of STAGES_TO_CHECK) {
    process.stdout.write(`  Stage ${String(levelIndex + 1).padStart(2, "0")} ... `);
    const title = await checkStage(levelIndex);
    console.log(`PASS ${title}`);
  }
  console.log(`SPAWN SAFETY PASS: ${STAGES_TO_CHECK.length} affected/new stages, four players, zero passive penalties`);
}

main().catch((error) => {
  for (const client of openClients) void client.close();
  console.error(`FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
