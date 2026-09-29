#!/usr/bin/env node

/** Focused production-path check for multiplayer snapshot cadence and sync. */

const HTTP_BASE = (process.env.COUCH_MOVERS_SERVER_URL ?? "http://127.0.0.1:4173").replace(/\/$/, "");
const clients = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roomFrom(message) {
  return message?.type === "welcome" || message?.type === "room_state" ? message.room : null;
}

class Client {
  constructor(name, roomCode) {
    this.name = name;
    this.messages = [];
    this.waiters = new Set();
    const url = new URL(HTTP_BASE);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/api/rooms/${roomCode}/websocket`;
    this.socket = new WebSocket(url);
    clients.push(this);
    this.socket.addEventListener("message", (event) => {
      const raw = String(event.data);
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      const record = { message, receivedAt: performance.now(), bytes: Buffer.byteLength(raw) };
      this.messages.push(record);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(record);
      }
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} WebSocket open timed out`)), 6_000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`${this.name} WebSocket failed`)); }, { once: true });
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  waitFor(predicate, label, timeoutMs = 8_000) {
    const existing = this.messages.find((record) => predicate(record.message));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`${this.name} timed out waiting for ${label}`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  close() {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, "network smoke complete");
  }
}

function percentile(values, amount) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * amount))] ?? 0;
}

async function main() {
  console.log(`COUCH MOVERS network cadence smoke\nTarget: ${HTTP_BASE}`);
  const health = await fetch(`${HTTP_BASE}/health`, { signal: AbortSignal.timeout(6_000) });
  assert(health.ok, `health returned ${health.status}`);

  const createResponse = await fetch(`${HTTP_BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(6_000),
  });
  assert(createResponse.ok, `create room returned ${createResponse.status}`);
  const { roomCode } = await createResponse.json();
  assert(/^[A-Z]{6}$/.test(roomCode), "server returned an invalid room code");

  const host = new Client("host", roomCode);
  await host.open();
  host.send({ type: "hello", profile: { color: "tomato", hat: "cap" } });
  const hostWelcome = (await host.waitFor((message) => message.type === "welcome", "welcome")).message;

  const guest = new Client("guest", roomCode);
  await guest.open();
  guest.send({ type: "hello", profile: { color: "sky", hat: "cowboy" } });
  const guestWelcome = (await guest.waitFor((message) => message.type === "welcome", "welcome")).message;
  assert(hostWelcome.playerId !== guestWelcome.playerId, "players received the same identity");

  host.send({ type: "set_ready", ready: true });
  guest.send({ type: "set_ready", ready: true });
  await host.waitFor((message) => {
    const room = roomFrom(message);
    return room?.players?.filter((player) => !player.spectator).length === 2 && room.players.every((player) => player.ready);
  }, "both players ready");
  host.send({ type: "start_game" });
  await Promise.all([
    host.waitFor((message) => message.type === "snapshot" && message.phase === "playing", "playing snapshot", 12_000),
    guest.waitFor((message) => message.type === "snapshot" && message.phase === "playing", "playing snapshot", 12_000),
  ]);

  const sampleStartedAt = performance.now();
  await wait(5_000);
  const sampleEndedAt = performance.now();
  const hostSnapshots = host.messages.filter((record) => record.message.type === "snapshot" && record.receivedAt >= sampleStartedAt && record.receivedAt <= sampleEndedAt);
  const guestSnapshots = guest.messages.filter((record) => record.message.type === "snapshot" && record.receivedAt >= sampleStartedAt && record.receivedAt <= sampleEndedAt);
  assert(hostSnapshots.length >= 90, `only ${hostSnapshots.length} host snapshots arrived in five seconds`);
  assert(guestSnapshots.length >= 90, `only ${guestSnapshots.length} guest snapshots arrived in five seconds`);

  const gaps = hostSnapshots.slice(1).map((record, index) => record.receivedAt - hostSnapshots[index].receivedAt);
  const meanGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  const p95Gap = percentile(gaps, 0.95);
  const maxGap = Math.max(...gaps);

  const guestByTick = new Map(guestSnapshots.map((record) => [record.message.tick, record.message]));
  const shared = hostSnapshots.map((record) => record.message).filter((snapshot) => guestByTick.has(snapshot.tick));
  assert(shared.length >= 80, `only ${shared.length} synchronized ticks reached both players`);
  for (const snapshot of shared) {
    const other = guestByTick.get(snapshot.tick);
    assert(JSON.stringify(snapshot.couch) === JSON.stringify(other.couch), `couch diverged at tick ${snapshot.tick}`);
  }

  const sizes = hostSnapshots.map((record) => record.bytes);
  console.log(`PASS: ${hostSnapshots.length} snapshots / 5s (${(hostSnapshots.length / 5).toFixed(1)} Hz)`);
  console.log(`Arrival gaps: mean ${meanGap.toFixed(1)} ms, p95 ${p95Gap.toFixed(1)} ms, max ${maxGap.toFixed(1)} ms`);
  console.log(`Snapshot payload: mean ${Math.round(sizes.reduce((sum, size) => sum + size, 0) / sizes.length)} B, max ${Math.max(...sizes)} B`);
  console.log(`Authoritative agreement: ${shared.length} shared ticks, zero couch divergence`);
  assert(p95Gap < 90, `snapshot p95 gap was ${p95Gap.toFixed(1)} ms`);
  assert(maxGap < 200, `snapshot maximum gap was ${maxGap.toFixed(1)} ms`);
}

try {
  await main();
} finally {
  for (const client of clients) client.close();
}
