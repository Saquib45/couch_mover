#!/usr/bin/env node

/**
 * COUCH MOVERS local integration smoke test.
 *
 * Requires Node 22+ (for its built-in WebSocket client) and a local server:
 *   npm run dev:server
 *   node scripts/smoke.mjs
 *
 * Override the target when needed:
 *   COUCH_MOVERS_SERVER_URL=http://127.0.0.1:8787 node scripts/smoke.mjs
 */

const HTTP_BASE = (process.env.COUCH_MOVERS_SERVER_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const DEFAULT_TIMEOUT_MS = 6_000;
const COUNTDOWN_TIMEOUT_MS = 12_000;
const DELIVERY_TIMEOUT_MS = 30_000;
const POSITION_EPSILON = 1e-4;

const openClients = new Set();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeMessage(message) {
  if (!message || typeof message !== "object") return String(message);
  if (message.type === "room_state") return `room_state:${message.room?.phase ?? "?"}`;
  if (message.type === "snapshot") {
    const x = Number.isFinite(message.couch?.x) ? message.couch.x.toFixed(1) : "?";
    const y = Number.isFinite(message.couch?.y) ? message.couch.y.toFixed(1) : "?";
    const angle = Number.isFinite(message.couch?.angle) ? message.couch.angle.toFixed(2) : "?";
    return `snapshot:${message.phase ?? "?"}#${message.tick ?? "?"}@(${x},${y},${angle})`;
  }
  if (message.type === "error") return `error:${message.code ?? "UNKNOWN"}`;
  return String(message.type ?? "unknown");
}

class SmokeClient {
  constructor(name, url) {
    this.name = name;
    this.url = url;
    this.socket = null;
    this.messages = [];
    this.waiters = new Set();
    this.intentionalClose = false;
    this.nextInputSequence = 1;
  }

  mark() {
    return this.messages.length;
  }

  async connect(timeoutMs = DEFAULT_TIMEOUT_MS) {
    assert(typeof globalThis.WebSocket === "function", "Node 22+ is required: global WebSocket is unavailable");
    assert(!this.socket, `${this.name} is already connected`);

    const socket = new WebSocket(this.url);
    this.socket = socket;
    openClients.add(this);

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        this.#rejectAll(new Error(`${this.name} received malformed JSON: ${String(event.data).slice(0, 160)}`));
        return;
      }

      const record = { index: this.messages.length, message };
      this.messages.push(record);

      for (const waiter of [...this.waiters]) {
        if (record.index < waiter.after) continue;
        let matches = false;
        try {
          matches = waiter.predicate(message);
        } catch (error) {
          this.waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.reject(error);
          continue;
        }
        if (!matches) continue;
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });

    socket.addEventListener("close", (event) => {
      if (!this.intentionalClose) {
        this.#rejectAll(
          new Error(`${this.name} socket closed unexpectedly (code ${event.code}${event.reason ? `: ${event.reason}` : ""})`),
        );
      }
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} did not open within ${timeoutMs}ms`)), timeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`${this.name} failed to connect to ${this.url}`));
        },
        { once: true },
      );
    });
  }

  send(message) {
    assert(this.socket?.readyState === WebSocket.OPEN, `${this.name} cannot send while its socket is not open`);
    this.socket.send(JSON.stringify(message));
  }

  sendInput(message) {
    this.send({ ...message, seq: this.nextInputSequence++ });
  }

  waitFor(predicate, description, { after = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    for (const record of this.messages) {
      if (record.index >= after && predicate(record.message)) return Promise.resolve(record.message);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        after,
        predicate,
        resolve,
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        const recent = this.messages
          .slice(-8)
          .map(({ message }) => describeMessage(message))
          .join(", ");
        reject(
          new Error(
            `${this.name} timed out after ${timeoutMs}ms waiting for ${description}. ` +
              `Recent messages: ${recent || "none"}`,
          ),
        );
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  async close() {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      openClients.delete(this);
      return;
    }

    this.intentionalClose = true;
    const socket = this.socket;
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
    try {
      socket.close(1000, "smoke test");
    } catch {
      // A connection timeout can leave Node's client briefly in CONNECTING.
      socket.addEventListener("open", () => socket.close(1000, "smoke test"), { once: true });
    }
    await Promise.race([closed, delay(1_000)]);
    openClients.delete(this);
  }

  #rejectAll(error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

function roomFrom(message) {
  if (message?.type === "welcome" || message?.type === "room_state") return message.room;
  return null;
}

function isSnapshot(message) {
  return message?.type === "snapshot";
}

function assertValidSnapshot(snapshot, label) {
  assert(Number.isInteger(snapshot.tick) && snapshot.tick >= 0, `${label} has an invalid tick`);
  for (const [field, value] of Object.entries({
    couchX: snapshot.couch?.x,
    couchY: snapshot.couch?.y,
    couchAngle: snapshot.couch?.angle,
    couchVx: snapshot.couch?.vx,
    couchVy: snapshot.couch?.vy,
  })) {
    assert(Number.isFinite(value), `${label} has a non-finite ${field}`);
  }
  assert(Number.isFinite(snapshot.couch?.hp) && snapshot.couch.hp >= 0, `${label} has invalid couch HP`);
  assert(Number.isFinite(snapshot.score?.score), `${label} has an invalid live score`);
  assert(Array.isArray(snapshot.breakables), `${label} omitted breakable state`);
  assert(Array.isArray(snapshot.events), `${label} omitted game events`);
}

function assertNoServerErrors(...clients) {
  for (const client of clients) {
    const errors = client.messages.filter(({ message }) => message?.type === "error");
    assert(
      errors.length === 0,
      `${client.name} received server error(s): ${errors.map(({ message }) => `${message.code}: ${message.message}`).join("; ")}`,
    );
  }
}

function snapshotsSince(client, after, minTick) {
  return client.messages
    .filter(({ index, message }) => index >= after && isSnapshot(message) && message.tick >= minTick)
    .map(({ message }) => message);
}

async function waitForMatchingSnapshot(
  first,
  second,
  { afterFirst = 0, afterSecond = 0, minTick = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const firstSnapshots = snapshotsSince(first, afterFirst, minTick);
    const secondByTick = new Map(
      snapshotsSince(second, afterSecond, minTick).map((snapshot) => [snapshot.tick, snapshot]),
    );

    for (let index = firstSnapshots.length - 1; index >= 0; index -= 1) {
      const left = firstSnapshots[index];
      const right = secondByTick.get(left.tick);
      if (!right) continue;

      assertValidSnapshot(left, `${first.name} snapshot ${left.tick}`);
      assertValidSnapshot(right, `${second.name} snapshot ${right.tick}`);
      assert(
        Math.abs(left.couch.x - right.couch.x) <= POSITION_EPSILON &&
          Math.abs(left.couch.y - right.couch.y) <= POSITION_EPSILON &&
          Math.abs(left.couch.angle - right.couch.angle) <= POSITION_EPSILON,
        `authoritative couch mismatch at tick ${left.tick}: ` +
          `${first.name}=(${left.couch.x}, ${left.couch.y}, ${left.couch.angle}), ` +
          `${second.name}=(${right.couch.x}, ${right.couch.y}, ${right.couch.angle})`,
      );
      return left;
    }

    await delay(20);
  }

  const firstTicks = snapshotsSince(first, afterFirst, minTick)
    .slice(-6)
    .map((snapshot) => snapshot.tick);
  const secondTicks = snapshotsSince(second, afterSecond, minTick)
    .slice(-6)
    .map((snapshot) => snapshot.tick);
  throw new Error(
    `No common authoritative snapshot tick arrived within ${timeoutMs}ms ` +
      `(${first.name}: [${firstTicks.join(", ")}], ${second.name}: [${secondTicks.join(", ")}])`,
  );
}

async function fetchJson(path, init = {}) {
  let response;
  try {
    response = await fetch(`${HTTP_BASE}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Could not reach ${HTTP_BASE}${path}: ${error.message}`);
  }

  const body = await response.text();
  let parsed = null;
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
  }
  assert(response.ok, `${init.method ?? "GET"} ${path} returned ${response.status}: ${body.slice(0, 240)}`);
  return parsed;
}

function websocketUrl(roomCode) {
  const url = new URL(HTTP_BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/rooms/${encodeURIComponent(roomCode)}/websocket`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

let completedSteps = 0;
async function step(label, work) {
  const startedAt = Date.now();
  process.stdout.write(`  ${completedSteps + 1}. ${label} ... `);
  try {
    const result = await work();
    completedSteps += 1;
    console.log(`PASS (${Date.now() - startedAt}ms)`);
    return result;
  } catch (error) {
    console.log("FAIL");
    throw error;
  }
}

async function main() {
  const suiteStartedAt = Date.now();
  console.log("COUCH MOVERS integration smoke");
  console.log(`Target: ${HTTP_BASE}`);

  await step("health endpoint responds", async () => {
    const health = await fetchJson("/health");
    if (health && typeof health === "object" && "ok" in health) {
      assert(health.ok === true, `health response reported ok=${String(health.ok)}`);
    }
  });

  const roomCode = await step("room can be created", async () => {
    const response = await fetchJson("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const code = response?.roomCode;
    assert(typeof code === "string" && /^[A-Z]{6}$/.test(code), `invalid room code: ${String(code)}`);
    return code;
  });

  const url = websocketUrl(roomCode);
  const first = new SmokeClient("player 1", url);
  const second = new SmokeClient("player 2", url);
  let firstWelcome;
  let secondWelcome;

  await step("two WebSocket clients join with distinct identities", async () => {
    await first.connect();
    first.send({ type: "hello", profile: { color: "tomato", hat: "cap" } });
    firstWelcome = await first.waitFor((message) => message.type === "welcome", "welcome");

    await second.connect();
    second.send({ type: "hello", profile: { color: "sky", hat: "cowboy" } });
    secondWelcome = await second.waitFor((message) => message.type === "welcome", "welcome");

    assert(firstWelcome.room?.code === roomCode, "player 1 welcome named the wrong room");
    assert(secondWelcome.room?.code === roomCode, "player 2 welcome named the wrong room");
    assert(firstWelcome.playerId && secondWelcome.playerId, "a welcome omitted its player id");
    assert(firstWelcome.playerId !== secondWelcome.playerId, "both clients received the same player id");
    assert(firstWelcome.sessionToken && secondWelcome.sessionToken, "a welcome omitted its reconnect token");
    assert(firstWelcome.sessionToken !== secondWelcome.sessionToken, "both clients received the same reconnect token");
    assert(firstWelcome.room?.totalLevels === 12, `expected twelve stages, received ${String(firstWelcome.room?.totalLevels)}`);

    await first.waitFor(
      (message) => roomFrom(message)?.players?.some((player) => player.id === secondWelcome.playerId),
      "room state containing both players",
    );
    assertNoServerErrors(first, second);
  });

  let host;
  let hostPlayerId;
  let guest;
  let guestWelcome;
  let guestSlot;
  let rejoinedGuest;

  await step("both players ready and the host starts a countdown", async () => {
    const readyMarkFirst = first.mark();
    const readyMarkSecond = second.mark();
    first.send({ type: "set_ready", ready: true });
    second.send({ type: "set_ready", ready: true });

    const bothReady = (message) => {
      const room = roomFrom(message);
      if (!room) return false;
      const expected = new Set([firstWelcome.playerId, secondWelcome.playerId]);
      return room.players.filter((player) => expected.has(player.id)).every((player) => player.ready) &&
        room.players.filter((player) => expected.has(player.id)).length === 2;
    };

    const settledRoomMessage = await first.waitFor(bothReady, "both players ready", { after: readyMarkFirst });
    await second.waitFor(bothReady, "both players ready", { after: readyMarkSecond });

    const room = roomFrom(settledRoomMessage);
    const hostPlayer = room.players.find((player) => player.host);
    assert(hostPlayer, "room state has no host");
    hostPlayerId = hostPlayer.id;
    host = hostPlayer.id === firstWelcome.playerId ? first : second;
    guest = host === first ? second : first;
    guestWelcome = guest === first ? firstWelcome : secondWelcome;
    guestSlot = room.players.find((player) => player.id === guestWelcome.playerId)?.slot;
    assert(Number.isInteger(guestSlot), "guest has no stable slot");

    const countdownMarkFirst = first.mark();
    const countdownMarkSecond = second.mark();
    host.send({ type: "start_game" });
    const inCountdown = (message) => roomFrom(message)?.phase === "countdown" || message?.phase === "countdown";
    await Promise.all([
      first.waitFor(inCountdown, "countdown state", { after: countdownMarkFirst }),
      second.waitFor(inCountdown, "countdown state", { after: countdownMarkSecond }),
    ]);
    assertNoServerErrors(first, second);
  });

  let initialSnapshot;
  await step("authoritative snapshots begin after the countdown", async () => {
    const playingMarkFirst = first.mark();
    const playingMarkSecond = second.mark();
    await Promise.all([
      first.waitFor((message) => isSnapshot(message) && message.phase === "playing", "playing snapshot", {
        after: playingMarkFirst,
        timeoutMs: COUNTDOWN_TIMEOUT_MS,
      }),
      second.waitFor((message) => isSnapshot(message) && message.phase === "playing", "playing snapshot", {
        after: playingMarkSecond,
        timeoutMs: COUNTDOWN_TIMEOUT_MS,
      }),
    ]);
    initialSnapshot = await waitForMatchingSnapshot(first, second, {
      afterFirst: playingMarkFirst,
      afterSecond: playingMarkSecond,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    assert(initialSnapshot.players.length >= 2, "snapshot omitted an active player");
  });

  let grippedSnapshot;
  await step("server accepts validated grip toggles", async () => {
    const markFirst = first.mark();
    const markSecond = second.mark();
    first.sendInput({ type: "grip_toggle" });
    second.sendInput({ type: "grip_toggle" });
    const playerIds = new Set([firstWelcome.playerId, secondWelcome.playerId]);
    const bothGripped = (message) =>
      isSnapshot(message) &&
      message.players.filter((player) => playerIds.has(player.id)).length === 2 &&
      message.players.filter((player) => playerIds.has(player.id)).every((player) => player.gripped);

    const gripSnapshots = await Promise.all([
      first.waitFor(bothGripped, "snapshot with both movers gripped", { after: markFirst }),
      second.waitFor(bothGripped, "snapshot with both movers gripped", { after: markSecond }),
    ]);
    grippedSnapshot = await waitForMatchingSnapshot(first, second, {
      afterFirst: markFirst,
      afterSecond: markSecond,
      minTick: Math.max(initialSnapshot.tick + 1, ...gripSnapshots.map((snapshot) => snapshot.tick)),
    });
    assert(bothGripped(grippedSnapshot), "matched snapshot did not preserve both accepted grips");
    assertNoServerErrors(first, second);
  });

  await step("grip spam is debounced without desynchronizing the crew", async () => {
    await delay(180);
    const mark = second.mark();
    for (let index = 0; index < 12; index += 1) first.sendInput({ type: "grip_toggle" });
    const released = await second.waitFor(
      (message) => isSnapshot(message) && message.players.find((player) => player.id === firstWelcome.playerId)?.gripped === false,
      "debounced release snapshot",
      { after: mark },
    );
    assert(released.players.find((player) => player.id === secondWelcome.playerId)?.gripped === true, "grip spam affected the other mover");
    await delay(180);
    first.sendInput({ type: "grip_toggle" });
    await second.waitFor(
      (message) => isSnapshot(message) && message.players.find((player) => player.id === firstWelcome.playerId)?.gripped === true,
      "re-gripped snapshot after debounce",
      { after: mark },
    );
    assertNoServerErrors(first, second);
  });

  await step("a mid-game join becomes a spectator and can leave cleanly", async () => {
    const late = new SmokeClient("late spectator", url);
    await late.connect();
    late.send({ type: "hello", profile: { color: "mint", hat: "hardhat" } });
    const welcome = await late.waitFor((message) => message.type === "welcome", "spectator welcome");
    const spectator = welcome.room.players.find((player) => player.id === welcome.playerId);
    assert(spectator?.spectator === true, "mid-game joiner was allowed into the active physics crew");
    const observerMark = first.mark();
    late.send({ type: "leave_room" });
    await first.waitFor(
      (message) => {
        const room = roomFrom(message);
        return room && !room.players.some((player) => player.id === welcome.playerId);
      },
      "spectator removed after explicit leave",
      { after: observerMark },
    );
    await late.close();
    assertNoServerErrors(first, second);
  });

  let opposedSnapshot;
  await step("opposed movement advances the authoritative simulation", async () => {
    const markFirst = first.mark();
    const markSecond = second.mark();
    first.sendInput({ type: "move", x: 0, y: -1 });
    second.sendInput({ type: "move", x: 0, y: 1 });
    await delay(700);
    first.sendInput({ type: "move", x: 0, y: 0 });
    second.sendInput({ type: "move", x: 0, y: 0 });

    opposedSnapshot = await waitForMatchingSnapshot(first, second, {
      afterFirst: markFirst,
      afterSecond: markSecond,
      minTick: grippedSnapshot.tick + 8,
    });
    assert(opposedSnapshot.tick > grippedSnapshot.tick, "opposed input did not advance the server tick");
    assertNoServerErrors(first, second);
  });

  await step("coordinated pulling moves the couch identically for both clients", async () => {
    const markFirst = first.mark();
    const markSecond = second.mark();
    first.sendInput({ type: "move", x: 1, y: 0 });
    second.sendInput({ type: "move", x: 1, y: 0 });
    await delay(900);
    first.sendInput({ type: "move", x: 0, y: 0 });
    second.sendInput({ type: "move", x: 0, y: 0 });

    const pulledSnapshot = await waitForMatchingSnapshot(first, second, {
      afterFirst: markFirst,
      afterSecond: markSecond,
      minTick: opposedSnapshot.tick + 10,
    });
    const travel = Math.hypot(
      pulledSnapshot.couch.x - grippedSnapshot.couch.x,
      pulledSnapshot.couch.y - grippedSnapshot.couch.y,
    );
    const rotation = Math.abs(pulledSnapshot.couch.angle - grippedSnapshot.couch.angle);
    assert(
      travel > 0.05 || rotation > 0.001,
      `accepted movement inputs produced no observable couch motion (travel ${travel.toFixed(4)}, rotation ${rotation.toFixed(5)})`,
    );
    assertNoServerErrors(first, second);
  });

  await step("a disconnected guest reclaims the same player slot with its session token", async () => {
    const observer = host;
    const disconnectedMark = observer.mark();
    await guest.close();
    await observer.waitFor(
      (message) => {
        const player = roomFrom(message)?.players?.find((candidate) => candidate.id === guestWelcome.playerId);
        return player?.connected === false;
      },
      "guest disconnect reflected in room state",
      { after: disconnectedMark },
    );

    rejoinedGuest = new SmokeClient("player 2 rejoin", url);
    const rejoinObserverMark = observer.mark();
    await rejoinedGuest.connect();
    rejoinedGuest.send({
      type: "hello",
      sessionToken: guestWelcome.sessionToken,
      profile: guestWelcome.room.players.find((player) => player.id === guestWelcome.playerId)?.profile ?? {
        color: "sky",
        hat: "cowboy",
      },
    });
    const welcome = await rejoinedGuest.waitFor((message) => message.type === "welcome", "rejoin welcome");
    assert(welcome.playerId === guestWelcome.playerId, "reconnect token created a new player instead of reclaiming its owner");
    const reclaimed = welcome.room.players.find((player) => player.id === guestWelcome.playerId);
    assert(reclaimed?.slot === guestSlot, `rejoined player moved from slot ${guestSlot} to ${String(reclaimed?.slot)}`);
    assert(reclaimed.connected === true, "rejoined player's welcome still marks it disconnected");

    await observer.waitFor(
      (message) => {
        const player = roomFrom(message)?.players?.find((candidate) => candidate.id === guestWelcome.playerId);
        return player?.connected === true;
      },
      "rejoined guest reflected in room state",
      { after: rejoinObserverMark },
    );
    assertNoServerErrors(observer, rejoinedGuest);
  });

  await step("a host leaving mid-level hands off control without a stuck room", async () => {
    assert(rejoinedGuest, "rejoined guest client was unavailable");
    const mark = rejoinedGuest.mark();
    host.send({ type: "leave_room" });
    const recovered = await rejoinedGuest.waitFor(
      (message) => {
        const room = roomFrom(message);
        const me = room?.players.find((player) => player.id === guestWelcome.playerId);
        return room?.phase === "lobby" && me?.host === true;
      },
      "active host handoff and safe lobby recovery",
      { after: mark },
    );
    const room = roomFrom(recovered);
    assert(!room.players.some((player) => player.id === hostPlayerId), "departed active host remained in the room");
    assert(room.players.length === 1, "active host exit did not remove exactly one mover");
    await rejoinedGuest.close();
  });

  await step("an explicit host exit passes the clipboard to the next mover", async () => {
    const response = await fetchJson("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const handoffUrl = websocketUrl(response.roomCode);
    const leavingHost = new SmokeClient("handoff host", handoffUrl);
    const nextHost = new SmokeClient("handoff guest", handoffUrl);
    await leavingHost.connect();
    leavingHost.send({ type: "hello", profile: { color: "tomato", hat: "cap" } });
    const hostWelcome = await leavingHost.waitFor((message) => message.type === "welcome", "handoff host welcome");
    await nextHost.connect();
    nextHost.send({ type: "hello", profile: { color: "sky", hat: "cowboy" } });
    const guestWelcomeMessage = await nextHost.waitFor((message) => message.type === "welcome", "handoff guest welcome");
    assert(hostWelcome.room.players.find((player) => player.id === hostWelcome.playerId)?.host === true, "first mover was not host");
    const mark = nextHost.mark();
    leavingHost.send({ type: "leave_room" });
    const handedOff = await nextHost.waitFor(
      (message) => roomFrom(message)?.players.find((player) => player.id === guestWelcomeMessage.playerId)?.host === true,
      "host handoff room state",
      { after: mark },
    );
    assert(!roomFrom(handedOff).players.some((player) => player.id === hostWelcome.playerId), "leaving host remained in the room");
    await Promise.all([leavingHost.close(), nextHost.close()]);
  });

  await step("four movers share one authoritative couch simulation", async () => {
    const response = await fetchJson("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const fourUrl = websocketUrl(response.roomCode);
    const profiles = [
      { color: "tomato", hat: "cap" },
      { color: "sky", hat: "cowboy" },
      { color: "mint", hat: "hardhat" },
      { color: "sunny", hat: "crown" },
    ];
    const crew = profiles.map((_, index) => new SmokeClient(`four-player mover ${index + 1}`, fourUrl));
    const welcomes = [];
    for (let index = 0; index < crew.length; index += 1) {
      await crew[index].connect();
      crew[index].send({ type: "hello", profile: profiles[index] });
      welcomes.push(await crew[index].waitFor((message) => message.type === "welcome", "four-player welcome"));
    }
    const crewIds = new Set(welcomes.map((welcome) => welcome.playerId));
    const readyMark = crew[0].mark();
    for (const client of crew) client.send({ type: "set_ready", ready: true });
    await crew[0].waitFor((message) => {
      const players = roomFrom(message)?.players.filter((player) => crewIds.has(player.id)) ?? [];
      return players.length === 4 && players.every((player) => player.ready);
    }, "all four movers ready", { after: readyMark });
    crew[0].send({ type: "start_game" });
    await Promise.all(crew.map((client) => client.waitFor(
      (message) => isSnapshot(message) && message.phase === "playing" && message.players.length === 4,
      "four-player playing snapshot",
      { timeoutMs: COUNTDOWN_TIMEOUT_MS },
    )));
    for (const client of crew) client.sendInput({ type: "grip_toggle" });
    const gripped = await crew[0].waitFor(
      (message) => isSnapshot(message) && message.players.length === 4 && message.players.every((player) => player.gripped),
      "all four grips",
    );
    assert(new Set(gripped.players.map((player) => player.handleIndex)).size === 4, "four movers did not receive four distinct corner handles");
    for (const client of crew) client.sendInput({ type: "move", x: 1, y: 0 });
    const moved = await crew[0].waitFor(
      (message) => isSnapshot(message) && message.tick >= gripped.tick + 10 && message.couch.x > gripped.couch.x,
      "four-player couch movement",
    );
    assertValidSnapshot(moved, "four-player snapshot");
    for (const client of crew) client.sendInput({ type: "move", x: 0, y: 0 });
    assertNoServerErrors(...crew);
    await Promise.all(crew.map((client) => client.close()));
  });

  await step("hard couch-wall impacts synchronize HP, blame, and score damage", async () => {
    const response = await fetchJson("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const impactUrl = websocketUrl(response.roomCode);
    const impactFirst = new SmokeClient("impact mover 1", impactUrl);
    const impactSecond = new SmokeClient("impact mover 2", impactUrl);
    await impactFirst.connect();
    impactFirst.send({ type: "hello", profile: { color: "tomato", hat: "hardhat" } });
    const impactFirstWelcome = await impactFirst.waitFor((message) => message.type === "welcome", "impact welcome");
    await impactSecond.connect();
    impactSecond.send({ type: "hello", profile: { color: "sky", hat: "cap" } });
    const impactSecondWelcome = await impactSecond.waitFor((message) => message.type === "welcome", "impact welcome");
    const impactIds = new Set([impactFirstWelcome.playerId, impactSecondWelcome.playerId]);
    const readyMark = impactFirst.mark();
    impactFirst.send({ type: "set_ready", ready: true });
    impactSecond.send({ type: "set_ready", ready: true });
    await impactFirst.waitFor((message) => {
      const players = roomFrom(message)?.players.filter((player) => impactIds.has(player.id)) ?? [];
      return players.length === 2 && players.every((player) => player.ready);
    }, "impact crew ready", { after: readyMark });
    impactFirst.send({ type: "start_game" });
    await impactFirst.waitFor(
      (message) => isSnapshot(message) && message.phase === "playing",
      "impact round playing",
      { timeoutMs: COUNTDOWN_TIMEOUT_MS },
    );
    impactFirst.sendInput({ type: "grip_toggle" });
    impactSecond.sendInput({ type: "grip_toggle" });
    await impactFirst.waitFor(
      (message) => isSnapshot(message) && message.players.filter((player) => impactIds.has(player.id)).every((player) => player.gripped),
      "impact crew gripped",
    );
    impactFirst.sendInput({ type: "move", x: 0, y: -1 });
    impactSecond.sendInput({ type: "move", x: 0, y: -1 });
    const damaged = await impactFirst.waitFor(
      (message) => isSnapshot(message) && message.couch.hp < message.couch.maxHp,
      "authoritative wall-impact damage",
      { timeoutMs: 18_000 },
    );
    assert(damaged.events.some((event) => event.kind === "impact"), "wall impact changed HP without a synchronized event");
    assert(damaged.score.damagePenalty > 0, "wall impact did not update the live score penalty");
    const damageState = await impactSecond.waitFor(
      (message) => roomFrom(message)?.players.some((player) => player.stats.damageCaused > 0),
      "blame tracker update",
    );
    assert(roomFrom(damageState).players.some((player) => player.stats.damageCaused > 0), "impact was not assigned to a mover");
    impactFirst.sendInput({ type: "move", x: 0, y: 0 });
    impactSecond.sendInput({ type: "move", x: 0, y: 0 });
    assertNoServerErrors(impactFirst, impactSecond);
    await Promise.all([impactFirst.close(), impactSecond.close()]);
  });

  await step("a fresh coordinated crew can finish the tutorial delivery", async () => {
    const response = await fetchJson("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const deliveryCode = response?.roomCode;
    assert(typeof deliveryCode === "string", "completion room creation returned no code");
    const deliveryUrl = websocketUrl(deliveryCode);
    const deliveryFirst = new SmokeClient("delivery player 1", deliveryUrl);
    const deliverySecond = new SmokeClient("delivery player 2", deliveryUrl);

    await deliveryFirst.connect();
    deliveryFirst.send({ type: "hello", profile: { color: "mint", hat: "hardhat" } });
    const deliveryFirstWelcome = await deliveryFirst.waitFor((message) => message.type === "welcome", "delivery welcome");
    await deliverySecond.connect();
    deliverySecond.send({ type: "hello", profile: { color: "sunny", hat: "crown" } });
    const deliverySecondWelcome = await deliverySecond.waitFor((message) => message.type === "welcome", "delivery welcome");

    const readyMark = deliveryFirst.mark();
    deliveryFirst.send({ type: "set_ready", ready: true });
    deliverySecond.send({ type: "set_ready", ready: true });
    const deliveryIds = new Set([deliveryFirstWelcome.playerId, deliverySecondWelcome.playerId]);
    await deliveryFirst.waitFor((message) => {
      const players = roomFrom(message)?.players?.filter((player) => deliveryIds.has(player.id)) ?? [];
      return players.length === 2 && players.every((player) => player.ready);
    }, "delivery crew ready", { after: readyMark });

    deliveryFirst.send({ type: "start_game" });
    await Promise.all([
      deliveryFirst.waitFor((message) => isSnapshot(message) && message.phase === "playing", "delivery playing snapshot", { timeoutMs: COUNTDOWN_TIMEOUT_MS }),
      deliverySecond.waitFor((message) => isSnapshot(message) && message.phase === "playing", "delivery playing snapshot", { timeoutMs: COUNTDOWN_TIMEOUT_MS }),
    ]);

    const gripMarkFirst = deliveryFirst.mark();
    const gripMarkSecond = deliverySecond.mark();
    deliveryFirst.sendInput({ type: "grip_toggle" });
    deliverySecond.sendInput({ type: "grip_toggle" });
    const bothDeliveryMoversGripped = (message) =>
      isSnapshot(message) &&
      message.players.filter((player) => deliveryIds.has(player.id)).length === 2 &&
      message.players.filter((player) => deliveryIds.has(player.id)).every((player) => player.gripped);
    await Promise.all([
      deliveryFirst.waitFor(bothDeliveryMoversGripped, "delivery grips", { after: gripMarkFirst }),
      deliverySecond.waitFor(bothDeliveryMoversGripped, "delivery grips", { after: gripMarkSecond }),
    ]);

    const pullMarkFirst = deliveryFirst.mark();
    const pullMarkSecond = deliverySecond.mark();
    deliveryFirst.sendInput({ type: "move", x: 1, y: 0 });
    deliverySecond.sendInput({ type: "move", x: 1, y: 0 });
    const isComplete = (message) => isSnapshot(message) && message.phase === "complete";
    const completed = await Promise.all([
      deliveryFirst.waitFor(isComplete, "completed tutorial snapshot", { after: pullMarkFirst, timeoutMs: DELIVERY_TIMEOUT_MS }),
      deliverySecond.waitFor(isComplete, "completed tutorial snapshot", { after: pullMarkSecond, timeoutMs: DELIVERY_TIMEOUT_MS }),
    ]);
    assert(completed.every((snapshot) => snapshot.deliveryProgress === 1), "completion did not hold the couch in the target for two seconds");
    assert(
      Math.abs(completed[0].couch.x - completed[1].couch.x) <= POSITION_EPSILON &&
        Math.abs(completed[0].couch.y - completed[1].couch.y) <= POSITION_EPSILON &&
        Math.abs(completed[0].couch.angle - completed[1].couch.angle) <= POSITION_EPSILON,
      "clients disagreed on the completed couch pose",
    );
    const resultState = await deliveryFirst.waitFor(
      (message) => roomFrom(message)?.phase === "complete" && roomFrom(message)?.result,
      "authoritative score result",
      { after: pullMarkFirst },
    );
    const result = roomFrom(resultState).result;
    assert(Number.isFinite(result.score) && result.score >= 0, "level result has an invalid score");
    assert([1, 2, 3].includes(result.stars), "level result has an invalid star award");
    assert(result.hpRemaining > 0, "successful delivery reported a destroyed couch");

    const nextMarkFirst = deliveryFirst.mark();
    const nextMarkSecond = deliverySecond.mark();
    deliveryFirst.send({ type: "next_level" });
    const secondLevel = await deliveryFirst.waitFor(
      (message) => message.type === "level_state" && message.level?.number === 2,
      "second level definition",
      { after: nextMarkFirst },
    );
    assert(secondLevel.level.id === "l-corner", "next job was not the L-corner");
    const levelTwoPlaying = await Promise.all([
      deliveryFirst.waitFor(
        (message) => isSnapshot(message) && message.phase === "playing" && message.levelIndex === 1,
        "level two playing snapshot",
        { after: nextMarkFirst, timeoutMs: COUNTDOWN_TIMEOUT_MS },
      ),
      deliverySecond.waitFor(
        (message) => isSnapshot(message) && message.phase === "playing" && message.levelIndex === 1,
        "level two playing snapshot",
        { after: nextMarkSecond, timeoutMs: COUNTDOWN_TIMEOUT_MS },
      ),
    ]);
    assert(levelTwoPlaying.every((snapshot) => snapshot.breakables.length === 2), "level two breakables were not synchronized");
    assert(levelTwoPlaying.every((snapshot) => snapshot.couch.hp === snapshot.couch.maxHp), "next job did not restore couch HP");
    assertNoServerErrors(deliveryFirst, deliverySecond);
    await Promise.all([deliveryFirst.close(), deliverySecond.close()]);
  });

  await Promise.all([...openClients].map((client) => client.close()));
  console.log(`\nSMOKE PASS: ${completedSteps} checks completed in ${Date.now() - suiteStartedAt}ms`);
}

main().catch(async (error) => {
  await Promise.all([...openClients].map((client) => client.close().catch(() => undefined)));
  console.error("\nSMOKE FAIL");
  console.error(error instanceof Error ? error.stack : error);
  console.error("\nStart the authoritative server with `npm run dev:server`, then retry with Node 22+.");
  process.exitCode = 1;
});
