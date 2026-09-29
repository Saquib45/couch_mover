#!/usr/bin/env node

const HTTP_BASE = (process.env.COUCH_MOVERS_SERVER_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const TIMEOUT_MS = 8_000;
const clients = new Set();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Client {
  constructor(name, url) {
    this.name = name;
    this.url = url;
    this.socket = null;
    this.messages = [];
    this.waiters = new Set();
    this.sequence = 1;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    clients.add(this);
    this.socket.addEventListener("message", (event) => {
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
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} could not connect`)), TIMEOUT_MS);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`${this.name} WebSocket failed`));
      }, { once: true });
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  input(message) {
    this.send({ ...message, seq: this.sequence++ });
  }

  waitFor(predicate, description, timeoutMs = TIMEOUT_MS) {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      if (predicate(this.messages[index])) return Promise.resolve(this.messages[index]);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`${this.name} timed out waiting for ${description}`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  latestSnapshot() {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      if (this.messages[index]?.type === "snapshot") return this.messages[index];
    }
    return null;
  }

  close() {
    this.socket?.close(1000, "ladder smoke complete");
    clients.delete(this);
  }
}

async function fetchJson(path, init = {}) {
  const response = await fetch(`${HTTP_BASE}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await response.text();
  assert(response.ok, `${init.method ?? "GET"} ${path} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function socketUrl(roomCode) {
  const url = new URL(HTTP_BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/rooms/${roomCode}/websocket`;
  return url.toString();
}

function averagePlayerY(snapshot) {
  return snapshot.players.reduce((sum, player) => sum + player.y, 0) / snapshot.players.length;
}

async function runStep(label, work) {
  process.stdout.write(`  ${label} ... `);
  await work();
  console.log("PASS");
}

async function main() {
  console.log("COUCH MOVERS live ladder regression");
  await runStep("authoritative server is healthy", async () => {
    const health = await fetchJson("/health");
    assert(health?.ok && health.tickRate === 25, "unexpected health response");
  });

  const { roomCode } = await fetchJson("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const first = new Client("player 1", socketUrl(roomCode));
  const second = new Client("player 2", socketUrl(roomCode));
  await Promise.all([first.connect(), second.connect()]);
  first.send({ type: "hello", profile: { color: "tomato", hat: "hardhat" } });
  second.send({ type: "hello", profile: { color: "sky", hat: "cap" } });
  const [firstWelcome, secondWelcome] = await Promise.all([
    first.waitFor((message) => message.type === "welcome", "welcome"),
    second.waitFor((message) => message.type === "welcome", "welcome"),
  ]);
  await first.waitFor((message) => message.type === "room_state" && message.room.players.length === 2, "two-player room");
  const firstIsHost = firstWelcome.room.players.some((player) => player.id === firstWelcome.playerId && player.host);
  const host = firstIsHost ? first : second;

  await runStep("all ladder stages publish paired vertical floor data", async () => {
    for (const expected of [
      { levelIndex: 5, floorCount: 2, ladderCount: 2 },
      { levelIndex: 6, floorCount: 3, ladderCount: 4 },
      { levelIndex: 8, floorCount: 3, ladderCount: 4 },
    ]) {
      host.send({ type: "select_level", levelIndex: expected.levelIndex });
      const state = await host.waitFor(
        (message) => message.type === "level_state" && message.level.number === expected.levelIndex + 1,
        `stage ${expected.levelIndex + 1}`,
      );
      assert(state.level.floorCount === expected.floorCount, `stage ${expected.levelIndex + 1} floor count mismatch`);
      assert(state.level.ladders?.length === expected.ladderCount, `stage ${expected.levelIndex + 1} ladder count mismatch`);
      assert(state.level.ladders.every((ladder) => ladder.height > ladder.width), "a ladder was not vertical");
    }
  });

  host.send({ type: "select_level", levelIndex: 5 });
  await host.waitFor((message) => message.type === "level_state" && message.level.number === 6, "two-floor stage");
  first.send({ type: "set_ready", ready: true });
  second.send({ type: "set_ready", ready: true });
  await host.waitFor(
    (message) => message.type === "room_state" && message.room.players.length === 2 && message.room.players.every((player) => player.ready),
    "both players ready",
  );
  host.send({ type: "start_game" });
  await host.waitFor((message) => message.type === "snapshot" && message.phase === "playing", "playing stage", 12_000);

  first.input({ type: "grip_toggle" });
  second.input({ type: "grip_toggle" });
  await host.waitFor(
    (message) => message.type === "snapshot" && message.players.length === 2 && message.players.every((player) => player.gripped),
    "both ropes gripped",
  );

  await runStep("up input cannot climb outside the ladder shaft", async () => {
    const before = host.latestSnapshot();
    first.input({ type: "move", x: 0, y: -1 });
    second.input({ type: "move", x: 0, y: -1 });
    await delay(1_200);
    const after = host.latestSnapshot();
    assert(after && before, "missing climb-gate snapshots");
    assert(averagePlayerY(after) >= averagePlayerY(before) - 6, "crew gained height outside the ladder");
  });

  await runStep("gripped crew climbs after reaching the vertical ladder", async () => {
    first.input({ type: "move", x: 1, y: 0 });
    second.input({ type: "move", x: 1, y: 0 });
    const linedUp = await host.waitFor(
      (message) => message.type === "snapshot" && message.couch.x >= 590 &&
        message.players.every((player) => Math.abs(player.x - 640) <= 170),
      "crew lined up under ladder",
      25_000,
    );
    first.input({ type: "move", x: 0, y: -1 });
    second.input({ type: "move", x: 0, y: -1 });
    await host.waitFor(
      (message) => message.type === "snapshot" && averagePlayerY(message) <= averagePlayerY(linedUp) - 35 && message.couch.y < linedUp.couch.y - 12,
      "crew and couch moving upward in ladder",
      12_000,
    );
    first.input({ type: "move", x: 0, y: 0 });
    second.input({ type: "move", x: 0, y: 0 });
  });

  await runStep("completed ladder delivery immediately exposes the next job", async () => {
    first.input({ type: "move", x: 0, y: -1 });
    second.input({ type: "move", x: 0, y: -1 });
    await host.waitFor(
      (message) => message.type === "snapshot" && message.couch.y <= 245,
      "couch clearing the second-floor hatch",
      18_000,
    );
    first.input({ type: "move", x: 1, y: 0 });
    second.input({ type: "move", x: 1, y: 0 });
    await host.waitFor(
      (message) => message.type === "snapshot" && message.couch.x >= 1_010,
      "couch reaching the delivery platform",
      20_000,
    );
    first.input({ type: "move", x: 0, y: 0 });
    second.input({ type: "move", x: 0, y: 0 });
    const completed = await host.waitFor(
      (message) => message.type === "snapshot" && message.phase === "complete",
      "completed stage snapshot",
      15_000,
    );
    assert(completed.deliveryProgress === 1, "delivery did not hold at 100 percent");
    await host.waitFor(
      (message) => message.type === "room_state" && message.room.phase === "complete" && message.room.result,
      "result state used by the completion overlay",
    );
    host.send({ type: "next_level" });
    await host.waitFor(
      (message) => message.type === "level_state" && message.level.number === 7,
      "next-stage level state",
    );
    await host.waitFor(
      (message) => message.type === "room_state" && message.room.levelIndex === 6 && message.room.phase === "countdown",
      "next-stage countdown",
    );
  });

  first.close();
  second.close();
  console.log("LIVE LADDER REGRESSION PASS");
}

main().catch((error) => {
  for (const client of clients) client.close();
  console.error(error);
  process.exitCode = 1;
});
