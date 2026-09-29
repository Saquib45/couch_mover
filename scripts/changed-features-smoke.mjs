#!/usr/bin/env node

/**
 * Focused regression test for the lobby stage selector and cat bounce.
 *
 * This intentionally does not repeat the full multiplayer smoke suite. It covers
 * only the features changed alongside the stage-selector/cat-direction fix:
 *   1. only the host can select each campaign stage while in the lobby;
 *   2. selecting a rope stage broadcasts its rope-climb LevelDefinition;
 *   3. a cat that collides with the couch reverses its travel direction.
 *
 * Requires a running local server and Node 22+:
 *   node scripts/changed-features-smoke.mjs
 */

const HTTP_BASE = (process.env.COUCH_MOVERS_SERVER_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const DEFAULT_TIMEOUT_MS = 6_000;
const CAT_COLLISION_TIMEOUT_MS = 45_000;
const EXPECTED_LEVELS = 12;
const CAT_LEVEL_INDEX = 3;
const ROPE_LEVEL_INDEX = 8;
const openClients = new Set();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeMessage(message) {
  if (message?.type === "snapshot") {
    return `snapshot:${message.phase}#${message.tick}@couch(${message.couch?.x?.toFixed?.(0) ?? "?"},${message.couch?.y?.toFixed?.(0) ?? "?"})`;
  }
  if (message?.type === "room_state") return `room_state:${message.room?.phase}:${message.room?.levelIndex}`;
  if (message?.type === "level_state") return `level_state:${message.level?.id ?? "?"}`;
  if (message?.type === "error") return `error:${message.code}`;
  return String(message?.type ?? message);
}

class TestClient {
  constructor(name, url) {
    this.name = name;
    this.url = url;
    this.socket = null;
    this.messages = [];
    this.waiters = new Set();
    this.inputSequence = 1;
    this.intentionalClose = false;
  }

  mark() {
    return this.messages.length;
  }

  async connect() {
    assert(typeof globalThis.WebSocket === "function", "Node 22+ is required (global WebSocket is unavailable)");
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
      const record = { index: this.messages.length, message };
      this.messages.push(record);
      for (const waiter of [...this.waiters]) {
        if (record.index < waiter.after || !waiter.predicate(message)) continue;
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
      const timer = setTimeout(() => reject(new Error(`${this.name} could not connect to ${this.url}`)), DEFAULT_TIMEOUT_MS);
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

  sendInput(message) {
    this.send({ ...message, seq: this.inputSequence++ });
  }

  waitFor(predicate, description, { after = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    for (const record of this.messages) {
      if (record.index >= after && predicate(record.message)) return Promise.resolve(record.message);
    }
    return new Promise((resolve, reject) => {
      const waiter = { after, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        const recent = this.messages.slice(-7).map(({ message }) => describeMessage(message)).join(", ");
        reject(new Error(`${this.name} timed out waiting for ${description}. Recent: ${recent || "none"}`));
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
    this.socket.close(1000, "focused regression complete");
    await Promise.race([closed, delay(1_000)]);
    openClients.delete(this);
  }
}

async function fetchJson(path, init = {}) {
  const response = await fetch(`${HTTP_BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  assert(response.ok, `${init.method ?? "GET"} ${path} returned ${response.status}: ${text}`);
  return body;
}

function websocketUrl(roomCode) {
  const url = new URL(HTTP_BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/rooms/${roomCode}/websocket`;
  return url.toString();
}

let stepNumber = 0;
async function step(label, work) {
  process.stdout.write(`  ${++stepNumber}. ${label} ... `);
  const startedAt = Date.now();
  try {
    const result = await work();
    console.log(`PASS (${Date.now() - startedAt}ms)`);
    return result;
  } catch (error) {
    console.log("FAIL");
    throw error;
  }
}

function latestRoom(client) {
  for (let index = client.messages.length - 1; index >= 0; index -= 1) {
    const message = client.messages[index].message;
    if (message.type === "room_state" || message.type === "welcome") return message.room;
  }
  return null;
}

function hasCatBump(snapshot) {
  return snapshot?.type === "snapshot" && snapshot.events?.some((event) => event.kind === "cat_bump");
}

function dotVelocity(first, second) {
  return first.vx * second.vx + first.vy * second.vy;
}

async function main() {
  console.log("COUCH MOVERS changed-features regression");
  console.log(`Target: ${HTTP_BASE}`);

  await step("health endpoint responds", async () => {
    const health = await fetchJson("/health");
    assert(health?.ok === true, "server health response was not OK");
  });

  const { roomCode } = await fetchJson("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert(/^[A-Z]{6}$/.test(roomCode), `server returned invalid room code ${String(roomCode)}`);

  const url = websocketUrl(roomCode);
  const first = new TestClient("player 1", url);
  const second = new TestClient("player 2", url);
  await Promise.all([first.connect(), second.connect()]);
  first.send({ type: "hello", profile: { color: "tomato", hat: "cap" } });
  second.send({ type: "hello", profile: { color: "sky", hat: "cowboy" } });
  const [firstWelcome, secondWelcome] = await Promise.all([
    first.waitFor((message) => message.type === "welcome", "welcome"),
    second.waitFor((message) => message.type === "welcome", "welcome"),
  ]);
  await first.waitFor(
    (message) => message.type === "room_state" && message.room.players.length === 2,
    "both players in the room",
  );

  const firstIsHost = firstWelcome.room.players.some((player) => player.id === firstWelcome.playerId && player.host);
  const host = firstIsHost ? first : second;
  const guest = firstIsHost ? second : first;

  await step("non-host cannot change the selected stage", async () => {
    const guestMark = guest.mark();
    guest.send({ type: "select_level", levelIndex: ROPE_LEVEL_INDEX });
    const error = await guest.waitFor(
      (message) => message.type === "error" && message.code === "HOST_ONLY",
      "HOST_ONLY stage-selection error",
      { after: guestMark },
    );
    assert(/host|foreman/i.test(error.message), "HOST_ONLY response should explain the foreman restriction");
    await delay(100);
    assert(latestRoom(host)?.levelIndex === 0, "guest selection changed the room's stage");
  });

  await step("host can select every stage and rope selection reports rope-climb", async () => {
    for (let levelIndex = 0; levelIndex < EXPECTED_LEVELS; levelIndex += 1) {
      const mark = host.mark();
      host.send({ type: "select_level", levelIndex });
      const [roomState, levelState] = await Promise.all([
        host.waitFor(
          (message) => message.type === "room_state" && message.room.levelIndex === levelIndex,
          `room_state for stage ${levelIndex + 1}`,
          { after: mark },
        ),
        host.waitFor(
          (message) => message.type === "level_state" && message.level.number === levelIndex + 1,
          `level_state for stage ${levelIndex + 1}`,
          { after: mark },
        ),
      ]);
      assert(roomState.room.totalLevels === EXPECTED_LEVELS, "room reports the wrong number of stages");
      if (levelIndex === ROPE_LEVEL_INDEX) {
        assert(levelState.level.mechanic === "rope-climb", "selected rope stage did not report rope-climb mechanics");
        assert(levelState.level.ropeLength > 0, "selected rope stage omitted its rope length");
      }
    }
  });

  await step("cat reverses direction after colliding with the couch", async () => {
    const selectionMark = host.mark();
    host.send({ type: "select_level", levelIndex: CAT_LEVEL_INDEX });
    await host.waitFor(
      (message) => message.type === "level_state" && message.level.id === "cat-chaos",
      "Cat Chaos level state",
      { after: selectionMark },
    );

    first.send({ type: "set_ready", ready: true });
    second.send({ type: "set_ready", ready: true });
    await host.waitFor(
      (message) => message.type === "room_state" && message.room.players.length === 2 && message.room.players.every((player) => player.ready),
      "both players ready",
    );
    host.send({ type: "start_game" });
    await host.waitFor(
      (message) => message.type === "snapshot" && message.phase === "playing" && message.cat,
      "playing Cat Chaos snapshot",
      { timeoutMs: 12_000 },
    );

    first.sendInput({ type: "grip_toggle" });
    second.sendInput({ type: "grip_toggle" });
    await host.waitFor(
      (message) => message.type === "snapshot" && message.players.length === 2 && message.players.every((player) => player.gripped),
      "both players gripping",
    );

    const collisionSearchMark = host.mark();
    first.sendInput({ type: "move", x: 1, y: 0 });
    second.sendInput({ type: "move", x: 1, y: 0 });

    // Park the couch across the cat's lower patrol lane. The cat reaches this
    // lane naturally, keeping the test within real server physics/input paths.
    const parkSnapshot = await host.waitFor(
      (message) => hasCatBump(message) || (message.type === "snapshot" && message.couch.x >= 790),
      "couch to reach cat patrol lane or collide",
      { after: collisionSearchMark, timeoutMs: 18_000 },
    );
    first.sendInput({ type: "move", x: 0, y: 0 });
    second.sendInput({ type: "move", x: 0, y: 0 });

    const bumpSnapshot = hasCatBump(parkSnapshot)
      ? parkSnapshot
      : await host.waitFor(hasCatBump, "cat_bump event", {
          after: collisionSearchMark,
          timeoutMs: CAT_COLLISION_TIMEOUT_MS,
        });
    const bumpRecord = host.messages.find(({ message }) => message === bumpSnapshot);
    assert(bumpRecord, "could not locate cat-bump snapshot in message history");

    let incomingCat = null;
    for (let index = bumpRecord.index - 1; index >= collisionSearchMark; index -= 1) {
      const candidate = host.messages[index]?.message;
      if (candidate?.type !== "snapshot" || !candidate.cat || hasCatBump(candidate)) continue;
      if (Math.hypot(candidate.cat.vx, candidate.cat.vy) < 0.5) continue;
      incomingCat = candidate.cat;
      break;
    }
    assert(incomingCat, "no pre-collision cat velocity was captured");

    const incomingDirection = incomingCat.direction;
    assert(incomingDirection === -1 || incomingDirection === 1, "pre-collision snapshot omitted cat patrol direction");

    const reversed = await host.waitFor(
      (message) => message.type === "snapshot" && message.cat &&
        message.cat.direction === -incomingDirection &&
        Math.hypot(message.cat.vx, message.cat.vy) >= 0.5 &&
        dotVelocity(incomingCat, message.cat) < -0.25,
      "cat patrol direction and velocity to reverse after couch collision",
      { after: bumpRecord.index, timeoutMs: 2_500 },
    );
    assert(
      reversed.cat.targetIndex !== incomingCat.targetIndex || dotVelocity(incomingCat, reversed.cat) < -1,
      "cat changed its direction flag without choosing a reverse target or producing a meaningful bounce",
    );
  });

  await Promise.all([first.close(), second.close()]);
  console.log(`\nPASS: ${stepNumber} focused checks completed.`);
}

main().catch(async (error) => {
  await Promise.all([...openClients].map((client) => client.close().catch(() => undefined)));
  console.error(`\nFAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
