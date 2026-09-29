import {
  useCallback,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  getHandlePoints,
  LEVELS,
  MOVER_COLORS,
  MOVER_HATS,
  SHOUTS,
  normalizeRoomCode,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type CrashReplay,
  type LevelDefinition,
  type MoverHatId,
  type PlayerProfile,
  type RoomPlayer,
  type RoomView,
  type ShoutPhrase,
  type Vec2,
} from "@couch-movers/shared";
import { GameControls, NUMBER_SHOUTS } from "./Controls";
import { useGameAudio } from "./useGameAudio";
import { createRoom, useRoomConnection, type ConnectionStatus } from "./useRoom";

const PROFILE_KEY = "couch-movers:profile";
const MUTE_KEY = "couch-movers:muted";
const loadGameCanvas = () => import("./GameCanvas").then((module) => ({ default: module.GameCanvas }));
const GameCanvas = lazy(loadGameCanvas);
const HAT_GLYPHS: Record<MoverHatId, string> = {
  cap: "CAP",
  hardhat: "HARD HAT",
  cowboy: "YEEHAW",
  crown: "BOSS",
};

function loadProfile(): PlayerProfile {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PROFILE_KEY) ?? "null") as Partial<PlayerProfile> | null;
    const color = MOVER_COLORS.find((option) => option.id === stored?.color)?.id ?? "tomato";
    const hat = MOVER_HATS.find((option) => option.id === stored?.hat)?.id ?? "cap";
    return { color, hat };
  } catch {
    return { color: "tomato", hat: "cap" };
  }
}

function saveProfile(profile: PlayerProfile): void {
  window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

function formatTime(milliseconds: number): string {
  const safe = Math.max(0, Math.floor(milliseconds));
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const tenths = Math.floor((safe % 1_000) / 100);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function isRopeLevel(level: LevelDefinition): boolean {
  return level.mechanic === "rope-climb";
}

function MoverAvatar({ profile, small = false }: { profile: PlayerProfile; small?: boolean }) {
  return (
    <span
      className={`mover-avatar hat-${profile.hat}${small ? " is-small" : ""}`}
      style={{ "--mover-color": MOVER_COLORS.find((color) => color.id === profile.color)?.hex ?? "#ef5b4c" } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="avatar-hat" />
      <span className="avatar-face"><i /><i /><b /></span>
      <span className="avatar-body" />
    </span>
  );
}

function HeroCouch() {
  return (
    <div className="hero-art" aria-hidden="true">
      <div className="hero-speed-lines"><i /><i /><i /></div>
      <div className="hero-mover hero-mover-left"><MoverAvatar profile={{ color: "tomato", hat: "cap" }} /></div>
      <div className="hero-couch">
        <span className="hero-cushion left" />
        <span className="hero-cushion right" />
        <span className="hero-couch-leg one" />
        <span className="hero-couch-leg two" />
        <strong>FRAGILE-ish</strong>
      </div>
      <div className="hero-mover hero-mover-right"><MoverAvatar profile={{ color: "sunny", hat: "hardhat" }} /></div>
      <div className="hero-crack">KRRK!</div>
      <div className="hero-box box-one">↑ ↑<br /><b>THIS END UP</b></div>
      <div className="hero-box box-two">?</div>
    </div>
  );
}

interface LandingProps {
  joinCode: string;
  busy: boolean;
  error: string | null;
  onCodeChange: (code: string) => void;
  onCreate: () => void;
  onJoin: () => void;
  onHowTo: () => void;
}

function Landing({ joinCode, busy, error, onCodeChange, onCreate, onJoin, onHowTo }: LandingProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (joinCode.length === 6) onJoin();
  };

  return (
    <main className="landing-screen">
      <div className="landing-grain" />
      <header className="brand-lockup">
        <span className="brand-kicker">QUESTIONABLE MOVING CO. PRESENTS</span>
        <h1><span>COUCH</span><strong>MOVERS</strong></h1>
        <p>Teamwork is optional. Property damage is not.</p>
      </header>

      <div className="landing-layout">
        <HeroCouch />
        <section className="dispatch-card" aria-label="Start or join a game">
          <div className="dispatch-tape">JOB DISPATCH</div>
          <h2>Grab some friends.</h2>
          <p>Two to four movers. One extremely inconvenient couch.</p>
          <button className="primary-button create-button" type="button" disabled={busy} onClick={onCreate}>
            <span className="button-icon">＋</span>
            {busy ? "CALLING THE TRUCK…" : "CREATE A ROOM"}
          </button>
          <div className="or-divider"><span>OR JOIN THE CREW</span></div>
          <form className="join-form" onSubmit={submit}>
            <label htmlFor="room-code">Six-letter room code</label>
            <div className="join-row">
              <input
                id="room-code"
                name="room-code"
                value={joinCode}
                onChange={(event) => onCodeChange(normalizeRoomCode(event.target.value))}
                onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                  if (event.key === "Enter" && joinCode.length < 6) event.preventDefault();
                }}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                inputMode="text"
                maxLength={6}
                placeholder="ABCDEF"
                aria-describedby={error ? "landing-error" : undefined}
              />
              <button type="submit" disabled={busy || joinCode.length !== 6}>JOIN</button>
            </div>
          </form>
          {error && <p className="form-error" id="landing-error" role="alert">{error}</p>}
          <button className="how-to-link" type="button" onClick={onHowTo}>
            <span>?</span> HOW DO WE MOVE THIS THING?
          </button>
        </section>
      </div>
      <footer className="landing-footer"><span>NO LOGIN</span><i /> <span>PHONE-FIRST</span><i /> <span>2–4 PLAYERS</span></footer>
    </main>
  );
}

function HowTo({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="how-to-modal" role="dialog" aria-modal="true" aria-labelledby="how-to-title">
        <button className="modal-close" type="button" aria-label="Close how to play" onClick={onClose}>×</button>
        <span className="eyebrow">ZERO-PAGE MANUAL</span>
        <h2 id="how-to-title">Move the couch.<br /><em>Try not to move the house.</em></h2>
        <div className="how-to-steps">
          <article>
            <span className="step-number">1</span>
            <div className="how-icon move-icon"><i>＋</i></div>
            <h3>MOVE YOUR MOVER</h3>
            <p>Use the thumbstick, WASD, or arrow keys. You control the mover—not the couch.</p>
          </article>
          <article>
            <span className="step-number">2</span>
            <div className="how-icon grip-demo"><i /><b>GRIP</b></div>
            <h3>GRAB YOUR END</h3>
            <p>Tap GRAB HANDLE—or GRAB ROPE on hoist jobs. Tap RELEASE to let go. On desktop, Space does the action shown. On ladders, grab the rope, choose a left or right H-ladder, then climb the rungs.</p>
          </article>
          <article>
            <span className="step-number">3</span>
            <div className="how-icon couch-demo"><i>←</i><b /><i>→</i></div>
            <h3>PULL TOGETHER… ISH</h3>
            <p>Same direction moves straight. Opposite pulls make the couch pivot.</p>
          </article>
        </div>
        <div className="how-to-goal"><span>✓</span><p>Park the whole couch in the green zone and hold it steady for <strong>2 seconds.</strong></p></div>
        <button className="primary-button got-it-button" type="button" onClick={onClose}>GOT IT. PROBABLY.</button>
      </section>
    </div>
  );
}

function RoomCode({ code }: { code: string }) {
  return <span className="room-code" aria-label={`Room code ${code.split("").join(" ")}`}>{code}</span>;
}

interface LobbyProps {
  room: RoomView;
  localPlayer: RoomPlayer;
  profile: PlayerProfile;
  connectionStatus: ConnectionStatus;
  copied: boolean;
  onProfile: (profile: PlayerProfile) => void;
  onReady: (ready: boolean) => void;
  onSelectLevel: (levelIndex: number) => void;
  onStart: () => void;
  onShare: () => void;
  onLeave: () => void;
}

function Lobby({
  room,
  localPlayer,
  profile,
  connectionStatus,
  copied,
  onProfile,
  onReady,
  onSelectLevel,
  onStart,
  onShare,
  onLeave,
}: LobbyProps) {
  const activePlayers = room.players.filter((player) => !player.spectator);
  const canStart = activePlayers.length >= 2 && activePlayers.every((player) => player.ready && player.connected);
  const usedColors = new Set(room.players.filter((player) => player.id !== localPlayer.id).map((player) => player.profile.color));
  const slots: Array<RoomPlayer | null> = Array.from({ length: 4 }, (_, slot) => room.players.find((player) => player.slot === slot) ?? null);
  const selectedLevel = LEVELS[room.levelIndex] ?? LEVELS[0]!;
  const availableLevels = LEVELS.slice(0, room.totalLevels);

  return (
    <main className="lobby-screen">
      <div className="lobby-topbar">
        <button className="utility-back" type="button" onClick={onLeave}>← LEAVE</button>
        <div className="lobby-title"><span>THE LOADING BAY</span><strong>ASSEMBLE YOUR CREW</strong></div>
        <div className={`connection-pill is-${connectionStatus}`}><i />{connectionStatus === "connected" ? "RADIO GOOD" : "RECONNECTING"}</div>
      </div>

      <div className="lobby-content">
        <section className="invite-panel">
          <span className="eyebrow">YOUR JOB NUMBER</span>
          <RoomCode code={room.code} />
          <p>Friends can enter this code or use your invite.</p>
          <button className="secondary-button share-button" type="button" onClick={onShare}>
            {copied ? "✓ INVITE COPIED" : "↗ SHARE INVITE"}
          </button>
          <div className="clipboard-note"><span>TIP</span> Open the link on each phone. No app, no login.</div>
          <div className={`stage-picker${localPlayer.host ? " is-host" : ""}`}>
            <div className="stage-picker-heading">
              <span>{localPlayer.host ? "TEST DISPATCH" : "SELECTED JOB"}</span>
              <small>{localPlayer.host ? "FOREMAN CONTROL" : "PICKED BY FOREMAN"}</small>
            </div>
            <div className="selected-stage-card">
              <b>{String(selectedLevel.number).padStart(2, "0")}</b>
              <span><strong>{selectedLevel.title}</strong><small>{selectedLevel.subtitle}</small></span>
              <em>{isRopeLevel(selectedLevel) ? "H-LADDER" : "HANDLE"}</em>
            </div>
            {localPlayer.host && (
              <label className="stage-picker-select">
                <span>JUMP TO ANY STAGE</span>
                <select
                  value={room.levelIndex}
                  onChange={(event) => onSelectLevel(Number(event.target.value))}
                  aria-label="Select the stage to play"
                >
                  {availableLevels.map((level, levelIndex) => (
                    <option key={level.id} value={levelIndex}>
                      {String(level.number).padStart(2, "0")} — {level.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </section>

        <section className="crew-panel">
          <div className="panel-heading"><span className="eyebrow">CREW ROSTER</span><b>{activePlayers.length}/4 MOVERS</b></div>
          <div className="player-slots">
            {slots.map((player, index) => player ? (
              <article className={`player-card${player.id === localPlayer.id ? " is-you" : ""}${!player.connected ? " is-offline" : ""}`} key={player.id}>
                <div className="player-avatar-wrap"><MoverAvatar profile={player.profile} /></div>
                <div className="player-card-copy">
                  <strong>{player.id === localPlayer.id ? "YOU" : player.label}</strong>
                  <span>{player.host ? "FOREMAN" : `MOVER ${player.slot + 1}`}</span>
                </div>
                <div className={`ready-stamp${player.ready ? " is-ready" : ""}`}>{!player.connected ? "OFFLINE" : player.ready ? "READY!" : "NOT READY"}</div>
              </article>
            ) : (
              <article className="player-card is-empty" key={`empty-${index}`}>
                <span className="empty-avatar">?</span>
                <div className="player-card-copy"><strong>OPEN SPOT</strong><span>WAITING FOR MOVER…</span></div>
              </article>
            ))}
          </div>
        </section>

        <section className="customize-panel">
          <div className="customize-preview">
            <MoverAvatar profile={profile} />
            <div><span className="eyebrow">YOUR LOOK</span><strong>Liability, but stylish.</strong></div>
          </div>
          <fieldset>
            <legend>PICK A SHIRT</legend>
            <div className="color-options">
              {MOVER_COLORS.map((color) => (
                <button
                  type="button"
                  key={color.id}
                  className={profile.color === color.id ? "is-selected" : ""}
                  style={{ "--swatch": color.hex } as React.CSSProperties}
                  disabled={usedColors.has(color.id)}
                  aria-label={`${color.name}${usedColors.has(color.id) ? ", already picked" : ""}`}
                  aria-pressed={profile.color === color.id}
                  onClick={() => onProfile({ ...profile, color: color.id })}
                ><i /></button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>PICK A HAT</legend>
            <div className="hat-options">
              {MOVER_HATS.map((hat) => (
                <button
                  type="button"
                  key={hat.id}
                  className={`hat-choice hat-${hat.id}${profile.hat === hat.id ? " is-selected" : ""}`}
                  aria-label={`Wear the ${hat.name}`}
                  aria-pressed={profile.hat === hat.id}
                  onClick={() => onProfile({ ...profile, hat: hat.id })}
                ><i /><span>{HAT_GLYPHS[hat.id]}</span></button>
              ))}
            </div>
          </fieldset>
        </section>
      </div>

      <div className="lobby-actions">
        <button
          type="button"
          className={`ready-button${localPlayer.ready ? " is-ready" : ""}`}
          onClick={() => onReady(!localPlayer.ready)}
        >
          <span>{localPlayer.ready ? "✓" : ""}</span>{localPlayer.ready ? "I'M READY!" : "READY UP"}
        </button>
        {localPlayer.host ? (
          <button className="primary-button start-button" type="button" disabled={!canStart} onClick={onStart}>
            {activePlayers.length < 2 ? "NEED 2 MOVERS" : !canStart ? "WAITING ON CREW" : "START THE JOB →"}
          </button>
        ) : (
          <div className="waiting-foreman"><i /> THE FOREMAN STARTS THE JOB</div>
        )}
      </div>
    </main>
  );
}

function stageHint(room: RoomView, snapshot: ReturnType<typeof useRoomConnection>["latestSnapshot"], localPlayerId: string | null): { title: string; copy: string } | null {
  if (room.phase !== "playing" || !snapshot) return null;
  const me = snapshot.players.find((player) => player.id === localPlayerId);
  if (room.levelIndex === 0) {
    if (!me?.gripped) return { title: "1. GRAB ON", copy: "Move beside your golden handle, then tap GRAB HANDLE—or press Space." };
    if (snapshot.elapsedMs < 7_500) return { title: "2. PULL TOGETHER", copy: "Everyone head right. The couch follows the crew." };
    if (snapshot.couch.x < 675) return { title: "AIM FOR THE DOOR", copy: "Stay lined up. Shout if your crew gets wobbly." };
    if (snapshot.couch.x < 920) return { title: "NICE! KEEP PULLING", copy: "Tap RELEASE HANDLE—or Space—if you need to run around and reset." };
    if (snapshot.deliveryProgress > 0) return { title: "HOLD IT!", copy: "Keep the whole couch in the zone for two seconds." };
    return { title: "PARK IT", copy: "Get every corner of the couch inside the green zone." };
  }
  if (room.levelIndex === 5) {
    if (!me?.gripped) return { title: "GRAB YOUR ROPE", copy: "Get near your rope end, then tap GRAB ROPE—or press Space. It stays toggled on." };
    if (snapshot.deliveryProgress > 0) return { title: "HOLD THE LANDING!", copy: "Keep every corner upstairs for two seconds." };
    if (snapshot.couch.y > 500 && snapshot.couch.x < 500) return { title: "ROLL TO THE LADDER", copy: "Move right together and line the couch up below the yellow ladder." };
    if (snapshot.couch.y > 325) return { title: "ONE LADDER EACH", copy: "Put one mover on each H-ladder, keep GRAB ROPE on, then climb the rungs together." };
    return { title: "FLOOR 2: GO RIGHT", copy: "Clear the opening, let the couch settle, then carry it into the green zone." };
  }
  if (room.levelIndex === 6) {
    if (!me?.gripped) return { title: "ROPE ON. THEN CLIMB.", copy: "You cannot climb a ladder until GRAB ROPE is on. Space toggles the same rope action." };
    if (snapshot.deliveryProgress > 0) return { title: "DO NOT LET GO", copy: "Hold the couch inside the landing while the timer fills." };
    if (snapshot.couch.y > 500 && snapshot.couch.x < 760) return { title: "FIRST: ALL THE WAY RIGHT", copy: "Dodge the fragile stuff and line up under LADDER 1." };
    if (snapshot.couch.y > 455) return { title: "LADDER 1: SPLIT UP", copy: "Use both H-ladders, keep ropes grabbed, then climb in step." };
    if (snapshot.couch.y > 285 && snapshot.couch.x > 500) return { title: "FLOOR 2: GO LEFT", copy: "Clear the hatch and cross to LADDER 2. Mind the low beam." };
    if (snapshot.couch.y > 265) return { title: "LADDER 2: CLIMB", copy: "Keep rope tension even or the couch will snag on the hatch." };
    return { title: "FLOOR 3: HOME STRETCH", copy: "Move right past the expensive obstacles and park the whole couch." };
  }
  if (room.levelIndex === 8) {
    if (!me?.gripped) return { title: "PICK AN H-LADDER", copy: "Grab your rope. Split the crew across the left and right ladders so nobody floats between them." };
    if (snapshot.deliveryProgress > 0) return { title: "THAT'S THE PLATFORM!", copy: "Hold the whole couch on the top-left delivery mark for two seconds." };
    if (snapshot.couch.y > 500 && snapshot.couch.x > 500) return { title: "BOTTOM FLOOR: GO LEFT", copy: "Reach SHAFT 1, then put each mover's feet onto a separate ladder." };
    if (snapshot.couch.y > 455) return { title: "CLIMB THE RUNGS", copy: "Push up while your rope is grabbed. Your mover locks to the nearest ladder lane." };
    if (snapshot.couch.y > 285 && snapshot.couch.x < 760) return { title: "MIDDLE FLOOR: GO RIGHT", copy: "Clear the hatch, duck under the beam, and line up at SHAFT 2." };
    if (snapshot.couch.y > 260) return { title: "SECOND CLIMB", copy: "Keep both ladders balanced or the couch will twist into the platform." };
    return { title: "TOP FLOOR: GO LEFT", copy: "Ignore the tempting right ledge. The only delivery platform is top-left." };
  }
  if (snapshot.elapsedMs > 9_000 && snapshot.deliveryProgress === 0) return null;
  switch (room.levelIndex) {
    case 1:
      return { title: "PIVOT LESSON", copy: "Pull opposite ways to spin, then straighten for the corner." };
    case 2:
      return { title: "EVERYTHING COSTS MONEY", copy: "Blue route good. Priceless television bad." };
    case 3:
      return { title: "CAT HAS RIGHT OF WAY", copy: "Mr. Pickles follows nobody's safety policy." };
    case 4:
      return { title: "BALCONY BOSS", copy: "Turn sideways for the door, then park perfectly flat." };
    case 7:
      return { title: "OFFICE SLALOM", copy: "The clean route is up, down, then up. Fragile shortcuts cost money." };
    case 9:
      return { title: "DINNER TABLE DRIFT", copy: "Sweep wide around both tables. The china-lined shortcut is never actually shorter." };
    case 10:
      return { title: "MIDNIGHT ZOOMIES", copy: "Right, then left, then right again. Let Mr. Pickles pass before crossing the middle lane." };
    case 11:
      return { title: "THE KEYHOLE GAUNTLET", copy: "Alternate high and low through each gate. Straight pulling is a trap—set up every pivot early." };
    default:
      return null;
  }
}

function resultAwards(room: RoomView): Array<{ icon: string; title: string; player: string }> {
  const crew = room.players.filter((player) => !player.spectator);
  if (!crew.length) return [{ icon: "★", title: "COUCH WHISPERERS", player: "THE WHOLE CREW" }];
  const damageLeader = [...crew].sort((a, b) => b.stats.damageCaused - a.stats.damageCaused)[0];
  const pivotLeader = [...crew].sort((a, b) => b.stats.pivotShouts - a.stats.pivotShouts)[0];
  const whisperer = [...crew].sort((a, b) => (a.stats.damageCaused + a.stats.itemsBroken * 5) - (b.stats.damageCaused + b.stats.itemsBroken * 5))[0];
  const idle = crew.find((player) => player.stats.damageCaused + player.stats.itemsBroken + player.stats.shouts === 0);
  const awards: Array<{ icon: string; title: string; player: string }> = [];
  if (damageLeader && damageLeader.stats.damageCaused > 0) {
    awards.push({ icon: "!", title: "WALL DESTROYER", player: damageLeader.label });
  }
  if (pivotLeader && pivotLeader.stats.pivotShouts > 0) {
    awards.push({ icon: "↻", title: "MOST SHOUTED PIVOT", player: pivotLeader.label });
  }
  if (idle) awards.push({ icon: "…", title: "DID ABSOLUTELY NOTHING", player: idle.label });
  if (awards.length < 2 && whisperer && whisperer !== idle) awards.push({ icon: "★", title: "COUCH WHISPERER", player: whisperer.label });
  if (!awards.length) awards.push({ icon: "★", title: "COUCH WHISPERERS", player: "THE WHOLE CREW" });
  return awards.slice(0, 2);
}

function CrashReplayView({ replay, level }: { replay: CrashReplay; level: LevelDefinition }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || replay.frames.length === 0) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let animationFrame = 0;
    const startedAt = performance.now();
    const frameDuration = 40;
    const playbackDuration = Math.max(frameDuration, replay.frames.length * frameDuration);
    const loopDuration = playbackDuration + 650;
    const colorFor = (colorId: string) => MOVER_COLORS.find((color) => color.id === colorId)?.hex ?? "#ef5b4c";
    const angleLerp = (from: number, to: number, amount: number) => {
      const delta = ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      return from + delta * amount;
    };

    const render = (time: number) => {
      const loopTime = (time - startedAt) % loopDuration;
      const exactFrame = Math.min(replay.frames.length - 1, loopTime / frameDuration);
      const index = Math.floor(exactFrame);
      const nextIndex = Math.min(replay.frames.length - 1, index + 1);
      const amount = exactFrame - index;
      const frame = replay.frames[index] ?? replay.frames[0];
      const next = replay.frames[nextIndex] ?? frame;
      if (!frame || !next) return;

      const scale = Math.min(canvas.width / WORLD_WIDTH, canvas.height / WORLD_HEIGHT);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      const theme = String(level.theme);
      context.fillStyle = theme === "ladder-maze" ? "#4f6470" : theme === "fire-escape" ? "#657c85" : theme === "attic-ladder" ? "#9e8b75" : theme === "office" ? "#b9c79f" : "#dfbf7b";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.save();
      context.scale(scale, scale);

      context.fillStyle = "rgba(255,248,223,.92)";
      context.strokeStyle = "#2f2940";
      context.lineWidth = 5;
      for (const wall of level.walls) {
        context.fillRect(wall.x - wall.width / 2, wall.y - wall.height / 2, wall.width, wall.height);
        context.strokeRect(wall.x - wall.width / 2, wall.y - wall.height / 2, wall.width, wall.height);
      }
      context.fillStyle = "rgba(69,201,154,.24)";
      context.fillRect(level.target.x - level.target.width / 2, level.target.y - level.target.height / 2, level.target.width, level.target.height);

      const playersById = new Map(frame.players.map((player) => [player.id, player]));
      const replayPlayers = next.players.map((player) => {
        const previous = playersById.get(player.id) ?? player;
        const x = previous.x + (player.x - previous.x) * amount;
        const y = previous.y + (player.y - previous.y) * amount;
        return { player, x, y };
      });
      const couchX = frame.couch.x + (next.couch.x - frame.couch.x) * amount;
      const couchY = frame.couch.y + (next.couch.y - frame.couch.y) * amount;
      const couchAngle = angleLerp(frame.couch.angle, next.couch.angle, amount);

      if (isRopeLevel(level)) {
        const handles = getHandlePoints(replayPlayers.length);
        const cosine = Math.cos(couchAngle);
        const sine = Math.sin(couchAngle);
        replayPlayers.forEach(({ player, x, y }, playerIndex) => {
          const handle = handles[playerIndex];
          if (!player.gripped || !handle) return;
          const handleX = couchX + handle.x * cosine - handle.y * sine;
          const handleY = couchY + handle.x * sine + handle.y * cosine;
          const dx = handleX - x;
          const dy = handleY - y;
          const distance = Math.max(1, Math.hypot(dx, dy));
          const slack = Math.max(0, (level.ropeLength ?? 70) - distance);
          const sag = distance > (level.ropeLength ?? 70) ? 2 : Math.min(28, 8 + slack * 0.28);
          const middleX = x + dx * 0.5 - (dy / distance) * sag;
          const middleY = y + dy * 0.5 + (dx / distance) * sag;
          context.beginPath();
          context.moveTo(x, y);
          context.quadraticCurveTo(middleX, middleY, handleX, handleY);
          context.strokeStyle = "#2f2940";
          context.lineWidth = 9;
          context.stroke();
          context.beginPath();
          context.moveTo(x, y);
          context.quadraticCurveTo(middleX, middleY, handleX, handleY);
          context.strokeStyle = "#d69a47";
          context.lineWidth = 5;
          context.stroke();
        });
      }

      for (const { player, x, y } of replayPlayers) {
        context.beginPath();
        context.fillStyle = colorFor(player.profile.color);
        context.strokeStyle = "#2f2940";
        context.lineWidth = 5;
        context.arc(x, y, 24, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.fillStyle = "#2f2940";
        context.beginPath();
        context.arc(x - 6, y - 5, 3, 0, Math.PI * 2);
        context.arc(x + 6, y - 5, 3, 0, Math.PI * 2);
        context.fill();
      }

      context.save();
      context.translate(couchX, couchY);
      context.rotate(couchAngle);
      context.fillStyle = "#295f73";
      context.strokeStyle = "#2f2940";
      context.lineWidth = 7;
      context.beginPath();
      context.roundRect(-80, -44, 160, 88, 15);
      context.fill();
      context.stroke();
      context.fillStyle = "#3c8291";
      context.fillRect(-68, -30, 59, 60);
      context.fillRect(9, -30, 59, 60);
      context.restore();

      const replayAt = frame.at + (next.at - frame.at) * amount;
      if (Math.abs(replayAt - replay.event.at) < 170) {
        const pulse = 34 + (170 - Math.abs(replayAt - replay.event.at)) * 0.35;
        context.beginPath();
        context.strokeStyle = replay.event.kind === "break" ? "#f6c445" : "#ef5b4c";
        context.lineWidth = 12;
        context.globalAlpha = 0.75;
        context.arc(replay.event.x, replay.event.y, pulse, 0, Math.PI * 2);
        context.stroke();
        context.globalAlpha = 1;
      }
      context.restore();
      animationFrame = requestAnimationFrame(render);
    };
    animationFrame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationFrame);
  }, [level, replay]);

  return (
    <section className="crash-replay">
      <div><span>INSTANT REPLAY</span><b>WORST CRASH · {replay.event.text}</b></div>
      <canvas ref={canvasRef} width={640} height={360} aria-label="Replay of the level's worst crash" />
    </section>
  );
}

interface GameViewProps {
  connection: ReturnType<typeof useRoomConnection>;
  localPlayer: RoomPlayer;
  muted: boolean;
  onMute: () => void;
  onMove: (movement: Vec2) => void;
  onGrip: () => void;
  onShout: (phrase: ShoutPhrase) => void;
  onLeave: () => void;
  onPlayAgain: () => void;
  onNextLevel: () => void;
}

function CountdownOverlay({ level, totalLevels, endsAt, clockOffset }: {
  level: LevelDefinition;
  totalLevels: number;
  endsAt: number | null;
  clockOffset: React.RefObject<number>;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 160);
    return () => window.clearInterval(timer);
  }, []);

  const countdown = endsAt === null ? 3 : Math.max(0, Math.ceil((endsAt - (now + clockOffset.current)) / 1_000));
  return (
    <div className="game-overlay countdown-overlay">
      <span>JOB {level.number} OF {totalLevels} · {isRopeLevel(level) ? "PAIRED H-LADDER HOIST · GRAB YOUR ROPE" : "HANDLE CARRY · GRAB YOUR HANDLE"}</span>
      <strong key={countdown}>{countdown > 0 ? countdown : "GO!"}</strong>
      <p>{level.subtitle}</p>
    </div>
  );
}

function GameView({ connection, localPlayer, muted, onMute, onMove, onGrip, onShout, onLeave, onPlayAgain, onNextLevel }: GameViewProps) {
  const [confirmLeave, setConfirmLeave] = useState(false);
  const { room, level, latestSnapshot, playerId, status, snapshotBufferRef, clockOffsetRef, latencyRef } = connection;
  if (!room || !level) return null;
  const me = latestSnapshot?.players.find((player) => player.id === playerId);
  const gripped = me?.gripped ?? localPlayer.gripped;
  const controlsEnabled = room.phase === "playing" && status === "connected" && localPlayer.connected;
  const elapsed = latestSnapshot?.elapsedMs ?? room.elapsedMs;
  const hint = stageHint(room, latestSnapshot, playerId);
  const progress = Math.round((latestSnapshot?.deliveryProgress ?? 0) * 100);
  const hp = Math.round(latestSnapshot?.couch.hp ?? room.result?.hpRemaining ?? 100);
  const score = latestSnapshot?.score.score ?? room.result?.score ?? 0;
  const result = room.result;
  const finalLevel = room.levelIndex >= room.totalLevels - 1;
  const awards = resultAwards(room);
  const blameLeader = [...room.players]
    .filter((player) => !player.spectator && player.stats.damageCaused > 0)
    .sort((a, b) => b.stats.damageCaused - a.stats.damageCaused)[0];

  return (
    <main className={`game-screen theme-${level.theme}`}>
      <Suspense fallback={<div className="game-canvas-loading"><span>UNFOLDING COUCH…</span></div>}>
        <GameCanvas
          level={level}
          snapshots={snapshotBufferRef}
          clockOffset={clockOffsetRef}
          latency={latencyRef}
          localPlayerId={playerId}
        />
      </Suspense>
      <div className="game-vignette" />
      <div className="game-hud">
        <section className="level-plaque">
          <span>JOB {String(level.number).padStart(2, "0")} / {String(room.totalLevels).padStart(2, "0")}</span><strong>{level.title}</strong>
        </section>
        <section className="timer-plaque" aria-label={`Elapsed time ${formatTime(elapsed)}`}>
          <span>TIME</span><strong>{formatTime(elapsed)}</strong>
        </section>
        <section className={`delivery-plaque${hp <= 35 ? " is-danger" : ""}`}>
          <div><span>COUCH HEALTH</span><b>{hp} HP</b></div>
          <i className="health-meter"><em style={{ width: `${hp}%` }} /></i>
          <small>{progress > 0 ? `PARKING ${progress}%` : `SCORE $${score.toLocaleString()}`}</small>
        </section>
      </div>

      <div className="game-utilities">
        <button className="leave-game-button" type="button" onClick={() => setConfirmLeave(true)} aria-label="Leave room">← <span>LEAVE</span></button>
        <div className="room-mini">ROOM <b>{room.code}</b><span className={`network-dot is-${status}`} /></div>
      </div>
      <button className="mute-button in-game" type="button" aria-label={muted ? "Unmute sounds" : "Mute sounds"} onClick={onMute}>
        {muted ? "◒" : "♪"}
      </button>

      {blameLeader && room.phase === "playing" && (
        <div className="blame-strip">CURRENTLY BLAMING <b>{blameLeader.label}</b> · {blameLeader.stats.damageCaused} HP</div>
      )}

      {hint && room.phase === "playing" && (
        <div className="tutorial-hint" key={hint.title}>
          <span>{hint.title}</span><p>{hint.copy}</p>
        </div>
      )}

      <GameControls
        gripped={gripped}
        gripTarget={isRopeLevel(level) ? "rope" : "handle"}
        disabled={!controlsEnabled}
        onMove={onMove}
        onToggleGrip={onGrip}
        onShout={onShout}
      />

      {room.phase === "countdown" && (
        <CountdownOverlay level={level} totalLevels={room.totalLevels} endsAt={room.countdownEndsAt} clockOffset={clockOffsetRef} />
      )}

      {(room.phase === "paused" || status === "reconnecting") && (
        <div className="game-overlay pause-overlay">
          <div className="dropped-box">!</div>
          <span>HANG ON—WE DROPPED A MOVER</span>
          <strong>QUICK PAUSE</strong>
          <p>{room.pausedReason ?? "Reconnecting the crew radio…"}</p>
          <i className="loading-dots"><b /><b /><b /></i>
        </div>
      )}

      {(room.phase === "complete" || room.phase === "failed") && (
        <div className={`game-overlay result-overlay ${room.phase === "complete" ? "complete-overlay" : "failed-overlay"}`}>
          <div className="success-burst" />
          <span className="success-kicker">{room.phase === "complete" ? (finalLevel ? `ALL ${room.totalLevels} JOBS COMPLETE` : "JOB COMPLETE") : "INSURANCE CLAIM FILED"}</span>
          <strong>{room.phase === "complete" ? (finalLevel ? "MOVING LEGENDS!" : "GOOD ENOUGH!") : "COUCH DOWN!"}</strong>
          <p>{room.phase === "complete" ? "The couch arrived with a legally acceptable amount of dignity." : "Zero HP. The couch has become modern art."}</p>
          {result && (
            <>
              <div className="result-score-card">
                <div><span>FINAL SCORE</span><b>${result.score.toLocaleString()}</b></div>
                <div className="result-stars" aria-label={`${result.stars} out of 3 stars`}>
                  {[1, 2, 3].map((star) => <i className={star <= result.stars ? "is-earned" : ""} key={star}>★</i>)}
                </div>
              </div>
              <div className="result-breakdown">
                <span>TIME <b>+${result.timeBonus}</b></span>
                <span>DAMAGE <b>-${result.damagePenalty}</b></span>
                <span>STUFF <b>-${result.itemsPenalty}</b></span>
                <span>TIME <b>{formatTime(result.elapsedMs)}</b></span>
              </div>
            </>
          )}
          {localPlayer.host ? (
            <div className="result-actions">
              {room.phase === "complete" && !finalLevel && <button className="primary-button play-again-button" type="button" onClick={onNextLevel}>NEXT JOB →</button>}
              <button className={room.phase === "failed" || finalLevel ? "primary-button play-again-button" : "secondary-button"} type="button" onClick={onPlayAgain}>RETRY JOB ↻</button>
              <button className="result-leave-button" type="button" onClick={() => setConfirmLeave(true)}>LEAVE ROOM</button>
            </div>
          ) : <div className="waiting-foreman light"><i /> WAITING FOR FOREMAN…</div>}
          {result?.worstCrash && result.worstCrash.frames.length > 1 && <CrashReplayView replay={result.worstCrash} level={level} />}
          <div className="result-awards">
            {awards.map((award) => (
              <div className="result-award" key={`${award.title}:${award.player}`}><i>{award.icon}</i><span><small>{award.player}</small><b>{award.title}</b></span></div>
            ))}
          </div>
        </div>
      )}

      {confirmLeave && (
        <div className="game-overlay exit-overlay" role="dialog" aria-modal="true" aria-labelledby="exit-title">
          <span>ABANDON JOB?</span>
          <strong id="exit-title">LEAVE THE ROOM?</strong>
          <p>Your crew may continue without you. Your shame will remain.</p>
          <div>
            <button className="primary-button" type="button" onClick={onLeave}>YES, I'M OUT</button>
            <button className="secondary-button" type="button" onClick={() => setConfirmLeave(false)}>KEEP MOVING</button>
          </div>
        </div>
      )}
    </main>
  );
}

function ConnectingOverlay({ status, error, onCancel }: { status: ConnectionStatus; error: string | null; onCancel: () => void }) {
  const failed = status === "error";
  return (
    <div className="connection-overlay" role={failed ? "alert" : "status"}>
      <div className={`moving-truck${failed ? " is-stopped" : ""}`}><i /><b>CM</b><span /><span /></div>
      <span className="eyebrow">{failed ? "DISPATCH PROBLEM" : "CALLING THE CREW"}</span>
      <h2>{failed ? "That room got away." : "Finding your loading bay…"}</h2>
      {failed && <p>{error ?? "We could not join that room."}</p>}
      {failed && <button className="secondary-button" type="button" onClick={onCancel}>BACK TO DISPATCH</button>}
    </div>
  );
}

export default function App() {
  const [profile, setProfileState] = useState<PlayerProfile>(loadProfile);
  const initialCode = normalizeRoomCode(new URLSearchParams(window.location.search).get("room") ?? "");
  const [joinCode, setJoinCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [landingError, setLandingError] = useState<string | null>(null);
  const [howToOpen, setHowToOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [muted, setMuted] = useState(() => window.localStorage.getItem(MUTE_KEY) === "true");
  const connection = useRoomConnection(profile);
  const audio = useGameAudio({
    muted,
    phase: connection.room?.phase ?? null,
    level: (connection.room?.levelIndex ?? 0) + 1,
  });
  const autoJoinedRef = useRef(false);
  const joystickRef = useRef<Vec2>({ x: 0, y: 0 });
  const keyboardRef = useRef(new Set<string>());
  const movementRef = useRef<Vec2>({ x: 0, y: 0 });
  const grippedRef = useRef(false);
  const lastAudioEventRef = useRef(0);
  const previousPhaseRef = useRef(connection.room?.phase);
  const gameCanvasPrefetchedRef = useRef(false);
  const gameActive = connection.room?.phase === "playing" && connection.status === "connected";

  const snapshotMe = connection.latestSnapshot?.players.find((player) => player.id === connection.playerId);
  grippedRef.current = snapshotMe?.gripped ?? false;

  useEffect(() => {
    if (autoJoinedRef.current || initialCode.length !== 6) return;
    autoJoinedRef.current = true;
    connection.connect(initialCode);
  }, [connection.connect, initialCode]);

  useEffect(() => {
    if (!connection.room || gameCanvasPrefetchedRef.current) return;
    gameCanvasPrefetchedRef.current = true;
    void loadGameCanvas();
  }, [connection.room]);

  useEffect(() => {
    if (!connection.room) return;
    const url = new URL(window.location.href);
    url.searchParams.set("room", connection.room.code);
    window.history.replaceState(null, "", url);
  }, [connection.room]);

  useEffect(() => {
    if (!connection.notice) return;
    const timer = window.setTimeout(connection.dismissNotice, 3_200);
    return () => window.clearTimeout(timer);
  }, [connection.dismissNotice, connection.notice]);

  useEffect(() => {
    const phase = connection.room?.phase;
    if (phase === "complete" && previousPhaseRef.current !== "complete") audio.playComplete();
    if (phase === "failed" && previousPhaseRef.current !== "failed") audio.playCollision(1);
    previousPhaseRef.current = phase;
  }, [audio, connection.room?.phase]);

  useEffect(() => {
    const events = connection.latestSnapshot?.events ?? [];
    for (const event of events) {
      if (event.id <= lastAudioEventRef.current) continue;
      if (event.kind === "break") audio.playBreak();
      else if (event.kind === "impact") audio.playCollision(Math.min(1, event.amount / 18));
      else audio.playCollision(0.45);
      lastAudioEventRef.current = Math.max(lastAudioEventRef.current, event.id);
    }
  }, [audio, connection.latestSnapshot?.events]);

  useEffect(() => {
    lastAudioEventRef.current = 0;
  }, [connection.room?.levelIndex]);

  const setProfile = (nextProfile: PlayerProfile) => {
    setProfileState(nextProfile);
    saveProfile(nextProfile);
    if (connection.room) connection.setProfile(nextProfile);
    audio.playUiTap();
  };

  const join = useCallback((code: string) => {
    const normalized = normalizeRoomCode(code);
    if (normalized.length !== 6) {
      setLandingError("That code needs six letters.");
      return;
    }
    setLandingError(null);
    connection.connect(normalized);
  }, [connection.connect]);

  const handleCreate = async () => {
    setBusy(true);
    setLandingError(null);
    audio.playUiTap();
    try {
      const code = await createRoom();
      setJoinCode(code);
      connection.connect(code);
    } catch (error) {
      setLandingError(error instanceof Error ? error.message : "Could not create a room.");
    } finally {
      setBusy(false);
    }
  };

  const handleLeave = () => {
    connection.leave();
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState(null, "", url);
    setLandingError(null);
  };

  const handleShare = async () => {
    const room = connection.room;
    if (!room) return;
    const invite = new URL(window.location.href);
    invite.search = "";
    invite.searchParams.set("room", room.code);
    const shareData = { title: "Help me move this couch!", text: `Join my COUCH MOVERS crew. Room ${room.code}`, url: invite.toString() };
    try {
      if (navigator.share) await navigator.share(shareData);
      else await navigator.clipboard.writeText(`${shareData.text}\n${shareData.url}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_200);
      audio.playUiTap();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(invite.toString());
        setCopied(true);
      } catch {
        setLandingError(`Share this link: ${invite.toString()}`);
      }
    }
  };

  const recomputeMovement = useCallback(() => {
    const joystick = joystickRef.current;
    const previous = movementRef.current;
    let next: Vec2;
    if (Math.hypot(joystick.x, joystick.y) > 0.06) {
      next = joystick;
    } else {
      const keys = keyboardRef.current;
      let x = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
      let y = (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) - (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0);
      const length = Math.hypot(x, y);
      if (length > 1) {
        x /= length;
        y /= length;
      }
      next = { x, y };
    }
    movementRef.current = next;
    const wasMoving = Math.hypot(previous.x, previous.y) > 0.06;
    const isMoving = Math.hypot(next.x, next.y) > 0.06;
    if (gameActive && wasMoving !== isMoving) {
      connection.sendMove(next.x, next.y);
    }
  }, [connection.sendMove, gameActive]);

  const handleJoystick = useCallback((movement: Vec2) => {
    joystickRef.current = movement;
    recomputeMovement();
  }, [recomputeMovement]);

  useEffect(() => {
    const isTyping = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    const movementCodes = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
    const keyDown = (event: KeyboardEvent) => {
      if (!gameActive || isTyping(event.target)) return;
      if (movementCodes.has(event.code)) {
        event.preventDefault();
        keyboardRef.current.add(event.code);
        recomputeMovement();
      }
      if (event.code === "Space" && !event.repeat) {
        event.preventDefault();
        connection.toggleGrip();
        audio.playGrip(!grippedRef.current);
      }
      const phrase = NUMBER_SHOUTS[event.key];
      if (phrase && !event.repeat) {
        event.preventDefault();
        connection.shout(phrase);
        audio.playShout(SHOUTS.indexOf(phrase));
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (!movementCodes.has(event.code)) return;
      keyboardRef.current.delete(event.code);
      recomputeMovement();
    };
    const clearKeys = () => {
      keyboardRef.current.clear();
      joystickRef.current = { x: 0, y: 0 };
      recomputeMovement();
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", clearKeys);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", clearKeys);
      clearKeys();
    };
  }, [audio, connection.shout, connection.toggleGrip, gameActive, recomputeMovement]);

  useEffect(() => {
    if (!gameActive) {
      connection.sendMove(0, 0);
      return;
    }
    const timer = window.setInterval(() => {
      connection.sendMove(movementRef.current.x, movementRef.current.y);
    }, 40);
    return () => {
      window.clearInterval(timer);
      connection.sendMove(0, 0);
    };
  }, [connection.sendMove, gameActive]);

  const localPlayer = useMemo(
    () => connection.room?.players.find((player) => player.id === connection.playerId) ?? null,
    [connection.playerId, connection.room?.players],
  );

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    window.localStorage.setItem(MUTE_KEY, String(next));
    if (!next) window.setTimeout(() => { void audio.activate(); }, 0);
  };

  const sendGrip = () => {
    connection.toggleGrip();
    audio.playGrip(!grippedRef.current);
  };

  const sendShout = (phrase: ShoutPhrase) => {
    connection.shout(phrase);
    audio.playShout(SHOUTS.indexOf(phrase));
  };

  const roomScreen = connection.room && localPlayer;

  return (
    <div className="app-shell">
      {!roomScreen && connection.status !== "connecting" && connection.status !== "reconnecting" && (
        <button className="mute-button" type="button" aria-label={muted ? "Unmute sounds" : "Mute sounds"} onClick={toggleMute}>
          {muted ? "◒" : "♪"}
        </button>
      )}

      {!roomScreen && connection.status !== "connecting" && connection.status !== "reconnecting" && connection.status !== "error" && (
        <Landing
          joinCode={joinCode}
          busy={busy}
          error={landingError}
          onCodeChange={(code) => { setJoinCode(code); setLandingError(null); }}
          onCreate={() => { void handleCreate(); }}
          onJoin={() => join(joinCode)}
          onHowTo={() => setHowToOpen(true)}
        />
      )}

      {!roomScreen && ["connecting", "reconnecting", "error"].includes(connection.status) && (
        <ConnectingOverlay status={connection.status} error={connection.error} onCancel={handleLeave} />
      )}

      {roomScreen && connection.room?.phase === "lobby" && (
        <Lobby
          room={connection.room}
          localPlayer={localPlayer}
          profile={profile}
          connectionStatus={connection.status}
          copied={copied}
          onProfile={setProfile}
          onReady={(ready) => { connection.setReady(ready); audio.playUiTap(); }}
          onSelectLevel={(levelIndex) => { connection.selectLevel(levelIndex); audio.playUiTap(); }}
          onStart={() => { connection.startGame(); audio.playUiTap(); }}
          onShare={() => { void handleShare(); }}
          onLeave={handleLeave}
        />
      )}

      {roomScreen && connection.room?.phase !== "lobby" && (
        <GameView
          connection={connection}
          localPlayer={localPlayer}
          muted={muted}
          onMute={toggleMute}
          onMove={handleJoystick}
          onGrip={sendGrip}
          onShout={sendShout}
          onLeave={handleLeave}
          onPlayAgain={() => { connection.playAgain(); audio.playUiTap(); }}
          onNextLevel={() => { connection.nextLevel(); audio.playUiTap(); }}
        />
      )}

      {howToOpen && <HowTo onClose={() => setHowToOpen(false)} />}

      {connection.notice && (
        <button
          type="button"
          className={`toast is-${connection.notice.kind}`}
          onClick={connection.dismissNotice}
          role={connection.notice.kind === "error" ? "alert" : "status"}
          aria-live={connection.notice.kind === "error" ? "assertive" : "polite"}
          aria-label={`${connection.notice.message}. Dismiss`}
        >
          <span>{connection.notice.kind === "warning" ? "!" : connection.notice.kind === "error" ? "×" : "i"}</span>
          {connection.notice.message}
        </button>
      )}
    </div>
  );
}
