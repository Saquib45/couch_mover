import { useCallback, useEffect, useRef, useState } from "react";
import {
  clamp,
  normalizeRoomCode,
  type ClientMessage,
  type CreateRoomResponse,
  type GameSnapshot,
  type LevelDefinition,
  type PlayerProfile,
  type RoomView,
  type ServerMessage,
  type ShoutPhrase,
} from "@couch-movers/shared";

const configuredServer = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, "");

function defaultServerOrigin(): string {
  return configuredServer ?? window.location.origin;
}

function httpUrl(path: string): string {
  return `${defaultServerOrigin()}${path}`;
}

function websocketUrl(path: string): string {
  const url = new URL(path, `${defaultServerOrigin()}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function createRoom(): Promise<string> {
  let response: Response;
  try {
    response = await fetch(httpUrl("/api/rooms"), {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
  } catch {
    throw new Error("Could not reach the moving office. Check your connection and try again.");
  }

  if (!response.ok) {
    throw new Error(response.status >= 500 ? "The moving office is having a moment." : "Could not create that room.");
  }

  const result = (await response.json()) as CreateRoomResponse;
  const code = normalizeRoomCode(result.roomCode);
  if (code.length !== 6) throw new Error("The server returned a wonky room code.");
  return code;
}

export type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error";

export interface ClientNotice {
  id: number;
  kind: "info" | "warning" | "error";
  message: string;
}

export interface RoomConnection {
  status: ConnectionStatus;
  room: RoomView | null;
  level: LevelDefinition | null;
  playerId: string | null;
  latestSnapshot: GameSnapshot | null;
  snapshotBufferRef: React.RefObject<GameSnapshot[]>;
  clockOffsetRef: React.RefObject<number>;
  latencyRef: React.RefObject<number | null>;
  latency: number | null;
  notice: ClientNotice | null;
  error: string | null;
  connect: (code: string) => void;
  leave: () => void;
  dismissNotice: () => void;
  setProfile: (profile: PlayerProfile) => void;
  setReady: (ready: boolean) => void;
  selectLevel: (levelIndex: number) => void;
  startGame: () => void;
  sendMove: (x: number, y: number) => void;
  toggleGrip: () => void;
  shout: (phrase: ShoutPhrase) => void;
  playAgain: () => void;
  nextLevel: () => void;
}

const SESSION_PREFIX = "couch-movers:session:";
const SNAPSHOT_UI_INTERVAL_MS = 80;
const SNAPSHOT_BUFFER_LIMIT = 24;

export function useRoomConnection(profile: PlayerProfile): RoomConnection {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [room, setRoom] = useState<RoomView | null>(null);
  const [level, setLevel] = useState<LevelDefinition | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [latestSnapshot, setLatestSnapshot] = useState<GameSnapshot | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [notice, setNotice] = useState<ClientNotice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const activeCodeRef = useRef<string | null>(null);
  const profileRef = useRef(profile);
  const generationRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectAllowedRef = useRef(true);
  const sequenceRef = useRef(0);
  const noticeIdRef = useRef(0);
  const snapshotBufferRef = useRef<GameSnapshot[]>([]);
  const latestSnapshotRef = useRef<GameSnapshot | null>(null);
  const lastSnapshotUiAtRef = useRef(-Infinity);
  const clockOffsetRef = useRef(0);
  const latencyRef = useRef<number | null>(null);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  const pushNotice = useCallback((message: string, kind: ClientNotice["kind"] = "info") => {
    noticeIdRef.current += 1;
    setNotice({ id: noticeIdRef.current, message, kind });
  }, []);

  const send = useCallback((message: ClientMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const leave = useCallback(() => {
    generationRef.current += 1;
    reconnectAllowedRef.current = false;
    activeCodeRef.current = null;
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "leave_room" } satisfies ClientMessage));
      socket.close(1000, "leaving room");
    } else if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "leaving room");
    }
    snapshotBufferRef.current = [];
    latestSnapshotRef.current = null;
    lastSnapshotUiAtRef.current = -Infinity;
    setRoom(null);
    setLevel(null);
    setPlayerId(null);
    setLatestSnapshot(null);
    latencyRef.current = null;
    setLatency(null);
    setNotice(null);
    setError(null);
    setStatus("idle");
  }, []);

  const connect = useCallback(
    (rawCode: string) => {
      const code = normalizeRoomCode(rawCode);
      if (code.length !== 6) {
        setError("Room codes use six letters.");
        setStatus("error");
        return;
      }

      generationRef.current += 1;
      const generation = generationRef.current;
      reconnectAllowedRef.current = true;
      reconnectAttemptRef.current = 0;
      activeCodeRef.current = code;
      sequenceRef.current = 0;
      snapshotBufferRef.current = [];
      latestSnapshotRef.current = null;
      lastSnapshotUiAtRef.current = -Infinity;
      setLatestSnapshot(null);
      setRoom(null);
      setLevel(null);
      setPlayerId(null);
      latencyRef.current = null;
      setError(null);
      setStatus("connecting");

      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      if (socketRef.current && socketRef.current.readyState < WebSocket.CLOSING) {
        socketRef.current.close(1000, "switching rooms");
      }

      const openSocket = () => {
        if (generation !== generationRef.current || !reconnectAllowedRef.current) return;

        const socket = new WebSocket(websocketUrl(`/api/rooms/${code}/websocket`));
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (generation !== generationRef.current) {
            socket.close();
            return;
          }
          reconnectAttemptRef.current = 0;
          setStatus("connected");
          setError(null);
          const sessionToken = window.sessionStorage.getItem(`${SESSION_PREFIX}${code}`) ?? undefined;
          const hello: ClientMessage = { type: "hello", sessionToken, profile: profileRef.current };
          socket.send(JSON.stringify(hello));
        });

        socket.addEventListener("message", (event) => {
          if (generation !== generationRef.current || typeof event.data !== "string") return;

          let message: ServerMessage;
          try {
            message = JSON.parse(event.data) as ServerMessage;
          } catch {
            return;
          }

          switch (message.type) {
            case "welcome": {
              window.sessionStorage.setItem(`${SESSION_PREFIX}${code}`, message.sessionToken);
              clockOffsetRef.current = message.serverTime - Date.now();
              setPlayerId(message.playerId);
              setRoom(message.room);
              setLevel(message.level);
              setStatus("connected");
              break;
            }
            case "room_state":
              setRoom(message.room);
              clockOffsetRef.current = clockOffsetRef.current * 0.9 + (message.serverTime - Date.now()) * 0.1;
              break;
            case "level_state":
              setLevel(message.level);
              snapshotBufferRef.current = [];
              latestSnapshotRef.current = null;
              lastSnapshotUiAtRef.current = -Infinity;
              setLatestSnapshot(null);
              clockOffsetRef.current = clockOffsetRef.current * 0.9 + (message.serverTime - Date.now()) * 0.1;
              break;
            case "snapshot": {
              const buffer = snapshotBufferRef.current;
              if (!buffer.length || message.tick > (buffer[buffer.length - 1]?.tick ?? -1)) {
                buffer.push(message);
                if (buffer.length > SNAPSHOT_BUFFER_LIMIT) buffer.splice(0, buffer.length - SNAPSHOT_BUFFER_LIMIT);
                const previous = latestSnapshotRef.current;
                latestSnapshotRef.current = message;
                if (
                  previous === null ||
                  previous.phase !== message.phase ||
                  message.serverTime - lastSnapshotUiAtRef.current >= SNAPSHOT_UI_INTERVAL_MS
                ) {
                  lastSnapshotUiAtRef.current = message.serverTime;
                  setLatestSnapshot(message);
                }
              }
              break;
            }
            case "notice":
              pushNotice(message.message, message.kind === "grip_miss" ? "warning" : "info");
              break;
            case "error": {
              const fatal = ["ROOM_NOT_FOUND", "ROOM_FULL", "INVALID_ROOM", "GAME_IN_PROGRESS"].includes(message.code);
              setError(message.message);
              pushNotice(message.message, "error");
              if (fatal) {
                reconnectAllowedRef.current = false;
                setStatus("error");
                socket.close(1000, "room error");
              }
              break;
            }
            case "pong": {
              const now = Date.now();
              const roundTrip = Math.max(0, now - message.clientTime);
              latencyRef.current = Math.round(roundTrip);
              setLatency(Math.round(roundTrip));
              const estimatedOffset = message.serverTime - (message.clientTime + roundTrip / 2);
              clockOffsetRef.current = clockOffsetRef.current * 0.8 + estimatedOffset * 0.2;
              break;
            }
          }
        });

        socket.addEventListener("close", () => {
          if (generation !== generationRef.current || !reconnectAllowedRef.current) return;
          if (socketRef.current === socket) socketRef.current = null;
          reconnectAttemptRef.current += 1;
          const attempt = reconnectAttemptRef.current;
          setStatus("reconnecting");
          const delay = Math.min(4_000, 350 * 2 ** Math.min(attempt - 1, 4));
          reconnectTimerRef.current = window.setTimeout(openSocket, delay);
        });

        socket.addEventListener("error", () => {
          if (generation === generationRef.current) setError("Lost the truck radio. Reconnecting…");
        });
      };

      void (async () => {
        try {
          const roomCheck = await fetch(httpUrl(`/api/rooms/${code}`), {
            headers: { accept: "application/json" },
            cache: "no-store",
          });
          if (generation !== generationRef.current || !reconnectAllowedRef.current) return;
          if (roomCheck.status === 404) {
            reconnectAllowedRef.current = false;
            setError("That room code does not exist.");
            setStatus("error");
            return;
          }
        } catch {
          // Let the WebSocket reconnect loop handle temporary network failures.
        }
        openSocket();
      })();
    },
    [pushNotice],
  );

  useEffect(() => {
    if (status !== "connected") return;
    const timer = window.setInterval(() => {
      send({ type: "ping", clientTime: Date.now() });
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [send, status]);

  useEffect(() => leave, [leave]);

  const setProfile = useCallback(
    (nextProfile: PlayerProfile) => {
      profileRef.current = nextProfile;
      send({ type: "set_profile", profile: nextProfile });
    },
    [send],
  );

  const setReady = useCallback((ready: boolean) => send({ type: "set_ready", ready }), [send]);
  const selectLevel = useCallback((levelIndex: number) => send({ type: "select_level", levelIndex }), [send]);
  const startGame = useCallback(() => send({ type: "start_game" }), [send]);
  const playAgain = useCallback(() => send({ type: "play_again" }), [send]);
  const nextLevel = useCallback(() => send({ type: "next_level" }), [send]);
  const shout = useCallback((phrase: ShoutPhrase) => send({ type: "shout", phrase }), [send]);

  const sendMove = useCallback(
    (x: number, y: number) => {
      sequenceRef.current += 1;
      send({ type: "move", seq: sequenceRef.current, x: clamp(x, -1, 1), y: clamp(y, -1, 1) });
    },
    [send],
  );

  const toggleGrip = useCallback(() => {
    sequenceRef.current += 1;
    send({ type: "grip_toggle", seq: sequenceRef.current });
  }, [send]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    status,
    room,
    level,
    playerId,
    latestSnapshot,
    snapshotBufferRef,
    clockOffsetRef,
    latencyRef,
    latency,
    notice,
    error,
    connect,
    leave,
    dismissNotice,
    setProfile,
    setReady,
    selectLevel,
    startGame,
    sendMove,
    toggleGrip,
    shout,
    playAgain,
    nextLevel,
  };
}
