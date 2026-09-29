import {
  COUCH_MAX_HP,
  DELIVERY_HOLD_MS,
  LEVELS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  SERVER_TICK_MS,
  SHOUTS,
  clamp,
  getClimbableLadder,
  getHandlePoints,
  isMoverColor,
  isMoverHat,
  isShout,
  type BodySnapshot,
  type BreakableDefinition,
  type BreakableSnapshot,
  type CatSnapshot,
  type CrashReplay,
  type GameEvent,
  type GameSnapshot,
  type LevelDefinition,
  type LevelResult,
  type PlayerProfile,
  type ReplayFrame,
  type RoomPhase,
  type RoomPlayer,
  type RoomView,
  type ServerMessage,
  type ShoutPhrase,
  type SnapshotPlayer,
  type Vec2,
} from "@couch-movers/shared";
import Matter from "matter-js";

import type { Env } from "./index";

const COUNTDOWN_MS = 3_000;
const RESUME_COUNTDOWN_MS = 1_500;
const MAX_MESSAGE_CHARS = 2_048;
const MAX_MESSAGES_PER_SECOND = 70;
const MAX_MOVES_PER_SECOND = 35;
const GRIP_DEBOUNCE_MS = 140;
const SHOUT_COOLDOWN_MS = 450;
const SHOUT_DURATION_MS = 2_000;
const CAT_BOUNCE_DURATION_MS = 520;
const GRIP_DISTANCE = 78;
const ROPE_GRIP_SLACK = 80;
const ROPE_STIFFNESS = 0.00062;
const ROPE_DAMPING = 0.0022;
const ROPE_MAX_TENSION = 0.042;
const MOVER_RADIUS = 24;
const MOVER_MAX_SPEED = 5.4;
const MOVER_FORCE = 0.00145;
const PHYSICS_SUBSTEPS = 3;
const COUCH_WIDTH = 160;
const COUCH_HEIGHT = 88;
const COUCH_COLLISION_CATEGORY = 0x0002;
const MOVER_COLLISION_CATEGORY = 0x0004;
const EVERYTHING_EXCEPT_COUCH_MASK = 0xfffffffd;
const CHECKPOINT_INTERVAL_MS = 1_000;
const STORAGE_KEY = "room-state-v2";
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,160}$/;
const COUCH_IMPACT_SPEED = 0.22;
const LADDER_SETTLING_IMPACT_SPEED = 0.65;
const BREAK_IMPACT_SPEED = 0.45;
const IMPACT_COOLDOWN_MS = 500;
const EVENT_LIFETIME_MS = 2_200;
const DAMAGE_SCORE_MULTIPLIER = 20;
const REPLAY_HISTORY_FRAMES = 22;
const REPLAY_AFTER_FRAMES = 28;
const DELIVERY_POSITION_GRACE = 8;
const DELIVERY_ANGLE_GRACE = 0.06;
const DELIVERY_PROGRESS_DECAY = 2;

interface PlayerRecord extends RoomPlayer {
  sessionToken: string;
  joinedAt: number;
  lastSeenAt: number;
  lastInputSeq: number;
  moveX: number;
  moveY: number;
  handleIndex: number | null;
  shout: { phrase: ShoutPhrase; expiresAt: number } | null;
  lastGripAt: number;
  lastShoutAt: number;
}

interface SocketAttachment {
  playerId: string;
}

interface RateWindow {
  startedAt: number;
  messages: number;
  moveStartedAt: number;
  moves: number;
}

interface SavedBody extends BodySnapshot {}

interface PhysicsCheckpoint {
  couch: SavedBody;
  movers: Record<string, SavedBody>;
  breakables: Record<string, SavedBody>;
  cat: SavedBody | null;
}

interface PersistedRoom {
  version: 2;
  initialized: boolean;
  code: string;
  phase: RoomPhase;
  players: PlayerRecord[];
  roundPlayerIds: string[];
  countdownEndsAt: number | null;
  resumeCountdown: boolean;
  pausedFrom: "countdown" | "playing" | null;
  pausedCountdownRemainingMs: number;
  pausedReason: string | null;
  elapsedMs: number;
  deliveryHoldMs: number;
  tick: number;
  currentLevelIndex: number;
  couchHp: number;
  itemsPenalty: number;
  brokenBreakableIds: string[];
  catTargetIndex: number;
  catDirection?: -1 | 1;
  recentEvents: GameEvent[];
  nextEventId: number;
  result: LevelResult | null;
  worstCrash: CrashReplay | null;
  checkpoint: PhysicsCheckpoint | null;
}

interface BreakableState {
  definition: BreakableDefinition;
  body: Matter.Body | null;
  x: number;
  y: number;
  angle: number;
  broken: boolean;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validProfile(value: unknown): value is PlayerProfile {
  return (
    isObject(value) &&
    isMoverColor(value.color) &&
    isMoverHat(value.hat)
  );
}

function bodySnapshot(body: Matter.Body): BodySnapshot {
  return {
    x: body.position.x,
    y: body.position.y,
    angle: body.angle,
    vx: body.velocity.x,
    vy: body.velocity.y,
    angularVelocity: body.angularVelocity,
  };
}

function applyBodySnapshot(body: Matter.Body, saved: SavedBody): void {
  Matter.Body.setPosition(body, { x: saved.x, y: saved.y });
  Matter.Body.setAngle(body, saved.angle);
  Matter.Body.setVelocity(body, { x: saved.vx, y: saved.vy });
  Matter.Body.setAngularVelocity(body, saved.angularVelocity);
}

function normalizedInput(x: number, y: number): Vec2 {
  const safeX = clamp(x, -1, 1);
  const safeY = clamp(y, -1, 1);
  const length = Math.hypot(safeX, safeY);
  if (length <= 1 || length === 0) {
    return { x: safeX, y: safeY };
  }
  return { x: safeX / length, y: safeY / length };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function makeSessionToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export class RoomDurableObject {
  private readonly ready: Promise<void>;
  private initialized = false;
  private code = "";
  private phase: RoomPhase = "lobby";
  private players = new Map<string, PlayerRecord>();
  private roundPlayerIds: string[] = [];
  private countdownEndsAt: number | null = null;
  private resumeCountdown = false;
  private pausedFrom: "countdown" | "playing" | null = null;
  private pausedCountdownRemainingMs = 0;
  private pausedReason: string | null = null;
  private elapsedMs = 0;
  private deliveryHoldMs = 0;
  private tickNumber = 0;
  private currentLevelIndex = 0;
  private couchHp = COUCH_MAX_HP;
  private itemsPenalty = 0;
  private result: LevelResult | null = null;
  private worstCrash: CrashReplay | null = null;
  private worstCrashSeverity = 0;
  private replayHistory: ReplayFrame[] = [];
  private replayCaptureRemaining = 0;
  private recentEvents: GameEvent[] = [];
  private nextEventId = 1;
  private catTargetIndex = 0;
  private catDirection: -1 | 1 = 1;
  private catAvoidUntil = 0;

  private engine: Matter.Engine | null = null;
  private couch: Matter.Body | null = null;
  private moverBodies = new Map<string, Matter.Body>();
  private gripConstraints = new Map<string, Matter.Constraint>();
  private ropeGrips = new Set<string>();
  private handleIndices = new Map<string, number>();
  private breakables = new Map<string, BreakableState>();
  private cat: Matter.Body | null = null;
  private readonly impactCooldowns = new Map<string, number>();

  private readonly socketPlayers = new Map<WebSocket, string>();
  private readonly playerSockets = new Map<string, WebSocket>();
  private readonly rateWindows = new WeakMap<WebSocket, RateWindow>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastCheckpointAt = 0;
  private persistInFlight = false;
  private persistQueued = false;

  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {
    this.ready = this.state.blockConcurrencyWhile(async () => this.restore());
  }

  private get level(): LevelDefinition {
    return LEVELS[this.currentLevelIndex] ?? LEVELS[0]!;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === "/initialize" && request.method === "POST") {
      return this.initialize(request.headers.get("X-Room-Code"));
    }

    if (url.pathname === "/status" && request.method === "GET") {
      return new Response(null, { status: this.initialized ? 204 : 404 });
    }

    if (!this.initialized) {
      return new Response(JSON.stringify({ error: "ROOM_NOT_FOUND", message: "That room does not exist." }), {
        status: 404,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response(JSON.stringify({ error: "UPGRADE_REQUIRED" }), {
        status: 426,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // Leave a little headroom for a reconnect racing with its old socket closing.
    if (this.state.getWebSockets().length >= MAX_PLAYERS * 2) {
      return new Response("Too many connections", { status: 503 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    this.rateWindows.set(server, {
      startedAt: Date.now(),
      messages: 0,
      moveStartedAt: Date.now(),
      moves: 0,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.ready;
    if (typeof raw !== "string") {
      this.sendError(socket, "BINARY_UNSUPPORTED", "Send JSON text messages only.");
      return;
    }
    if (raw.length > MAX_MESSAGE_CHARS) {
      this.closeWithError(socket, "MESSAGE_TOO_LARGE", "That message was too large.");
      return;
    }
    if (!this.consumeMessageRate(socket)) {
      this.closeWithError(socket, "RATE_LIMITED", "Too many messages too quickly.");
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.sendError(socket, "BAD_JSON", "That message was not valid JSON.");
      return;
    }
    if (!isObject(message) || typeof message.type !== "string") {
      this.sendError(socket, "BAD_MESSAGE", "That message was not understood.");
      return;
    }

    const attachedPlayerId = this.socketPlayers.get(socket);
    if (!attachedPlayerId) {
      if (message.type !== "hello") {
        this.sendError(socket, "NOT_JOINED", "Say hello before sending game input.");
        return;
      }
      await this.handleHello(socket, message);
      return;
    }

    const player = this.players.get(attachedPlayerId);
    if (!player) {
      this.closeWithError(socket, "SESSION_LOST", "Your player slot could not be restored.");
      return;
    }

    await this.handlePlayerMessage(socket, player, message);
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.ready;
    await this.handleDisconnect(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.ready;
    await this.handleDisconnect(socket);
  }

  private async initialize(roomCode: string | null): Promise<Response> {
    if (this.initialized) {
      return new Response(null, { status: 409 });
    }
    if (!roomCode || !/^[A-Z]{6}$/.test(roomCode)) {
      return new Response("Invalid room code", { status: 400 });
    }

    this.initialized = true;
    this.code = roomCode;
    await this.persistNow();
    return new Response(null, { status: 201 });
  }

  private async restore(): Promise<void> {
    const saved = await this.state.storage.get<PersistedRoom>(STORAGE_KEY);
    if (!saved || saved.version !== 2 || !saved.initialized) return;

    this.initialized = true;
    this.code = saved.code;
    this.phase = saved.phase;
    this.roundPlayerIds = saved.roundPlayerIds;
    this.countdownEndsAt = saved.countdownEndsAt;
    this.resumeCountdown = saved.resumeCountdown;
    this.pausedFrom = saved.pausedFrom;
    this.pausedCountdownRemainingMs = saved.pausedCountdownRemainingMs;
    this.pausedReason = saved.pausedReason;
    this.elapsedMs = saved.elapsedMs;
    this.deliveryHoldMs = saved.deliveryHoldMs;
    this.tickNumber = saved.tick;
    this.currentLevelIndex = clamp(saved.currentLevelIndex, 0, LEVELS.length - 1);
    this.couchHp = clamp(saved.couchHp, 0, COUCH_MAX_HP);
    this.itemsPenalty = Math.max(0, saved.itemsPenalty);
    this.catTargetIndex = Math.max(0, saved.catTargetIndex);
    this.catDirection = saved.catDirection === -1 ? -1 : 1;
    this.recentEvents = saved.recentEvents ?? [];
    this.nextEventId = Math.max(1, saved.nextEventId ?? 1);
    this.result = saved.result ?? null;
    this.worstCrash = saved.worstCrash ?? saved.result?.worstCrash ?? null;
    this.worstCrashSeverity = this.worstCrash
      ? (this.worstCrash.event.kind === "break" ? this.worstCrash.event.amount / 20 : this.worstCrash.event.amount)
      : 0;

    for (const storedPlayer of saved.players) {
      const player: PlayerRecord = {
        ...storedPlayer,
        connected: false,
        moveX: 0,
        moveY: 0,
        shout: storedPlayer.shout?.expiresAt && storedPlayer.shout.expiresAt > Date.now()
          ? storedPlayer.shout
          : null,
        stats: {
          damageCaused: storedPlayer.stats?.damageCaused ?? 0,
          itemsBroken: storedPlayer.stats?.itemsBroken ?? 0,
          shouts: storedPlayer.stats?.shouts ?? 0,
          pivotShouts: storedPlayer.stats?.pivotShouts ?? 0,
        },
      };
      this.players.set(player.id, player);
    }

    if (this.phase !== "lobby") {
      this.buildPhysics(saved.checkpoint ?? undefined, new Set(saved.brokenBreakableIds ?? []));
    }

    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      const playerId = attachment?.playerId;
      const player = playerId ? this.players.get(playerId) : undefined;
      if (!player) continue;
      player.connected = true;
      player.lastSeenAt = Date.now();
      this.socketPlayers.set(socket, player.id);
      this.playerSockets.set(player.id, socket);
    }

    for (const playerId of this.roundPlayerIds) {
      const player = this.players.get(playerId);
      if (player && !player.connected && player.gripped) this.releaseGrip(player);
    }

    if ((this.phase === "playing" || this.phase === "countdown") && !this.allRoundPlayersConnected()) {
      this.pauseForDisconnect();
    } else if (this.phase === "playing" || this.phase === "countdown") {
      this.ensureTicking();
    }
  }

  private async handleHello(socket: WebSocket, message: JsonObject): Promise<void> {
    if (!validProfile(message.profile)) {
      this.sendError(socket, "BAD_PROFILE", "Choose a valid mover color and hat.");
      return;
    }

    const candidateToken = typeof message.sessionToken === "string" &&
      SESSION_TOKEN_PATTERN.test(message.sessionToken)
      ? message.sessionToken
      : null;
    let player = candidateToken
      ? [...this.players.values()].find((entry) => entry.sessionToken === candidateToken)
      : undefined;
    const isRejoin = Boolean(player);

    if (!player) {
      if (this.players.size >= MAX_PLAYERS) {
        this.closeWithError(socket, "ROOM_FULL", "This moving crew already has four players.");
        return;
      }
      const slot = this.nextOpenSlot();
      const id = crypto.randomUUID();
      const now = Date.now();
      player = {
        id,
        sessionToken: makeSessionToken(),
        slot,
        label: `MOVER ${slot + 1}`,
        profile: message.profile,
        ready: false,
        connected: true,
        host: ![...this.players.values()].some((entry) => entry.host),
        spectator: this.phase !== "lobby",
        gripped: false,
        joinedAt: now,
        lastSeenAt: now,
        lastInputSeq: -1,
        moveX: 0,
        moveY: 0,
        handleIndex: null,
        shout: null,
        lastGripAt: 0,
        lastShoutAt: 0,
        stats: { damageCaused: 0, itemsBroken: 0, shouts: 0, pivotShouts: 0 },
      };
      this.players.set(id, player);
    } else {
      const oldSocket = this.playerSockets.get(player.id);
      if (oldSocket && oldSocket !== socket) {
        this.socketPlayers.delete(oldSocket);
        try {
          oldSocket.close(4001, "Reconnected in another tab");
        } catch {
          // It may already have closed; the new socket remains authoritative.
        }
      }
      player.connected = true;
      player.lastSeenAt = Date.now();
      player.profile = message.profile;
      player.moveX = 0;
      player.moveY = 0;
    }

    this.socketPlayers.set(socket, player.id);
    this.playerSockets.set(player.id, socket);
    socket.serializeAttachment({ playerId: player.id } satisfies SocketAttachment);
    this.ensureHost();

    this.send(socket, {
      type: "welcome",
      playerId: player.id,
      sessionToken: player.sessionToken,
      serverTime: Date.now(),
      room: this.roomView(),
      level: this.level,
    });

    if (isRejoin) {
      this.broadcast({
        type: "notice",
        kind: "player_rejoined",
        message: `${player.label} is back on the job!`,
      });
    }

    if (this.phase === "paused" && this.allRoundPlayersConnected()) {
      this.resumeAfterDisconnect();
    }
    this.broadcastRoomState();
    this.broadcastSnapshot();
    await this.persistNow();
  }

  private async handlePlayerMessage(
    socket: WebSocket,
    player: PlayerRecord,
    message: JsonObject,
  ): Promise<void> {
    player.lastSeenAt = Date.now();

    switch (message.type) {
      case "set_profile": {
        if (this.phase !== "lobby") {
          this.sendError(socket, "LOBBY_ONLY", "Outfits can be changed in the lobby.");
          return;
        }
        if (!validProfile(message.profile)) {
          this.sendError(socket, "BAD_PROFILE", "Choose a valid mover color and hat.");
          return;
        }
        player.profile = message.profile;
        this.broadcastRoomState();
        await this.persistNow();
        return;
      }

      case "set_ready": {
        if (this.phase !== "lobby" || typeof message.ready !== "boolean") {
          this.sendError(socket, "BAD_READY", "Ready state can only change in the lobby.");
          return;
        }
        player.ready = message.ready;
        this.broadcastRoomState();
        await this.persistNow();
        return;
      }

      case "select_level": {
        await this.selectLevel(socket, player, message);
        return;
      }

      case "start_game": {
        await this.startGame(socket, player);
        return;
      }

      case "move": {
        this.handleMove(socket, player, message);
        return;
      }

      case "grip_toggle": {
        this.handleGripToggle(socket, player, message);
        return;
      }

      case "shout": {
        this.handleShout(socket, player, message);
        return;
      }

      case "play_again": {
        await this.playAgain(socket, player);
        return;
      }

      case "next_level": {
        await this.nextLevel(socket, player);
        return;
      }

      case "leave_room": {
        await this.leaveRoom(socket, player);
        return;
      }

      case "ping": {
        if (!isFiniteNumber(message.clientTime)) return;
        this.send(socket, {
          type: "pong",
          clientTime: message.clientTime,
          serverTime: Date.now(),
        });
        return;
      }

      case "hello": {
        this.sendError(socket, "ALREADY_JOINED", "This connection already has a mover.");
        return;
      }

      default:
        this.sendError(socket, "UNKNOWN_MESSAGE", "That command was not understood.");
    }
  }

  private async startGame(socket: WebSocket, player: PlayerRecord): Promise<void> {
    if (this.phase !== "lobby") {
      this.sendError(socket, "ALREADY_STARTED", "The move has already started.");
      return;
    }
    if (!player.host) {
      this.sendError(socket, "HOST_ONLY", "Only the host can start the move.");
      return;
    }

    const crew = [...this.players.values()]
      .filter((entry) => entry.connected && !entry.spectator)
      .sort((a, b) => a.slot - b.slot);
    if (crew.length < MIN_PLAYERS) {
      this.sendError(socket, "NEED_MORE_MOVERS", "At least two movers are required.");
      return;
    }
    if (!crew.every((entry) => entry.ready)) {
      this.sendError(socket, "NOT_READY", "Every mover needs to be ready.");
      return;
    }

    this.roundPlayerIds = crew.map((entry) => entry.id);
    this.startFreshRound(false);
    await this.persistNow();
  }

  private async playAgain(socket: WebSocket, player: PlayerRecord): Promise<void> {
    if (this.phase !== "complete" && this.phase !== "failed") {
      this.sendError(socket, "ROUND_ACTIVE", "Finish this delivery before replaying it.");
      return;
    }
    if (!player.host) {
      this.sendError(socket, "HOST_ONLY", "Only the host can restart the level.");
      return;
    }

    const crew = [...this.players.values()]
      .filter((entry) => entry.connected)
      .sort((a, b) => a.slot - b.slot)
      .slice(0, MAX_PLAYERS);
    if (crew.length < MIN_PLAYERS) {
      this.sendError(socket, "NEED_MORE_MOVERS", "At least two movers are required.");
      return;
    }
    for (const entry of this.players.values()) entry.spectator = !crew.includes(entry);
    this.roundPlayerIds = crew.map((entry) => entry.id);
    this.startFreshRound(false);
    await this.persistNow();
  }

  private async selectLevel(socket: WebSocket, player: PlayerRecord, message: JsonObject): Promise<void> {
    if (this.phase !== "lobby") {
      this.sendError(socket, "LOBBY_ONLY", "Jobs can only be selected in the lobby.");
      return;
    }
    if (!player.host) {
      this.sendError(socket, "HOST_ONLY", "Only the foreman can choose the job.");
      return;
    }
    if (!Number.isSafeInteger(message.levelIndex)) {
      this.sendError(socket, "BAD_LEVEL", "Choose a valid job from the clipboard.");
      return;
    }
    const levelIndex = message.levelIndex as number;
    if (levelIndex < 0 || levelIndex >= LEVELS.length) {
      this.sendError(socket, "BAD_LEVEL", "That job is not on the clipboard.");
      return;
    }
    const changed = levelIndex !== this.currentLevelIndex;
    if (changed) {
      this.currentLevelIndex = levelIndex;
      this.catTargetIndex = 0;
      this.catDirection = 1;
      this.catAvoidUntil = 0;
    }
    this.broadcastLevelState();
    this.broadcastRoomState();
    if (changed) await this.persistNow();
  }

  private async nextLevel(socket: WebSocket, player: PlayerRecord): Promise<void> {
    if (this.phase !== "complete") {
      this.sendError(socket, "NOT_COMPLETE", "Complete this delivery before taking the next job.");
      return;
    }
    if (!player.host) {
      this.sendError(socket, "HOST_ONLY", "Only the host can choose the next job.");
      return;
    }
    if (this.currentLevelIndex >= LEVELS.length - 1) {
      this.sendError(socket, "NO_NEXT_LEVEL", "That was the last job on the clipboard.");
      return;
    }

    const crew = [...this.players.values()]
      .filter((entry) => entry.connected)
      .sort((a, b) => a.slot - b.slot)
      .slice(0, MAX_PLAYERS);
    if (crew.length < MIN_PLAYERS) {
      this.sendError(socket, "NEED_MORE_MOVERS", "At least two movers are required.");
      return;
    }
    for (const entry of this.players.values()) entry.spectator = !crew.includes(entry);
    this.roundPlayerIds = crew.map((entry) => entry.id);
    this.currentLevelIndex += 1;
    this.broadcastLevelState();
    this.startFreshRound(false);
    await this.persistNow();
  }

  private async leaveRoom(socket: WebSocket, player: PlayerRecord): Promise<void> {
    const activeRound = this.phase === "playing" || this.phase === "countdown" || this.phase === "paused";
    const checkpoint = activeRound ? this.checkpoint() : null;
    this.socketPlayers.delete(socket);
    if (this.playerSockets.get(player.id) === socket) this.playerSockets.delete(player.id);
    this.releaseGrip(player);
    this.players.delete(player.id);
    this.roundPlayerIds = this.roundPlayerIds.filter((id) => id !== player.id);
    const wasHost = player.host;
    const newHost = wasHost ? this.ensureHost() : null;
    if (newHost) {
      this.broadcast({
        type: "notice",
        kind: "host_changed",
        message: `${newHost.label} has the clipboard now.`,
      });
    }

    if (activeRound) {
      if (this.roundPlayerIds.length >= MIN_PLAYERS && this.allRoundPlayersConnected()) {
        for (const remaining of this.players.values()) this.releaseGrip(remaining);
        this.deliveryHoldMs = 0;
        this.pausedFrom = null;
        this.pausedReason = null;
        this.phase = "countdown";
        this.resumeCountdown = true;
        this.countdownEndsAt = Date.now() + RESUME_COUNTDOWN_MS;
        const brokenIds = new Set(
          [...this.breakables.values()].filter((item) => item.broken).map((item) => item.definition.id),
        );
        this.buildPhysics(checkpoint ?? undefined, brokenIds);
        this.ensureTicking();
      } else {
        this.stopTicking();
        this.phase = "lobby";
        this.roundPlayerIds = [];
        this.countdownEndsAt = null;
        this.pausedReason = null;
        this.result = null;
        for (const remaining of this.players.values()) {
          remaining.ready = false;
          remaining.spectator = false;
          remaining.gripped = false;
          remaining.handleIndex = null;
        }
      }
    }
    this.broadcastRoomState();
    this.broadcastSnapshot();
    await this.persistNow();
    try {
      socket.close(1000, "left room");
    } catch {
      // Socket may already be closed by the client.
    }
  }

  private startFreshRound(isResume: boolean): void {
    for (const player of this.players.values()) {
      player.gripped = false;
      player.handleIndex = null;
      player.moveX = 0;
      player.moveY = 0;
      player.shout = null;
      player.lastInputSeq = -1;
      player.stats = { damageCaused: 0, itemsBroken: 0, shouts: 0, pivotShouts: 0 };
    }
    this.elapsedMs = 0;
    this.deliveryHoldMs = 0;
    this.tickNumber = 0;
    this.couchHp = COUCH_MAX_HP;
    this.itemsPenalty = 0;
    this.result = null;
    this.worstCrash = null;
    this.worstCrashSeverity = 0;
    this.replayHistory = [];
    this.replayCaptureRemaining = 0;
    this.recentEvents = [];
    this.nextEventId = 1;
    this.catTargetIndex = 0;
    this.catDirection = 1;
    this.catAvoidUntil = 0;
    this.pausedFrom = null;
    this.pausedCountdownRemainingMs = 0;
    this.pausedReason = null;
    this.resumeCountdown = isResume;
    this.phase = "countdown";
    this.countdownEndsAt = Date.now() + COUNTDOWN_MS;
    this.buildPhysics();
    this.ensureTicking();
    this.broadcastRoomState();
    this.broadcastSnapshot();
  }

  private handleMove(socket: WebSocket, player: PlayerRecord, message: JsonObject): void {
    if (!this.roundPlayerIds.includes(player.id) || player.spectator) return;
    if (this.phase !== "playing" && this.phase !== "countdown" && this.phase !== "paused") return;
    if (!this.consumeMoveRate(socket)) return;
    if (!Number.isSafeInteger(message.seq) || (message.seq as number) <= player.lastInputSeq) return;
    if (!isFiniteNumber(message.x) || !isFiniteNumber(message.y)) return;

    player.lastInputSeq = message.seq as number;
    const input = normalizedInput(message.x, message.y);
    player.moveX = input.x;
    player.moveY = input.y;
  }

  private handleGripToggle(socket: WebSocket, player: PlayerRecord, message: JsonObject): void {
    if (this.phase !== "playing" && this.phase !== "countdown") return;
    if (!this.roundPlayerIds.includes(player.id) || player.spectator) return;
    if (!Number.isSafeInteger(message.seq) || (message.seq as number) <= player.lastInputSeq) return;
    const now = Date.now();
    if (now - player.lastGripAt < GRIP_DEBOUNCE_MS) return;

    player.lastInputSeq = message.seq as number;
    player.lastGripAt = now;
    if (player.gripped) {
      this.releaseGrip(player);
      this.broadcastSnapshot();
      return;
    }

    if (!this.tryGrip(player)) {
      this.send(socket, {
        type: "notice",
        kind: "grip_miss",
        message: this.level.mechanic === "rope-climb"
          ? "Get closer to your rope end!"
          : "Get closer to your glowing handle!",
      });
    }
    this.broadcastSnapshot();
  }

  private handleShout(socket: WebSocket, player: PlayerRecord, message: JsonObject): void {
    if (this.phase === "lobby" || this.phase === "complete" || this.phase === "failed") return;
    if (!isShout(message.phrase)) {
      this.sendError(socket, "BAD_SHOUT", `Pick one of: ${SHOUTS.join(", ")}`);
      return;
    }
    const now = Date.now();
    if (now - player.lastShoutAt < SHOUT_COOLDOWN_MS) return;
    player.lastShoutAt = now;
    player.shout = { phrase: message.phrase, expiresAt: now + SHOUT_DURATION_MS };
    player.stats.shouts += 1;
    if (message.phrase === "PIVOT!") player.stats.pivotShouts += 1;
    this.broadcastSnapshot();
  }

  private buildPhysics(checkpoint?: PhysicsCheckpoint, brokenIds = new Set<string>()): void {
    this.stopTicking();
    this.engine = Matter.Engine.create({ enableSleeping: false });
    this.engine.gravity.x = 0;
    this.engine.gravity.y = 0;
    this.engine.gravity.scale = 0;
    this.moverBodies.clear();
    this.gripConstraints.clear();
    this.ropeGrips.clear();
    this.handleIndices.clear();
    this.breakables.clear();
    this.cat = null;
    this.catAvoidUntil = 0;
    this.impactCooldowns.clear();

    const walls = this.level.walls.map((wall) => Matter.Bodies.rectangle(
      wall.x,
      wall.y,
      wall.width,
      wall.height,
      {
        isStatic: true,
        label: `wall:${wall.id}`,
        restitution: 0.08,
        friction: 0.65,
      },
    ));

    this.couch = Matter.Bodies.rectangle(
      this.level.couchStart.x,
      this.level.couchStart.y,
      COUCH_WIDTH,
      COUCH_HEIGHT,
      {
        label: "couch",
        chamfer: { radius: 8 },
        friction: 0.48,
        frictionAir: 0.075,
        restitution: 0.08,
        density: 0.004,
        ...(this.level.mechanic === "rope-climb" ? {
          collisionFilter: { category: COUCH_COLLISION_CATEGORY, mask: 0xffffffff },
        } : {}),
      },
    );
    Matter.Body.setAngle(this.couch, this.level.couchStart.angle);
    Matter.Body.setMass(
      this.couch,
      (4 + this.roundPlayerIds.length * 6) * this.level.couchMassScale,
    );

    const bodies: Matter.Body[] = [this.couch, ...walls];
    const handles = getHandlePoints(this.roundPlayerIds.length);
    this.roundPlayerIds.forEach((playerId, index) => {
      const handle = handles[index];
      const configuredSpawn = this.level.moverSpawns[index] ?? this.level.moverSpawns[0];
      const outward = handle ? Matter.Vector.mult(Matter.Vector.normalise(handle), 42) : null;
      const cornerSpawn = handle && outward
        ? Matter.Vector.add(
            this.level.couchStart,
            Matter.Vector.rotate(Matter.Vector.add(handle, outward), this.level.couchStart.angle),
          )
        : null;
      const spawn = this.level.mechanic === "rope-climb"
        ? configuredSpawn
        : this.roundPlayerIds.length > 2
          ? cornerSpawn
          : configuredSpawn;
      if (!spawn) return;
      const mover = Matter.Bodies.circle(spawn.x, spawn.y, MOVER_RADIUS, {
        label: `mover:${playerId}`,
        friction: 0.1,
        frictionAir: 0.18,
        restitution: 0.12,
        density: 0.0025,
        ...(this.level.mechanic === "rope-climb" ? {
          collisionFilter: { category: MOVER_COLLISION_CATEGORY, mask: EVERYTHING_EXCEPT_COUCH_MASK },
        } : {}),
      });
      Matter.Body.setMass(mover, 2.4);
      this.moverBodies.set(playerId, mover);
      bodies.push(mover);
      const handleIndex = Math.min(index, handles.length - 1);
      this.handleIndices.set(playerId, handleIndex);
      const player = this.players.get(playerId);
      if (player) player.handleIndex = handleIndex;
    });

    for (const definition of this.level.breakables) {
      const broken = brokenIds.has(definition.id);
      const saved = checkpoint?.breakables[definition.id];
      const body = broken ? null : Matter.Bodies.rectangle(
        saved?.x ?? definition.x,
        saved?.y ?? definition.y,
        definition.width,
        definition.height,
        {
          label: `breakable:${definition.id}`,
          chamfer: { radius: Math.min(8, definition.width / 4, definition.height / 4) },
          density: 0.0012,
          friction: 0.2,
          frictionAir: 0.12,
          restitution: 0.42,
        },
      );
      if (body && saved) applyBodySnapshot(body, saved);
      this.breakables.set(definition.id, {
        definition,
        body,
        x: saved?.x ?? definition.x,
        y: saved?.y ?? definition.y,
        angle: saved?.angle ?? 0,
        broken,
      });
      if (body) bodies.push(body);
    }

    const catDefinition = this.level.cat;
    if (catDefinition) {
      this.cat = Matter.Bodies.circle(
        checkpoint?.cat?.x ?? catDefinition.start.x,
        checkpoint?.cat?.y ?? catDefinition.start.y,
        catDefinition.radius,
        {
          label: "cat",
          density: 0.012,
          friction: 0.08,
          frictionAir: 0.08,
          restitution: 0.82,
        },
      );
      Matter.Body.setMass(this.cat, 11);
      Matter.Body.setInertia(this.cat, Infinity);
      if (checkpoint?.cat) applyBodySnapshot(this.cat, checkpoint.cat);
      bodies.push(this.cat);
    }

    Matter.Composite.add(this.engine.world, bodies);

    Matter.Events.on(this.engine, "collisionStart", (event) => {
      for (const pair of event.pairs) this.handleCollision(pair.bodyA, pair.bodyB);
    });

    if (checkpoint && this.couch) {
      applyBodySnapshot(this.couch, checkpoint.couch);
      for (const [playerId, mover] of this.moverBodies) {
        const savedMover = checkpoint.movers[playerId];
        if (savedMover) applyBodySnapshot(mover, savedMover);
      }
      for (const [id, breakable] of this.breakables) {
        const savedBreakable = checkpoint.breakables[id];
        if (breakable.body && savedBreakable) applyBodySnapshot(breakable.body, savedBreakable);
      }
      for (const playerId of this.roundPlayerIds) {
        const player = this.players.get(playerId);
        if (player?.gripped) this.createGripConstraint(player);
      }
    }
  }

  private handleCollision(first: Matter.Body, second: Matter.Body): void {
    const now = Date.now();
    const firstLabel = first.label;
    const secondLabel = second.label;
    const relativeSpeed = Matter.Vector.magnitude(Matter.Vector.sub(first.velocity, second.velocity));

    const breakableBody = firstLabel.startsWith("breakable:")
      ? first
      : secondLabel.startsWith("breakable:")
        ? second
        : null;
    if (breakableBody) {
      const other = breakableBody === first ? second : first;
      // Mr. Pickles is the homeowner's liability, not the crew's. Cat patrols
      // may jostle props, but only the couch or a mover can create a score penalty.
      if (relativeSpeed >= BREAK_IMPACT_SPEED && (
        other.label === "couch" || other.label.startsWith("mover:")
      )) {
        const directPlayerId = other.label.startsWith("mover:") ? other.label.slice(6) : null;
        this.breakItem(breakableBody.label.slice(10), directPlayerId ?? this.pickBlamePlayer());
      }
    }

    const couch = firstLabel === "couch" ? first : secondLabel === "couch" ? second : null;
    if (!couch) return;
    const other = couch === first ? second : first;

    if (other.label === "cat") {
      const cooldownKey = "cat-bump";
      if (now - (this.impactCooldowns.get(cooldownKey) ?? 0) >= IMPACT_COOLDOWN_MS) {
        this.impactCooldowns.set(cooldownKey, now);
        this.reverseCatAfterCouchHit(couch, other, relativeSpeed, now);
        this.pushEvent("cat_bump", other.position.x, other.position.y, 0, "MR. PICKLES!", this.pickBlamePlayer());
      }
      return;
    }

    if (!other.label.startsWith("wall:")) return;
    const impactThreshold = this.level.mechanic === "rope-climb"
      ? LADDER_SETTLING_IMPACT_SPEED
      : COUCH_IMPACT_SPEED;
    if (relativeSpeed < impactThreshold) return;
    const cooldownKey = other.label;
    if (now - (this.impactCooldowns.get(cooldownKey) ?? 0) < IMPACT_COOLDOWN_MS) return;
    this.impactCooldowns.set(cooldownKey, now);

    const difficulty = 1 + this.currentLevelIndex * 0.12;
    const damage = clamp(Math.round(2 + (relativeSpeed - impactThreshold) * 8 * difficulty), 2, 18);
    this.couchHp = clamp(this.couchHp - damage, 0, COUCH_MAX_HP);
    const blamedPlayerId = this.pickBlamePlayer();
    const blamedPlayer = blamedPlayerId ? this.players.get(blamedPlayerId) : undefined;
    if (blamedPlayer) blamedPlayer.stats.damageCaused += damage;
    const impactEvent = this.pushEvent("impact", couch.position.x, couch.position.y, damage, `-${damage} HP`, blamedPlayerId);
    this.beginCrashReplay(impactEvent, damage);
    this.broadcastRoomState();
  }

  private breakItem(id: string, blamedPlayerId: string | null): void {
    const item = this.breakables.get(id);
    if (!item || item.broken) return;
    item.broken = true;
    if (item.body) {
      item.x = item.body.position.x;
      item.y = item.body.position.y;
      item.angle = item.body.angle;
      if (this.engine) Matter.Composite.remove(this.engine.world, item.body);
      item.body = null;
    }
    this.itemsPenalty += item.definition.value;
    const blamedPlayer = blamedPlayerId ? this.players.get(blamedPlayerId) : undefined;
    if (blamedPlayer) blamedPlayer.stats.itemsBroken += 1;
    const breakEvent = this.pushEvent(
      "break",
      item.x,
      item.y,
      item.definition.value,
      `-$${item.definition.value}`,
      blamedPlayerId,
    );
    this.beginCrashReplay(breakEvent, item.definition.value / 20);
    this.broadcastRoomState();
  }

  private pickBlamePlayer(): string | null {
    let best: { id: string; score: number } | null = null;
    for (const playerId of this.roundPlayerIds) {
      const player = this.players.get(playerId);
      const mover = this.moverBodies.get(playerId);
      if (!player || !mover || !player.connected) continue;
      const speed = Matter.Vector.magnitude(mover.velocity);
      const input = Math.hypot(player.moveX, player.moveY);
      const score = speed + input * 1.5 + (player.gripped ? 0.75 : 0);
      if (!best || score > best.score) best = { id: playerId, score };
    }
    return best?.id ?? null;
  }

  private pushEvent(
    kind: GameEvent["kind"],
    x: number,
    y: number,
    amount: number,
    text: string,
    playerId: string | null,
  ): GameEvent {
    const event = { id: this.nextEventId, kind, at: Date.now(), x, y, amount, text, playerId } satisfies GameEvent;
    this.recentEvents.push(event);
    this.nextEventId += 1;
    if (this.recentEvents.length > 16) this.recentEvents.splice(0, this.recentEvents.length - 16);
    return event;
  }

  private beginCrashReplay(event: GameEvent, severity: number): void {
    if (severity <= this.worstCrashSeverity) return;
    this.worstCrashSeverity = severity;
    this.worstCrash = { event, frames: [...this.replayHistory] };
    this.replayCaptureRemaining = REPLAY_AFTER_FRAMES;
  }

  private replayFrame(at: number): ReplayFrame | null {
    if (!this.couch) return null;
    const players = this.roundPlayerIds.flatMap((playerId) => {
      const player = this.players.get(playerId);
      const mover = this.moverBodies.get(playerId);
      if (!player || !mover) return [];
      return [{
        id: player.id,
        slot: player.slot,
        profile: player.profile,
        x: mover.position.x,
        y: mover.position.y,
        angle: mover.angle,
        gripped: player.gripped,
      }];
    });
    return {
      at,
      couch: { x: this.couch.position.x, y: this.couch.position.y, angle: this.couch.angle, hp: this.couchHp },
      players,
    };
  }

  private captureReplayFrame(at: number): void {
    const frame = this.replayFrame(at);
    if (!frame) return;
    this.replayHistory.push(frame);
    if (this.replayHistory.length > REPLAY_HISTORY_FRAMES) {
      this.replayHistory.splice(0, this.replayHistory.length - REPLAY_HISTORY_FRAMES);
    }
    if (!this.worstCrash || this.replayCaptureRemaining <= 0) return;
    this.worstCrash.frames.push(frame);
    this.replayCaptureRemaining -= 1;
  }

  private tryGrip(player: PlayerRecord): boolean {
    const mover = this.moverBodies.get(player.id);
    const couch = this.couch;
    const handleIndex = this.handleIndices.get(player.id);
    if (!mover || !couch || handleIndex === undefined) return false;
    const localHandle = getHandlePoints(this.roundPlayerIds.length)[handleIndex];
    if (!localHandle) return false;
    const rotated = Matter.Vector.rotate(localHandle, couch.angle);
    const worldHandle = Matter.Vector.add(couch.position, rotated);
    const gripDistance = this.level.mechanic === "rope-climb"
      ? (this.level.ropeLength ?? GRIP_DISTANCE) + ROPE_GRIP_SLACK
      : GRIP_DISTANCE;
    if (Matter.Vector.magnitude(Matter.Vector.sub(mover.position, worldHandle)) > gripDistance) {
      return false;
    }

    player.gripped = true;
    player.handleIndex = handleIndex;
    this.createGripConstraint(player);
    return true;
  }

  private createGripConstraint(player: PlayerRecord): void {
    if (this.gripConstraints.has(player.id) || this.ropeGrips.has(player.id)) return;
    const mover = this.moverBodies.get(player.id);
    const couch = this.couch;
    const handleIndex = this.handleIndices.get(player.id);
    const localHandle = handleIndex === undefined
      ? undefined
      : getHandlePoints(this.roundPlayerIds.length)[handleIndex];
    if (!this.engine || !mover || !couch || !localHandle) return;

    if (this.level.mechanic === "rope-climb") {
      this.ropeGrips.add(player.id);
      return;
    }

    const constraint = Matter.Constraint.create({
      bodyA: mover,
      pointA: { x: 0, y: 0 },
      bodyB: couch,
      pointB: localHandle,
      length: 36,
      stiffness: 0.22,
      damping: 0.18,
      label: `grip:${player.id}`,
    });
    this.gripConstraints.set(player.id, constraint);
    Matter.Composite.add(this.engine.world, constraint);
  }

  private releaseGrip(player: PlayerRecord): void {
    const constraint = this.gripConstraints.get(player.id);
    if (constraint && this.engine) Matter.Composite.remove(this.engine.world, constraint);
    this.gripConstraints.delete(player.id);
    this.ropeGrips.delete(player.id);
    player.gripped = false;
  }

  private applyRopeTension(player: PlayerRecord, mover: Matter.Body): void {
    const couch = this.couch;
    const handleIndex = this.handleIndices.get(player.id);
    const localHandle = handleIndex === undefined
      ? undefined
      : getHandlePoints(this.roundPlayerIds.length)[handleIndex];
    if (!couch || !localHandle || !this.ropeGrips.has(player.id)) return;

    const offset = Matter.Vector.rotate(localHandle, couch.angle);
    const worldHandle = Matter.Vector.add(couch.position, offset);
    const rope = Matter.Vector.sub(mover.position, worldHandle);
    const distance = Matter.Vector.magnitude(rope);
    const restingLength = this.level.ropeLength ?? 142;
    if (distance <= restingLength || distance < 0.001) return;

    const direction = Matter.Vector.mult(rope, 1 / distance);
    const handleVelocity = {
      x: couch.velocity.x - offset.y * couch.angularVelocity,
      y: couch.velocity.y + offset.x * couch.angularVelocity,
    };
    const separatingSpeed = Matter.Vector.dot(
      Matter.Vector.sub(mover.velocity, handleVelocity),
      direction,
    );
    const tension = clamp(
      (distance - restingLength) * ROPE_STIFFNESS + separatingSpeed * ROPE_DAMPING,
      0,
      ROPE_MAX_TENSION,
    );
    if (tension <= 0) return;

    const force = Matter.Vector.mult(direction, tension);
    Matter.Body.applyForce(couch, worldHandle, force);
    Matter.Body.applyForce(mover, mover.position, Matter.Vector.neg(force));
  }

  private ensureTicking(): void {
    if (this.tickTimer !== null) return;
    this.lastCheckpointAt = Date.now();
    this.tickTimer = setInterval(() => this.tick(), SERVER_TICK_MS);
  }

  private stopTicking(): void {
    if (this.tickTimer === null) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private tick(): void {
    const now = Date.now();
    if (this.phase === "countdown") {
      if (this.countdownEndsAt !== null && now >= this.countdownEndsAt) {
        this.phase = "playing";
        this.countdownEndsAt = null;
        this.resumeCountdown = false;
        this.broadcastRoomState();
        void this.persistSoon();
      } else {
        this.tickNumber += 1;
        this.broadcastSnapshot();
        return;
      }
    }

    if (this.phase !== "playing" || !this.engine || !this.couch) {
      this.stopTicking();
      return;
    }

    for (let substep = 0; substep < PHYSICS_SUBSTEPS; substep += 1) {
      for (const playerId of this.roundPlayerIds) {
        const player = this.players.get(playerId);
        const mover = this.moverBodies.get(playerId);
        if (!player || !mover || !player.connected) continue;
        const isLadderJob = (this.level.ladders?.length ?? 0) > 0;
        const activeLadder = isLadderJob
          ? getClimbableLadder(this.level, mover.position, player.gripped, MOVER_RADIUS)
          : undefined;
        const canClimb = activeLadder !== undefined;
        const moveY = isLadderJob && !canClimb ? 0 : player.moveY;
        const ladderCentering = activeLadder && Math.abs(player.moveY) > 0.1
          ? clamp((activeLadder.x - mover.position.x) / 42 - mover.velocity.x * 0.12, -0.7, 0.7)
          : 0;
        Matter.Body.applyForce(mover, mover.position, {
          x: (player.moveX + ladderCentering) * MOVER_FORCE * PHYSICS_SUBSTEPS * this.level.moverForceScale * mover.mass,
          y: moveY * MOVER_FORCE * PHYSICS_SUBSTEPS * this.level.moverForceScale * mover.mass,
        });
        if (isLadderJob && this.level.ladderGravity) {
          Matter.Body.applyForce(mover, mover.position, {
            x: 0,
            y: this.level.ladderGravity * PHYSICS_SUBSTEPS * mover.mass,
          });
        }
        if (player.gripped && this.level.mechanic === "rope-climb") {
          this.applyRopeTension(player, mover);
        }
      }
      const slopeForce = this.level.slopeForce;
      if (this.level.mechanic === "rope-climb" && slopeForce) {
        Matter.Body.applyForce(this.couch, this.couch.position, {
          x: slopeForce.x * PHYSICS_SUBSTEPS * this.couch.mass,
          y: slopeForce.y * PHYSICS_SUBSTEPS * this.couch.mass,
        });
      }
      if (this.level.mechanic === "rope-climb" && this.level.ladderGravity) {
        for (const breakable of this.breakables.values()) {
          if (!breakable.body) continue;
          Matter.Body.applyForce(breakable.body, breakable.body.position, {
            x: 0,
            y: this.level.ladderGravity * PHYSICS_SUBSTEPS * breakable.body.mass,
          });
        }
      }
      this.steerCat();
      Matter.Engine.update(this.engine, SERVER_TICK_MS / PHYSICS_SUBSTEPS);
    }
    for (const mover of this.moverBodies.values()) {
      const speed = Matter.Vector.magnitude(mover.velocity);
      if (speed > MOVER_MAX_SPEED) {
        Matter.Body.setVelocity(mover, Matter.Vector.mult(mover.velocity, MOVER_MAX_SPEED / speed));
      }
    }

    this.elapsedMs += SERVER_TICK_MS;
    this.tickNumber += 1;
    this.captureReplayFrame(now);
    this.recentEvents = this.recentEvents.filter((event) => now - event.at <= EVENT_LIFETIME_MS);
    for (const breakable of this.breakables.values()) {
      if (!breakable.body) continue;
      breakable.x = breakable.body.position.x;
      breakable.y = breakable.body.position.y;
      breakable.angle = breakable.body.angle;
    }
    if (this.isCouchInsideTarget()) {
      this.deliveryHoldMs += SERVER_TICK_MS;
    } else {
      // A single physics wobble should not erase an otherwise steady delivery.
      this.deliveryHoldMs = Math.max(0, this.deliveryHoldMs - SERVER_TICK_MS * DELIVERY_PROGRESS_DECAY);
    }

    for (const player of this.players.values()) {
      if (player.shout && player.shout.expiresAt <= now) player.shout = null;
    }

    if (this.couchHp <= 0) {
      this.finishRound(false);
      return;
    }

    if (this.deliveryHoldMs >= DELIVERY_HOLD_MS) {
      this.deliveryHoldMs = DELIVERY_HOLD_MS;
      this.finishRound(true);
      return;
    }

    this.broadcastSnapshot();
    if (now - this.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
      this.lastCheckpointAt = now;
      void this.persistSoon();
    }
  }

  private steerCat(): void {
    const catDefinition = this.level.cat;
    if (!this.cat || !catDefinition || catDefinition.path.length === 0) return;
    if (Date.now() < this.catAvoidUntil) return;
    const target = catDefinition.path[this.catTargetIndex] ?? catDefinition.path[0];
    if (!target) return;
    const delta = Matter.Vector.sub(target, this.cat.position);
    const distance = Matter.Vector.magnitude(delta);
    if (distance < Math.max(18, catDefinition.radius * 0.72)) {
      this.catTargetIndex = (
        this.catTargetIndex + this.catDirection + catDefinition.path.length
      ) % catDefinition.path.length;
      return;
    }
    const velocity = Matter.Vector.mult(Matter.Vector.normalise(delta), catDefinition.speed);
    Matter.Body.setVelocity(this.cat, velocity);
    Matter.Body.setAngle(this.cat, Math.atan2(velocity.y, velocity.x));
  }

  private reverseCatAfterCouchHit(
    couch: Matter.Body,
    cat: Matter.Body,
    relativeSpeed: number,
    now: number,
  ): void {
    const definition = this.level.cat;
    if (!definition || definition.path.length === 0) return;

    this.catDirection = this.catDirection === 1 ? -1 : 1;
    this.catTargetIndex = (
      this.catTargetIndex + this.catDirection + definition.path.length
    ) % definition.path.length;
    let away = Matter.Vector.sub(cat.position, couch.position);
    if (Matter.Vector.magnitudeSquared(away) < 0.001) {
      away = Matter.Vector.magnitudeSquared(cat.velocity) > 0.001
        ? Matter.Vector.neg(cat.velocity)
        : { x: this.catDirection, y: 0 };
    }
    const direction = Matter.Vector.normalise(away);
    const bounceSpeed = clamp(
      Math.max(definition.speed * 1.75, relativeSpeed * 1.2),
      definition.speed * 1.5,
      6.8,
    );
    const velocity = Matter.Vector.add(
      Matter.Vector.mult(direction, bounceSpeed),
      Matter.Vector.mult(couch.velocity, 0.2),
    );
    Matter.Body.setVelocity(cat, velocity);
    Matter.Body.setAngle(cat, Math.atan2(velocity.y, velocity.x));
    this.catAvoidUntil = now + CAT_BOUNCE_DURATION_MS;
  }

  private finishRound(success: boolean): void {
    this.phase = success ? "complete" : "failed";
    this.result = this.scoreResult();
    this.broadcastSnapshot();
    this.broadcastRoomState();
    this.stopTicking();
    void this.persistSoon();
  }

  private scoreResult(): LevelResult {
    const score = this.scoreSnapshot();
    const [, twoStars, threeStars] = this.level.starThresholds;
    const stars: 1 | 2 | 3 = score.score >= threeStars
      ? 3
      : score.score >= twoStars
        ? 2
        : 1;
    return {
      ...score,
      stars,
      elapsedMs: this.elapsedMs,
      hpRemaining: this.couchHp,
      brokenItems: [...this.breakables.values()].filter((item) => item.broken).length,
      worstCrash: this.worstCrash,
    };
  }

  private scoreSnapshot(): GameSnapshot["score"] {
    const timeDelta = this.level.parTimeMs - this.elapsedMs;
    const timeBonus = Math.max(500, this.level.baseScore + Math.round(timeDelta / 10));
    const damagePenalty = (COUCH_MAX_HP - this.couchHp) * DAMAGE_SCORE_MULTIPLIER;
    return {
      timeBonus,
      damagePenalty,
      itemsPenalty: this.itemsPenalty,
      score: Math.max(0, timeBonus - damagePenalty - this.itemsPenalty),
    };
  }

  private isCouchInsideTarget(): boolean {
    if (!this.couch) return false;
    const target = this.level.target;
    const left = target.x - target.width / 2 - DELIVERY_POSITION_GRACE;
    const right = target.x + target.width / 2 + DELIVERY_POSITION_GRACE;
    const top = target.y - target.height / 2 - DELIVERY_POSITION_GRACE;
    const bottom = target.y + target.height / 2 + DELIVERY_POSITION_GRACE;
    const inside = this.couch.vertices.every((vertex) => (
      vertex.x >= left && vertex.x <= right && vertex.y >= top && vertex.y <= bottom
    ));
    if (!inside || target.requiredAngle === undefined) return inside;
    const period = Math.PI;
    const rawDifference = Math.abs(this.couch.angle - target.requiredAngle) % period;
    const angleDifference = Math.min(rawDifference, period - rawDifference);
    return angleDifference <= (target.angleTolerance ?? 0.25) + DELIVERY_ANGLE_GRACE;
  }

  private snapshot(): GameSnapshot | null {
    if (!this.couch) return null;
    const now = Date.now();
    const players: SnapshotPlayer[] = [];
    for (const playerId of this.roundPlayerIds) {
      const player = this.players.get(playerId);
      const mover = this.moverBodies.get(playerId);
      if (!player || !mover) continue;
      players.push({
        ...bodySnapshot(mover),
        id: player.id,
        slot: player.slot,
        profile: player.profile,
        connected: player.connected,
        gripped: player.gripped,
        handleIndex: player.handleIndex,
        shout: player.shout && player.shout.expiresAt > now ? player.shout : null,
      });
    }
    return {
      type: "snapshot",
      tick: this.tickNumber,
      serverTime: now,
      phase: this.phase,
      levelIndex: this.currentLevelIndex,
      couch: { ...bodySnapshot(this.couch), hp: this.couchHp, maxHp: COUCH_MAX_HP },
      players,
      target: this.level.target,
      breakables: [...this.breakables.values()].map((item): BreakableSnapshot => ({
        id: item.definition.id,
        kind: item.definition.kind,
        value: item.definition.value,
        x: item.x,
        y: item.y,
        angle: item.angle,
        broken: item.broken,
      })),
      cat: this.cat ? ({
        ...bodySnapshot(this.cat),
        targetIndex: this.catTargetIndex,
        direction: this.catDirection,
      } satisfies CatSnapshot) : null,
      events: this.recentEvents,
      score: this.scoreSnapshot(),
      deliveryProgress: clamp(this.deliveryHoldMs / DELIVERY_HOLD_MS, 0, 1),
      elapsedMs: this.elapsedMs,
    };
  }

  private broadcastSnapshot(): void {
    const snapshot = this.snapshot();
    if (snapshot) this.broadcast(snapshot);
  }

  private roomView(): RoomView {
    const players = [...this.players.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((player): RoomPlayer => ({
        id: player.id,
        slot: player.slot,
        label: player.label,
        profile: player.profile,
        ready: player.ready,
        connected: player.connected,
        host: player.host,
        spectator: player.spectator,
        gripped: player.gripped,
        stats: player.stats,
      }));
    return {
      code: this.code,
      phase: this.phase,
      players,
      levelId: this.level.id,
      levelIndex: this.currentLevelIndex,
      totalLevels: LEVELS.length,
      countdownEndsAt: this.countdownEndsAt,
      pausedReason: this.pausedReason,
      elapsedMs: this.elapsedMs,
      result: this.result,
    };
  }

  private broadcastRoomState(): void {
    this.broadcast({
      type: "room_state",
      serverTime: Date.now(),
      room: this.roomView(),
    });
  }

  private broadcastLevelState(): void {
    this.broadcast({
      type: "level_state",
      serverTime: Date.now(),
      level: this.level,
    });
  }

  private async handleDisconnect(socket: WebSocket): Promise<void> {
    const playerId = this.socketPlayers.get(socket);
    this.socketPlayers.delete(socket);
    if (!playerId || this.playerSockets.get(playerId) !== socket) return;
    this.playerSockets.delete(playerId);

    const player = this.players.get(playerId);
    if (!player) return;
    player.connected = false;
    player.lastSeenAt = Date.now();
    player.moveX = 0;
    player.moveY = 0;
    this.releaseGrip(player);

    const wasHost = player.host;
    if (wasHost) {
      player.host = false;
      const newHost = this.ensureHost();
      if (newHost) {
        this.broadcast({
          type: "notice",
          kind: "host_changed",
          message: `${newHost.label} has the clipboard now.`,
        });
      }
    }

    if ((this.phase === "playing" || this.phase === "countdown") && this.roundPlayerIds.includes(playerId)) {
      this.pauseForDisconnect();
    }
    this.broadcastRoomState();
    this.broadcastSnapshot();
    await this.persistNow();
  }

  private pauseForDisconnect(): void {
    if (this.phase !== "playing" && this.phase !== "countdown") return;
    const now = Date.now();
    this.pausedFrom = this.phase;
    this.pausedCountdownRemainingMs = this.phase === "countdown" && this.countdownEndsAt !== null
      ? Math.max(0, this.countdownEndsAt - now)
      : 0;
    this.phase = "paused";
    this.countdownEndsAt = null;
    const missing = this.roundPlayerIds
      .map((id) => this.players.get(id))
      .find((entry) => entry && !entry.connected);
    this.pausedReason = missing ? `Waiting for ${missing.label} to reconnect...` : "Mover disconnected";
    this.stopTicking();
  }

  private resumeAfterDisconnect(): void {
    if (this.phase !== "paused") return;
    this.phase = "countdown";
    this.resumeCountdown = true;
    this.countdownEndsAt = Date.now() + Math.max(
      RESUME_COUNTDOWN_MS,
      this.pausedFrom === "countdown" ? this.pausedCountdownRemainingMs : 0,
    );
    this.pausedFrom = null;
    this.pausedCountdownRemainingMs = 0;
    this.pausedReason = null;
    this.ensureTicking();
  }

  private allRoundPlayersConnected(): boolean {
    return this.roundPlayerIds.length >= MIN_PLAYERS && this.roundPlayerIds.every((playerId) => {
      const player = this.players.get(playerId);
      return Boolean(player?.connected);
    });
  }

  private ensureHost(): PlayerRecord | null {
    const current = [...this.players.values()].find((player) => player.host && player.connected);
    if (current) return current;
    for (const player of this.players.values()) player.host = false;
    const next = [...this.players.values()]
      .filter((player) => player.connected)
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next) next.host = true;
    return next ?? null;
  }

  private nextOpenSlot(): number {
    const occupied = new Set([...this.players.values()].map((player) => player.slot));
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      if (!occupied.has(slot)) return slot;
    }
    return 0;
  }

  private consumeMessageRate(socket: WebSocket): boolean {
    const now = Date.now();
    let rate = this.rateWindows.get(socket);
    if (!rate) {
      rate = { startedAt: now, messages: 0, moveStartedAt: now, moves: 0 };
      this.rateWindows.set(socket, rate);
    }
    if (now - rate.startedAt >= 1_000) {
      rate.startedAt = now;
      rate.messages = 0;
    }
    rate.messages += 1;
    return rate.messages <= MAX_MESSAGES_PER_SECOND;
  }

  private consumeMoveRate(socket: WebSocket): boolean {
    const now = Date.now();
    const rate = this.rateWindows.get(socket);
    if (!rate) return true;
    if (now - rate.moveStartedAt >= 1_000) {
      rate.moveStartedAt = now;
      rate.moves = 0;
    }
    rate.moves += 1;
    return rate.moves <= MAX_MOVES_PER_SECOND;
  }

  private checkpoint(): PhysicsCheckpoint | null {
    if (!this.couch) return null;
    const movers: Record<string, SavedBody> = {};
    for (const [playerId, mover] of this.moverBodies) movers[playerId] = bodySnapshot(mover);
    const breakables: Record<string, SavedBody> = {};
    for (const [id, item] of this.breakables) {
      if (item.body) breakables[id] = bodySnapshot(item.body);
    }
    return {
      couch: bodySnapshot(this.couch),
      movers,
      breakables,
      cat: this.cat ? bodySnapshot(this.cat) : null,
    };
  }

  private persistedRoom(): PersistedRoom {
    return {
      version: 2,
      initialized: this.initialized,
      code: this.code,
      phase: this.phase,
      players: [...this.players.values()],
      roundPlayerIds: this.roundPlayerIds,
      countdownEndsAt: this.countdownEndsAt,
      resumeCountdown: this.resumeCountdown,
      pausedFrom: this.pausedFrom,
      pausedCountdownRemainingMs: this.pausedCountdownRemainingMs,
      pausedReason: this.pausedReason,
      elapsedMs: this.elapsedMs,
      deliveryHoldMs: this.deliveryHoldMs,
      tick: this.tickNumber,
      currentLevelIndex: this.currentLevelIndex,
      couchHp: this.couchHp,
      itemsPenalty: this.itemsPenalty,
      brokenBreakableIds: [...this.breakables.values()]
        .filter((item) => item.broken)
        .map((item) => item.definition.id),
      catTargetIndex: this.catTargetIndex,
      catDirection: this.catDirection,
      recentEvents: this.recentEvents,
      nextEventId: this.nextEventId,
      result: this.result,
      worstCrash: this.worstCrash,
      checkpoint: this.checkpoint(),
    };
  }

  private async persistNow(allowUnconfirmed = false): Promise<void> {
    if (!this.initialized) return;
    const room = this.persistedRoom();
    if (allowUnconfirmed) {
      // Physics checkpoints are recovery snapshots, not player-visible
      // transactions. Let WebSocket snapshots pass the Durable Object output
      // gate while this background write flushes; confirmed writes remain the
      // default for room creation and lifecycle transitions.
      await this.state.storage.put(STORAGE_KEY, room, { allowUnconfirmed: true });
      return;
    }
    await this.state.storage.put(STORAGE_KEY, room);
  }

  private async persistSoon(): Promise<void> {
    if (this.persistInFlight) {
      this.persistQueued = true;
      return;
    }
    this.persistInFlight = true;
    try {
      do {
        this.persistQueued = false;
        await this.persistNow(true);
      } while (this.persistQueued);
    } finally {
      this.persistInFlight = false;
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The close/error callback owns connection cleanup.
    }
  }

  private broadcast(message: ServerMessage): void {
    const encoded = JSON.stringify(message);
    for (const socket of this.socketPlayers.keys()) {
      if (socket.readyState !== 1) continue;
      try {
        socket.send(encoded);
      } catch {
        // The close/error callback owns connection cleanup.
      }
    }
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    this.send(socket, { type: "error", code, message });
  }

  private closeWithError(socket: WebSocket, code: string, message: string): void {
    this.sendError(socket, code, message);
    try {
      socket.close(1008, message.slice(0, 100));
    } catch {
      // Already closed.
    }
  }
}
