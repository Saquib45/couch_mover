import { useEffect, useRef, type RefObject } from "react";
import { Application, Container, Graphics, Text, type Ticker } from "pixi.js";
import {
  canClimbLadder,
  getHandlePoints,
  SERVER_TICK_MS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type BodySnapshot,
  type GameSnapshot,
  type LevelDefinition,
  type SnapshotPlayer,
} from "@couch-movers/shared";

interface GameCanvasProps {
  level: LevelDefinition;
  snapshots: RefObject<GameSnapshot[]>;
  clockOffset: RefObject<number>;
  latency: RefObject<number | null>;
  localPlayerId: string | null;
}

interface PlayerVisual {
  root: Container;
  art: Graphics;
  label: Text;
  bubble: Container;
  bubblePlate: Graphics;
  bubbleText: Text;
  styleKey: string;
}

const COLOR_HEX: Record<string, number> = {
  tomato: 0xef5b4c,
  sunny: 0xf6c445,
  mint: 0x45c99a,
  sky: 0x4a9ee8,
};

const COLOR_DARK: Record<string, number> = {
  tomato: 0x9f2f2b,
  sunny: 0x9a6811,
  mint: 0x197658,
  sky: 0x235e9e,
};

const MIN_INTERPOLATION_DELAY_MS = 60;
const MAX_INTERPOLATION_DELAY_MS = 120;

function targetInterpolationDelay(roundTripMs: number | null): number {
  // Keep one authoritative tick plus the estimated one-way trip buffered. A
  // fast LAN no longer pays the old fixed 85 ms delay, while slower internet
  // connections retain enough history to interpolate instead of stuttering.
  const oneWayMs = (roundTripMs ?? 40) / 2;
  return Math.max(
    MIN_INTERPOLATION_DELAY_MS,
    Math.min(MAX_INTERPOLATION_DELAY_MS, SERVER_TICK_MS + oneWayMs + 8),
  );
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function lerpAngle(from: number, to: number, amount: number): number {
  const delta = ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return from + delta * amount;
}

function interpolateBody<T extends BodySnapshot>(from: T, to: T, amount: number): T {
  return {
    ...to,
    x: lerp(from.x, to.x, amount),
    y: lerp(from.y, to.y, amount),
    angle: lerpAngle(from.angle, to.angle, amount),
    vx: lerp(from.vx, to.vx, amount),
    vy: lerp(from.vy, to.vy, amount),
    angularVelocity: lerp(from.angularVelocity, to.angularVelocity, amount),
  };
}

function sampleSnapshots(buffer: GameSnapshot[], targetTime: number): GameSnapshot | null {
  if (!buffer.length) return null;

  let before = buffer[0];
  let after: GameSnapshot | undefined = buffer[0];
  // The render target is normally near the newest packet, so scanning backward
  // avoids walking the whole interpolation buffer on every animation frame.
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    const snapshot = buffer[index];
    if (snapshot && snapshot.serverTime <= targetTime) {
      before = snapshot;
      after = buffer[index + 1] ?? snapshot;
      break;
    }
  }

  if (!before) return null;
  if (!after || after === before) return before;
  const duration = Math.max(1, after.serverTime - before.serverTime);
  const amount = Math.max(0, Math.min(1, (targetTime - before.serverTime) / duration));
  const previousPlayers = new Map(before.players.map((player) => [player.id, player]));
  const previousBreakables = new Map(before.breakables.map((item) => [item.id, item]));

  return {
    ...after,
    serverTime: targetTime,
    couch: interpolateBody(before.couch, after.couch, amount),
    players: after.players.map((player) => {
      const previous = previousPlayers.get(player.id);
      return previous ? interpolateBody(previous, player, amount) : player;
    }),
    breakables: after.breakables.map((item) => {
      const previous = previousBreakables.get(item.id);
      return previous ? {
        ...item,
        x: lerp(previous.x, item.x, amount),
        y: lerp(previous.y, item.y, amount),
        angle: lerpAngle(previous.angle, item.angle, amount),
      } : item;
    }),
    cat: before.cat && after.cat ? interpolateBody(before.cat, after.cat, amount) : after.cat,
    deliveryProgress: lerp(before.deliveryProgress, after.deliveryProgress, amount),
    elapsedMs: lerp(before.elapsedMs, after.elapsedMs, amount),
  };
}

function drawDashedRect(graphics: Graphics, x: number, y: number, width: number, height: number): void {
  const dash = 18;
  const gap = 11;
  const drawSide = (ax: number, ay: number, bx: number, by: number) => {
    const distance = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / distance;
    const uy = (by - ay) / distance;
    for (let offset = 0; offset < distance; offset += dash + gap) {
      const end = Math.min(distance, offset + dash);
      graphics.moveTo(ax + ux * offset, ay + uy * offset).lineTo(ax + ux * end, ay + uy * end);
    }
  };

  drawSide(x, y, x + width, y);
  drawSide(x + width, y, x + width, y + height);
  drawSide(x + width, y + height, x, y + height);
  drawSide(x, y + height, x, y);
  graphics.stroke({ color: 0x16765a, width: 6, alpha: 0.8 });
}

function isRopeLevel(level: LevelDefinition): boolean {
  return level.mechanic === "rope-climb";
}

function drawLadderSegment(
  graphics: Graphics,
  from: { x: number; y: number },
  to: { x: number; y: number },
  metal = false,
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 8) return;
  const ux = dx / distance;
  const uy = dy / distance;
  const nx = -uy;
  const ny = ux;
  const railOffset = 32;

  // A broad shaft makes the only legal vertical route obvious on a phone screen.
  graphics
    .moveTo(from.x, from.y)
    .lineTo(to.x, to.y)
    .stroke({ color: 0x1d2630, width: 88, alpha: 0.26 });
  graphics
    .moveTo(from.x, from.y)
    .lineTo(to.x, to.y)
    .stroke({ color: metal ? 0x8fa7ae : 0xdcb777, width: 76, alpha: 0.22 });

  for (const side of [-1, 1]) {
    const offsetX = nx * railOffset * side;
    const offsetY = ny * railOffset * side;
    graphics
      .moveTo(from.x + offsetX + 3, from.y + offsetY + 4)
      .lineTo(to.x + offsetX + 3, to.y + offsetY + 4)
      .stroke({ color: 0x25283a, width: 13, alpha: 0.52 });
    graphics
      .moveTo(from.x + offsetX, from.y + offsetY)
      .lineTo(to.x + offsetX, to.y + offsetY)
      .stroke({ color: metal ? 0xd8e4e5 : 0x9b5d1b, width: 8, alpha: 0.96 });
  }

  for (let offset = 16; offset < distance - 10; offset += 30) {
    const cx = from.x + ux * offset;
    const cy = from.y + uy * offset;
    graphics
      .moveTo(cx + nx * (railOffset - 2) + 2, cy + ny * (railOffset - 2) + 3)
      .lineTo(cx - nx * (railOffset - 2) + 2, cy - ny * (railOffset - 2) + 3)
      .stroke({ color: 0x25283a, width: 10, alpha: 0.48 });
    graphics
      .moveTo(cx + nx * (railOffset - 2), cy + ny * (railOffset - 2))
      .lineTo(cx - nx * (railOffset - 2), cy - ny * (railOffset - 2))
      .stroke({ color: metal ? 0xf6c445 : 0xd79532, width: 6, alpha: 0.98 });
  }

  // Sparse arrows preserve the H-shaped rungs while keeping the climb direction obvious.
  for (let offset = 105; offset < distance - 35; offset += 180) {
    const cx = from.x + ux * offset;
    const cy = from.y + uy * offset;
    const tipX = cx + ux * 18;
    const tipY = cy + uy * 18;
    graphics
      .moveTo(tipX - ux * 22 + nx * 15, tipY - uy * 22 + ny * 15)
      .lineTo(tipX, tipY)
      .lineTo(tipX - ux * 22 - nx * 15, tipY - uy * 22 - ny * 15)
      .stroke({ color: 0xffffff, width: 6, alpha: 0.5 });
  }
}

function drawHoistRoute(graphics: Graphics, level: LevelDefinition): void {
  const metal = String(level.theme) === "fire-escape" || String(level.theme) === "ladder-maze";
  const shafts = new Map<string, NonNullable<LevelDefinition["ladders"]>>();
  for (const ladder of level.ladders ?? []) {
    const lanes = shafts.get(ladder.shaftId) ?? [];
    lanes.push(ladder);
    shafts.set(ladder.shaftId, lanes);
  }
  for (const lanes of shafts.values()) {
    const sorted = [...lanes].sort((a, b) => a.x - b.x);
    const left = sorted[0];
    const right = sorted[sorted.length - 1];
    if (!left || !right) continue;
    const top = Math.min(...sorted.map((ladder) => ladder.y - ladder.height / 2));
    graphics
      .moveTo(left.x - 42, top + 5)
      .lineTo(right.x + 42, top + 5)
      .stroke({ color: 0x25283a, width: 18, alpha: 0.72 });
    graphics
      .moveTo(left.x - 40, top)
      .lineTo(right.x + 40, top)
      .stroke({ color: metal ? 0xd8e4e5 : 0xd79532, width: 10, alpha: 0.98 });
    for (const ladder of sorted) {
      graphics.circle(ladder.x, top, 13).fill(metal ? 0xf6c445 : 0xf0b54d).stroke({ color: 0x25283a, width: 5 });
    }
  }
  for (const ladder of level.ladders ?? []) {
    const top = ladder.y - ladder.height / 2;
    const bottom = ladder.y + ladder.height / 2;
    graphics
      .roundRect(ladder.x - ladder.width / 2, top, ladder.width, ladder.height, 18)
      .fill({ color: metal ? 0x233943 : 0x4c3a31, alpha: 0.13 })
      .stroke({ color: 0xfff2c9, width: 4, alpha: 0.16 });
    drawLadderSegment(graphics, { x: ladder.x, y: bottom }, { x: ladder.x, y: top }, metal);
  }
}

function drawStaticWorld(graphics: Graphics, level: LevelDefinition): void {
  const theme = String(level.theme);
  const floor = theme === "ladder-maze" ? 0x4f6470
    : theme === "fire-escape" ? 0x657c85
    : theme === "attic-ladder" ? 0x9e8b75
      : theme === "office" ? 0xb9c79f
      : theme === "balcony" ? 0xb7d8dd
        : theme === "living-room" ? 0xd8ae73
          : theme === "cat-chaos" ? 0xdcb777
            : theme === "corner" ? 0xe5c27d
          : 0xe9c981;
  const plank = theme === "ladder-maze" ? 0x263a45
    : theme === "fire-escape" ? 0x344c57
    : theme === "attic-ladder" ? 0x6f5e4f
      : theme === "office" ? 0x718b67
      : theme === "balcony" ? 0x6fabb6
        : 0xbd9256;
  graphics.rect(0, 0, WORLD_WIDTH, WORLD_HEIGHT).fill(floor);

  if (theme === "attic-ladder") {
    graphics.rect(61, 94, 1158, 249).fill({ color: 0xfff2c9, alpha: 0.12 });
    graphics.rect(61, 377, 1158, 250).fill({ color: 0x513b35, alpha: 0.09 });
  } else if (theme === "fire-escape") {
    graphics.rect(61, 94, 1158, 174).fill({ color: 0xbce5e9, alpha: 0.1 });
    graphics.rect(61, 302, 1158, 156).fill({ color: 0x243c46, alpha: 0.09 });
    graphics.rect(61, 492, 1158, 135).fill({ color: 0xbce5e9, alpha: 0.07 });
  } else if (theme === "ladder-maze") {
    graphics.rect(61, 94, 1158, 164).fill({ color: 0x9fe3e9, alpha: 0.1 });
    graphics.rect(61, 292, 1158, 161).fill({ color: 0x182c36, alpha: 0.13 });
    graphics.rect(61, 487, 1158, 140).fill({ color: 0x9fe3e9, alpha: 0.07 });
  }

  for (let x = 0; x < WORLD_WIDTH; x += 84) {
    graphics.rect(x, 0, 3, WORLD_HEIGHT).fill({ color: plank, alpha: 0.24 });
  }
  for (let y = 22; y < WORLD_HEIGHT; y += 58) {
    graphics.rect(0, y, WORLD_WIDTH, 2).fill({ color: 0xffffff, alpha: 0.13 });
  }

  if (isRopeLevel(level)) drawHoistRoute(graphics, level);

  if (theme === "hallway") {
    graphics.roundRect(280, 92, 240, 92, 20).fill({ color: 0xe8684a, alpha: 0.16 });
    graphics.roundRect(820, 535, 220, 70, 18).fill({ color: 0x4a9ee8, alpha: 0.14 });
  } else if (theme === "living-room") {
    graphics.ellipse(650, 360, 235, 150).fill({ color: 0xc95e56, alpha: 0.14 });
    graphics.ellipse(650, 360, 190, 112).stroke({ color: 0xfff2c9, width: 8, alpha: 0.24 });
  } else if (theme === "cat-chaos") {
    for (let x = 260; x < 1120; x += 170) graphics.circle(x, 350, 12).fill({ color: 0x8a6242, alpha: 0.14 });
  } else if (theme === "balcony") {
    for (let x = 875; x < 1210; x += 52) graphics.rect(x, 90, 7, 540).fill({ color: 0xffffff, alpha: 0.24 });
    graphics.rect(858, 78, 370, 10).fill({ color: 0x276778, alpha: 0.35 });
  } else if (theme === "attic-ladder") {
    for (let x = 115; x < 1210; x += 145) {
      graphics.circle(x, 155 + (x % 3) * 86, 11).fill({ color: 0xf7e9c9, alpha: 0.13 });
      graphics.moveTo(x - 22, 568).lineTo(x + 24, 568).stroke({ color: 0x493f39, width: 5, alpha: 0.25 });
    }
  } else if (theme === "fire-escape") {
    for (let x = 120; x < 1210; x += 150) {
      graphics.roundRect(x, 112, 74, 48, 6).fill({ color: 0x9dd8e2, alpha: 0.18 }).stroke({ color: 0x263945, width: 4, alpha: 0.28 });
    }
    for (let y = 215; y < 610; y += 110) {
      graphics.moveTo(90, y).lineTo(205, y - 24).stroke({ color: 0xffffff, width: 5, alpha: 0.16 });
      graphics.moveTo(1060, y + 18).lineTo(1190, y - 10).stroke({ color: 0xffffff, width: 5, alpha: 0.16 });
    }
  } else if (theme === "office") {
    for (let x = 120; x < 1200; x += 165) {
      graphics.roundRect(x, 110, 104, 58, 8).fill({ color: 0xf7f0d3, alpha: 0.16 }).stroke({ color: 0x405442, width: 4, alpha: 0.2 });
      graphics.rect(x + 14, 127, 36, 5).fill({ color: 0x4a9ee8, alpha: 0.28 });
      graphics.rect(x + 57, 127, 27, 5).fill({ color: 0xef5b4c, alpha: 0.24 });
    }
    for (let y = 210; y < 620; y += 105) {
      graphics.moveTo(80, y).lineTo(1200, y).stroke({ color: 0xffffff, width: 2, alpha: 0.12 });
    }
  } else if (theme === "ladder-maze") {
    for (let x = 80; x < 1220; x += 80) {
      graphics.circle(x, 470, 5).fill({ color: 0xd8e4e5, alpha: 0.28 });
      graphics.circle(x, 275, 5).fill({ color: 0xd8e4e5, alpha: 0.28 });
    }
    for (let x = 90; x < 1190; x += 58) {
      graphics.moveTo(x, 608).lineTo(x + 28, 628).stroke({ color: 0xf6c445, width: 8, alpha: 0.18 });
    }
  }

  const targetX = level.target.x - level.target.width / 2;
  const targetY = level.target.y - level.target.height / 2;
  graphics
    .roundRect(targetX, targetY, level.target.width, level.target.height, 24)
    .fill({ color: 0x50d5a1, alpha: 0.26 });
  for (let stripe = -level.target.height; stripe < level.target.width; stripe += 34) {
    const startX = Math.max(0, stripe);
    const startY = Math.max(0, -stripe);
    const length = Math.min(level.target.width - startX, level.target.height - startY);
    if (length > 0) {
      graphics
        .moveTo(targetX + startX, targetY + startY)
        .lineTo(targetX + startX + length, targetY + startY + length)
        .stroke({ color: 0x16765a, width: 5, alpha: 0.12 });
    }
  }
  drawDashedRect(graphics, targetX, targetY, level.target.width, level.target.height);
  if (level.target.requiredAngle !== undefined) {
    const cosine = Math.cos(level.target.requiredAngle);
    const sine = Math.sin(level.target.requiredAngle);
    const corners = [
      { x: -78, y: -39 },
      { x: 78, y: -39 },
      { x: 78, y: 39 },
      { x: -78, y: 39 },
    ].map((point) => ({
      x: level.target.x + point.x * cosine - point.y * sine,
      y: level.target.y + point.x * sine + point.y * cosine,
    }));
    const first = corners[0];
    if (first) {
      graphics.moveTo(first.x, first.y);
      for (const point of corners.slice(1)) graphics.lineTo(point.x, point.y);
      graphics.closePath().stroke({ color: 0x16765a, width: 5, alpha: 0.34 });
    }
  }

  for (const wall of level.walls) {
    const x = wall.x - wall.width / 2;
    const y = wall.y - wall.height / 2;
    graphics.roundRect(x + 7, y + 8, wall.width, wall.height, 7).fill({ color: 0x3a2e3b, alpha: 0.23 });
    graphics.roundRect(x, y, wall.width, wall.height, 7).fill(0xf7e9c9);
    graphics.roundRect(x, y, wall.width, wall.height, 7).stroke({ color: 0x2f2940, width: 6 });
    if (wall.width > wall.height) {
      graphics.rect(x + 8, y + 8, wall.width - 16, 7).fill({ color: 0xffffff, alpha: 0.58 });
    } else {
      graphics.rect(x + 8, y + 8, 7, wall.height - 16).fill({ color: 0xffffff, alpha: 0.58 });
    }
  }

  if (theme === "hallway") {
    graphics.roundRect(625, 294, 60, 18, 7).fill(0x8e563f).stroke({ color: 0x2f2940, width: 4 });
    graphics.roundRect(625, 408, 60, 18, 7).fill(0x8e563f).stroke({ color: 0x2f2940, width: 4 });
    graphics.moveTo(705, 360).lineTo(755, 360).stroke({ color: 0xffffff, width: 10, alpha: 0.52 });
    graphics.moveTo(744, 344).lineTo(762, 360).lineTo(744, 376).stroke({ color: 0xffffff, width: 10, alpha: 0.52 });
  }
}

function drawCouch(graphics: Graphics, playerCount: number, damageStage: number): void {
  graphics.clear();
  graphics.roundRect(-89, -39, 182, 90, 18).fill({ color: 0x2f2940, alpha: 0.22 });
  graphics.roundRect(-91, -45, 182, 90, 18).fill(0x295f73).stroke({ color: 0x242038, width: 7 });
  graphics.roundRect(-78, -32, 70, 64, 14).fill(0x3c8291).stroke({ color: 0x242038, width: 4 });
  graphics.roundRect(8, -32, 70, 64, 14).fill(0x3c8291).stroke({ color: 0x242038, width: 4 });
  graphics.roundRect(-80, -40, 160, 18, 9).fill(0x4c94a0);
  graphics.circle(-43, 0, 4).fill({ color: 0xf7e9c9, alpha: 0.7 });
  graphics.circle(43, 0, 4).fill({ color: 0xf7e9c9, alpha: 0.7 });

  if (damageStage >= 1) {
    graphics.moveTo(-20, -39).lineTo(-8, -25).lineTo(-19, -11).lineTo(-4, 1).stroke({ color: 0xfff0c4, width: 4, alpha: 0.78 });
  }
  if (damageStage >= 2) {
    graphics.moveTo(42, 28).lineTo(29, 15).lineTo(43, 3).lineTo(33, -11).stroke({ color: 0xfff0c4, width: 4, alpha: 0.78 });
    graphics.circle(80, -24, 8).fill(0xfff3d2).stroke({ color: 0x2f2940, width: 2 });
    graphics.circle(88, -17, 6).fill(0xfff3d2).stroke({ color: 0x2f2940, width: 2 });
  }

  for (const handle of getHandlePoints(playerCount)) {
    graphics.roundRect(handle.x - 9, handle.y - 6, 18, 12, 5).fill(0xf5b73b).stroke({ color: 0x242038, width: 3 });
  }
}

function drawHat(graphics: Graphics, hat: string): void {
  switch (hat) {
    case "hardhat":
      graphics.arc(0, -25, 17, Math.PI, Math.PI * 2).fill(0xf6c445).stroke({ color: 0x2f2940, width: 3 });
      graphics.roundRect(-21, -27, 42, 7, 3).fill(0xf6c445).stroke({ color: 0x2f2940, width: 3 });
      graphics.rect(-3, -42, 6, 18).fill(0xe6a52c);
      break;
    case "cowboy":
      graphics.ellipse(0, -26, 26, 8).fill(0xc87843).stroke({ color: 0x2f2940, width: 3 });
      graphics.roundRect(-14, -43, 28, 20, 8).fill(0xc87843).stroke({ color: 0x2f2940, width: 3 });
      break;
    case "crown":
      graphics.moveTo(-17, -23).lineTo(-16, -43).lineTo(-6, -34).lineTo(0, -46).lineTo(8, -34).lineTo(18, -43).lineTo(17, -23).closePath().fill(0xf6c445).stroke({ color: 0x2f2940, width: 3 });
      break;
    default:
      graphics.arc(0, -27, 16, Math.PI, Math.PI * 2).fill(0xe95b4d).stroke({ color: 0x2f2940, width: 3 });
      graphics.roundRect(-18, -29, 36, 7, 3).fill(0xe95b4d).stroke({ color: 0x2f2940, width: 3 });
      graphics.roundRect(12, -28, 19, 6, 3).fill(0xe95b4d).stroke({ color: 0x2f2940, width: 3 });
      break;
  }
}

function drawMover(
  graphics: Graphics,
  player: SnapshotPlayer,
  isLocal: boolean,
  panicked: boolean,
  sideView: boolean,
  climbing: boolean,
  motionFrame: number,
): void {
  const color = COLOR_HEX[player.profile.color] ?? 0xef5b4c;
  const dark = COLOR_DARK[player.profile.color] ?? 0x9f2f2b;
  graphics.clear();
  if (!climbing) {
    graphics.ellipse(4, sideView ? 34 : 12, sideView ? 25 : 27, sideView ? 8 : 17).fill({ color: 0x2f2940, alpha: sideView ? 0.16 : 0.22 });
  }

  if (sideView) {
    const leftLift = climbing && motionFrame === 0 ? -9 : 3;
    const rightLift = climbing && motionFrame === 1 ? -9 : 3;
    graphics.moveTo(-9, 13).lineTo(-13, 34 + leftLift).stroke({ color: dark, width: 10 });
    graphics.moveTo(9, 13).lineTo(13, 34 + rightLift).stroke({ color: dark, width: 10 });
    graphics.roundRect(-22, 30 + leftLift, 18, 9, 4).fill(0x2f2940);
    graphics.roundRect(5, 30 + rightLift, 18, 9, 4).fill(0x2f2940);
  }

  if (climbing) {
    const leftHandY = motionFrame === 0 ? -25 : -10;
    const rightHandY = motionFrame === 1 ? -25 : -10;
    graphics.moveTo(-18, 0).lineTo(-31, leftHandY).stroke({ color: dark, width: 10 });
    graphics.moveTo(18, 0).lineTo(31, rightHandY).stroke({ color: dark, width: 10 });
    graphics.circle(-32, leftHandY, 7).fill(0xf0b88e).stroke({ color: 0x2f2940, width: 3 });
    graphics.circle(32, rightHandY, 7).fill(0xf0b88e).stroke({ color: 0x2f2940, width: 3 });
  } else if (player.gripped) {
    graphics.moveTo(-19, 2).lineTo(-31, -2).stroke({ color: dark, width: 11 });
    graphics.moveTo(19, 2).lineTo(31, -2).stroke({ color: dark, width: 11 });
    graphics.circle(-33, -2, 7).fill(0xf0b88e).stroke({ color: 0x2f2940, width: 3 });
    graphics.circle(33, -2, 7).fill(0xf0b88e).stroke({ color: 0x2f2940, width: 3 });
  } else {
    graphics.moveTo(-18, 4).lineTo(-21, 18).stroke({ color: dark, width: 10 });
    graphics.moveTo(18, 4).lineTo(21, 18).stroke({ color: dark, width: 10 });
  }

  graphics.circle(0, 2, 25).fill(color).stroke({ color: isLocal ? 0xffffff : 0x2f2940, width: isLocal ? 7 : 5 });
  graphics.circle(0, -8, 15).fill(0xf0b88e).stroke({ color: 0x2f2940, width: 3 });
  graphics.circle(-5, -10, panicked ? 4 : 2.5).fill(0x2f2940);
  graphics.circle(5, -10, panicked ? 4 : 2.5).fill(0x2f2940);
  if (panicked) {
    graphics.circle(0, -1, 5).stroke({ color: 0x2f2940, width: 2.5 });
  } else if (player.gripped) {
    graphics.arc(0, -2, 6, Math.PI * 1.08, Math.PI * 1.92).stroke({ color: 0x2f2940, width: 2.5 });
  } else {
    graphics.moveTo(-5, -2).lineTo(5, -2).stroke({ color: 0x2f2940, width: 2.5 });
  }
  drawHat(graphics, player.profile.hat);

  if (!player.connected) {
    graphics.circle(0, 2, 31).fill({ color: 0x2f2940, alpha: 0.38 });
  }
}

function drawBreakable(graphics: Graphics, kind: string): void {
  graphics.clear();
  graphics.ellipse(3, 9, 19, 9).fill({ color: 0x2f2940, alpha: 0.2 });
  if (kind === "lamp") {
    graphics.rect(-3, -8, 6, 24).fill(0x694c3a);
    graphics.moveTo(-16, -8).lineTo(-10, -29).lineTo(10, -29).lineTo(16, -8).closePath().fill(0xf6c445).stroke({ color: 0x2f2940, width: 3 });
    graphics.ellipse(0, 17, 14, 5).fill(0x694c3a);
  } else if (kind === "tv") {
    graphics.roundRect(-35, -18, 70, 38, 5).fill(0x2f2940);
    graphics.roundRect(-28, -12, 50, 25, 3).fill(0x78c4d3);
    graphics.circle(28, 1, 3).fill(0xf6c445);
  } else if (kind === "fishbowl") {
    graphics.circle(0, 0, 20).fill({ color: 0x7bd8e8, alpha: 0.72 }).stroke({ color: 0x2f2940, width: 3 });
    graphics.moveTo(-19, -13).lineTo(19, -13).stroke({ color: 0xffffff, width: 4, alpha: 0.8 });
    graphics.ellipse(3, 4, 7, 4).fill(0xef5b4c);
    graphics.moveTo(-3, 4).lineTo(-10, -1).lineTo(-10, 9).closePath().fill(0xef5b4c);
  } else {
    graphics.moveTo(-12, -16).lineTo(-8, 15).quadraticCurveTo(0, 23, 8, 15).lineTo(12, -16).closePath().fill(0x9a5fc2).stroke({ color: 0x2f2940, width: 3 });
    graphics.ellipse(0, -16, 12, 5).fill(0xdca7ef).stroke({ color: 0x2f2940, width: 3 });
  }
}

function drawCat(graphics: Graphics): void {
  graphics.clear();
  graphics.ellipse(4, 10, 30, 14).fill({ color: 0x2f2940, alpha: 0.2 });
  graphics.moveTo(-18, -8).quadraticCurveTo(-42, -32, -45, -4).stroke({ color: 0xbd6b36, width: 10 });
  graphics.ellipse(0, 0, 29, 20).fill(0xdd8647).stroke({ color: 0x2f2940, width: 4 });
  graphics.moveTo(-17, -13).lineTo(-13, -32).lineTo(-3, -17).closePath().fill(0xdd8647).stroke({ color: 0x2f2940, width: 3 });
  graphics.moveTo(17, -13).lineTo(13, -32).lineTo(3, -17).closePath().fill(0xdd8647).stroke({ color: 0x2f2940, width: 3 });
  graphics.circle(-8, -4, 3).fill(0x2f2940);
  graphics.circle(8, -4, 3).fill(0x2f2940);
  graphics.moveTo(-4, 5).lineTo(0, 8).lineTo(4, 5).stroke({ color: 0x2f2940, width: 2 });
}

function makePlayerVisual(world: Container): PlayerVisual {
  const root = new Container();
  const art = new Graphics();
  const label = new Text({
    text: "",
    style: {
      fill: 0x2f2940,
      fontFamily: "Arial, sans-serif",
      fontSize: 14,
      fontWeight: "800",
      align: "center",
    },
  });
  label.anchor.set(0.5);
  label.position.set(0, 44);

  const bubble = new Container();
  bubble.position.set(0, -72);
  const bubblePlate = new Graphics();
  const bubbleText = new Text({
    text: "",
    style: {
      fill: 0x2f2940,
      fontFamily: "Arial, sans-serif",
      fontSize: 17,
      fontWeight: "900",
      align: "center",
    },
  });
  bubbleText.anchor.set(0.5);
  bubble.addChild(bubblePlate, bubbleText);
  root.addChild(art, label, bubble);
  world.addChild(root);
  return { root, art, label, bubble, bubblePlate, bubbleText, styleKey: "" };
}

function drawSpring(graphics: Graphics, fromX: number, fromY: number, toX: number, toY: number): void {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const nx = -dy / distance;
  const ny = dx / distance;
  graphics.moveTo(fromX, fromY);
  const segments = 9;
  for (let i = 1; i < segments; i += 1) {
    const amount = i / segments;
    const wiggle = i % 2 === 0 ? -4 : 4;
    graphics.lineTo(fromX + dx * amount + nx * wiggle, fromY + dy * amount + ny * wiggle);
  }
  graphics.lineTo(toX, toY).stroke({ color: 0xfff6df, width: 5, alpha: 0.92 });
  graphics.moveTo(fromX, fromY).lineTo(toX, toY).stroke({ color: 0x2f2940, width: 2, alpha: 0.52 });
}

function drawRope(graphics: Graphics, fromX: number, fromY: number, toX: number, toY: number, ropeLength: number): void {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const nx = -dy / distance;
  const ny = dx / distance;
  const slack = Math.max(0, ropeLength - distance);
  const sag = distance > ropeLength ? 2 : Math.min(28, 8 + slack * 0.28);
  const middleX = fromX + dx * 0.5 + nx * sag;
  const middleY = fromY + dy * 0.5 + ny * sag;

  graphics
    .moveTo(fromX + 2, fromY + 3)
    .quadraticCurveTo(middleX + 2, middleY + 3, toX + 2, toY + 3)
    .stroke({ color: 0x2f2940, width: 10, alpha: 0.62 });
  graphics
    .moveTo(fromX, fromY)
    .quadraticCurveTo(middleX, middleY, toX, toY)
    .stroke({ color: 0xd69a47, width: 6, alpha: 0.98 });
  graphics
    .moveTo(fromX, fromY - 1)
    .quadraticCurveTo(middleX - nx * 2, middleY - ny * 2, toX, toY - 1)
    .stroke({ color: 0xffd77d, width: 2, alpha: 0.78 });
  graphics.circle(fromX, fromY, 6).fill(0xd69a47).stroke({ color: 0x2f2940, width: 3 });
  graphics.circle(toX, toY, 6).fill(0xd69a47).stroke({ color: 0x2f2940, width: 3 });
}

function makeFloorCue(text: string, x: number, y: number, rotation = 0): Text {
  const cue = new Text({
    text,
    style: {
      fill: 0xfff2c9,
      fontFamily: "Arial, sans-serif",
      fontSize: 23,
      fontWeight: "900",
      letterSpacing: 2,
      stroke: { color: 0x2f2940, width: 5 },
    },
  });
  cue.anchor.set(0.5);
  cue.position.set(x, y);
  cue.rotation = rotation;
  cue.alpha = 0.72;
  return cue;
}

export function GameCanvas({ level, snapshots, clockOffset, latency, localPlayerId }: GameCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const localPlayerIdRef = useRef(localPlayerId);

  useEffect(() => {
    localPlayerIdRef.current = localPlayerId;
  }, [localPlayerId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let app: Application | null = null;

    const start = async () => {
      const nextApp = new Application();
      const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
      await nextApp.init({
        resizeTo: host,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, coarsePointer ? 1.5 : 2),
        backgroundAlpha: 0,
        preference: "webgl",
      });
      if (disposed) {
        nextApp.destroy(true);
        return;
      }
      app = nextApp;
      nextApp.canvas.setAttribute(
        "aria-label",
        (level.ladders?.length ?? 0) > 0 ? "Side-view ladder moving game area" : "Top-down moving game area",
      );
      nextApp.canvas.setAttribute("role", "img");
      host.appendChild(nextApp.canvas);

      const world = new Container();
      const staticLayer = new Graphics();
      const floorCueLayer = new Container();
      const levelTheme = String(level.theme);
      if (levelTheme === "attic-ladder") {
        floorCueLayer.addChild(
          makeFloorCue("LINE UP  →", 455, 555),
          makeFloorCue("CLIMB  ↑", 745, 485),
          makeFloorCue("FLOOR 2  →", 930, 325),
        );
      } else if (levelTheme === "fire-escape") {
        floorCueLayer.addChild(
          makeFloorCue("LADDER 1  ↑", 1035, 555),
          makeFloorCue("←  FLOOR 2", 650, 440),
          makeFloorCue("LADDER 2  ↑", 470, 365),
          makeFloorCue("FLOOR 3  →", 735, 250),
        );
      } else if (levelTheme === "office") {
        floorCueLayer.addChild(
          makeFloorCue("↑  OVER", 345, 330),
          makeFloorCue("UNDER  ↓", 585, 390),
          makeFloorCue("↑  FINAL TURN", 845, 330),
        );
      } else if (levelTheme === "ladder-maze") {
        floorCueLayer.addChild(
          makeFloorCue("←  SHAFT 1", 650, 555),
          makeFloorCue("SHAFT 2  →", 665, 430),
          makeFloorCue("←  ONLY SAFE PLATFORM", 585, 245),
        );
      }
      const targetLabel = new Text({
        text: isRopeLevel(level) ? "DELIVER UPSTAIRS" : "PARK COUCH HERE",
        style: {
          fill: 0x16765a,
          fontFamily: "Arial, sans-serif",
          fontSize: 21,
          fontWeight: "900",
          letterSpacing: 2,
        },
      });
      targetLabel.anchor.set(0.5);
      targetLabel.position.set(level.target.x, level.target.y);
      targetLabel.alpha = 0.8;

      const constraintLayer = new Graphics();
      const propLayer = new Container();
      const propVisuals = new Map<string, Graphics>();
      const catArt = new Graphics();
      drawCat(catArt);
      const couchRoot = new Container();
      const couchArt = new Graphics();
      couchRoot.addChild(couchArt);
      const playerLayer = new Container();
      const effectLayer = new Container();
      const eventVisuals = new Map<number, { root: Container; bornAt: number }>();
      const playerVisuals = new Map<string, PlayerVisual>();
      let couchPlayerCount = -1;
      let couchDamageStage = -1;
      let lastShakeEventId = 0;
      let shakeStartedAt = -Infinity;
      let shakeStrength = 0;
      let cameraX = 0;
      let cameraY = 0;
      let cameraReady = false;
      let reducedFrameRate = false;
      let interpolationDelayMs = targetInterpolationDelay(latency.current);

      drawStaticWorld(staticLayer, level);
      world.addChild(staticLayer, floorCueLayer, targetLabel, propLayer, catArt, constraintLayer, couchRoot, playerLayer, effectLayer);
      nextApp.stage.addChild(world);

      const renderFrame = (_ticker: Ticker) => {
        const portrait = nextApp.screen.height > nextApp.screen.width * 1.15;
        const fitScale = Math.min(nextApp.screen.width / WORLD_WIDTH, nextApp.screen.height / WORLD_HEIGHT);
        const scale = portrait
          ? Math.min(nextApp.screen.width / 760, nextApp.screen.height / WORLD_HEIGHT)
          : fitScale;
        world.scale.set(scale);

        const serverNow = Date.now() + clockOffset.current;
        const desiredInterpolationDelay = targetInterpolationDelay(latency.current);
        const interpolationEase = 1 - Math.exp(-_ticker.deltaMS / 450);
        interpolationDelayMs = lerp(interpolationDelayMs, desiredInterpolationDelay, interpolationEase);
        const frame = sampleSnapshots(snapshots.current, serverNow - interpolationDelayMs);
        const centeredX = Math.round((nextApp.screen.width - WORLD_WIDTH * scale) / 2);
        const centeredY = Math.round((nextApp.screen.height - WORLD_HEIGHT * scale) / 2);
        if (!frame) {
          world.position.set(centeredX, centeredY);
          return;
        }
        const shouldReduceFrameRate = frame.phase === "complete" || frame.phase === "failed" || frame.phase === "paused";
        if (shouldReduceFrameRate !== reducedFrameRate) {
          reducedFrameRate = shouldReduceFrameRate;
          nextApp.ticker.maxFPS = reducedFrameRate ? 15 : 60;
        }
        targetLabel.alpha = 0.7 + Math.sin(serverNow * 0.006) * 0.12;
        const targetPulse = 1 + frame.deliveryProgress * 0.08;
        targetLabel.scale.set(targetPulse);

        const lookAheadX = frame.couch.x + frame.couch.vx * 22;
        const desiredX = portrait
          ? Math.max(nextApp.screen.width - WORLD_WIDTH * scale, Math.min(0, nextApp.screen.width / 2 - lookAheadX * scale))
          : centeredX;
        const desiredY = centeredY;
        if (!cameraReady) {
          cameraX = desiredX;
          cameraY = desiredY;
          cameraReady = true;
        } else {
          const cameraEase = 1 - Math.exp(-_ticker.deltaMS / 150);
          cameraX = lerp(cameraX, desiredX, cameraEase);
          cameraY = lerp(cameraY, desiredY, cameraEase);
        }

        for (const event of frame.events) {
          if (event.id <= lastShakeEventId) continue;
          lastShakeEventId = event.id;
          shakeStartedAt = performance.now();
          shakeStrength = event.kind === "impact" ? Math.min(15, 4 + event.amount * 0.62) : event.kind === "break" ? 9 : 5;
        }
        const shakeAge = performance.now() - shakeStartedAt;
        const shakeFade = Math.max(0, 1 - shakeAge / 330);
        const shakeX = shakeFade > 0 ? Math.sin(shakeAge * 0.19) * shakeStrength * shakeFade : 0;
        const shakeY = shakeFade > 0 ? Math.cos(shakeAge * 0.23) * shakeStrength * 0.72 * shakeFade : 0;
        world.position.set(cameraX + shakeX, cameraY + shakeY);

        couchRoot.position.set(frame.couch.x, frame.couch.y);
        couchRoot.rotation = frame.couch.angle;
        const nextDamageStage = frame.couch.hp <= 35 ? 2 : frame.couch.hp <= 68 ? 1 : 0;
        if (couchPlayerCount !== frame.players.length || couchDamageStage !== nextDamageStage) {
          couchPlayerCount = frame.players.length;
          couchDamageStage = nextDamageStage;
          drawCouch(couchArt, couchPlayerCount, couchDamageStage);
        }

        const presentProps = new Set<string>();
        for (const item of frame.breakables) {
          if (item.broken) continue;
          presentProps.add(item.id);
          let visual = propVisuals.get(item.id);
          if (!visual) {
            visual = new Graphics();
            drawBreakable(visual, item.kind);
            propVisuals.set(item.id, visual);
            propLayer.addChild(visual);
          }
          visual.position.set(item.x, item.y);
          visual.rotation = item.angle;
        }
        for (const [id, visual] of propVisuals) {
          if (presentProps.has(id)) continue;
          visual.destroy();
          propVisuals.delete(id);
        }

        catArt.visible = frame.cat !== null;
        if (frame.cat) {
          catArt.position.set(frame.cat.x, frame.cat.y);
          catArt.rotation = frame.cat.angle;
          catArt.scale.y = 1 + Math.sin(serverNow * 0.012) * 0.06;
        }

        constraintLayer.clear();
        const handlePoints = getHandlePoints(frame.players.length);
        const cos = Math.cos(frame.couch.angle);
        const sin = Math.sin(frame.couch.angle);
        for (const player of frame.players) {
          if (!player.gripped || player.handleIndex === null) continue;
          const handle = handlePoints[player.handleIndex];
          if (!handle) continue;
          const handleX = frame.couch.x + handle.x * cos - handle.y * sin;
          const handleY = frame.couch.y + handle.x * sin + handle.y * cos;
          if (isRopeLevel(level)) drawRope(constraintLayer, player.x, player.y, handleX, handleY, level.ropeLength ?? 70);
          else drawSpring(constraintLayer, player.x, player.y, handleX, handleY);
        }

        const presentIds = new Set<string>();
        for (const player of frame.players) {
          presentIds.add(player.id);
          let visual = playerVisuals.get(player.id);
          if (!visual) {
            visual = makePlayerVisual(playerLayer);
            playerVisuals.set(player.id, visual);
          }
          const isLocal = player.id === localPlayerIdRef.current;
          const panicked = frame.couch.hp <= 35;
          const sideView = isRopeLevel(level);
          const speed = Math.hypot(player.vx, player.vy);
          const onLadder = sideView && canClimbLadder(level, player, player.gripped, 24);
          const climbing = onLadder && Math.abs(player.vy) > 0.16;
          const motionFrame = sideView && (climbing || speed > 0.35)
            ? Math.floor(serverNow / (climbing ? 135 : 185) + player.slot) % 2
            : 0;
          const styleKey = `${player.profile.color}:${player.profile.hat}:${player.gripped}:${player.connected}:${isLocal}:${panicked}:${sideView}:${climbing}:${motionFrame}`;
          if (styleKey !== visual.styleKey) {
            drawMover(visual.art, player, isLocal, panicked, sideView, climbing, motionFrame);
            visual.styleKey = styleKey;
          }
          visual.root.position.set(player.x, player.y);
          const idleWobble = speed < 0.25 ? Math.sin(serverNow * 0.004 + player.slot * 1.7) * 0.035 : 0;
          const panicWobble = panicked ? Math.sin(serverNow * 0.028 + player.slot) * 0.025 : 0;
          visual.root.rotation = climbing ? 0 : player.angle * 0.08 + idleWobble + panicWobble;
          visual.label.position.y = sideView ? 54 : 44;
          visual.bubble.position.y = sideView ? -82 : -72;
          visual.label.text = isLocal ? "YOU" : `MOVER ${player.slot + 1}`;
          visual.label.alpha = player.connected ? 0.85 : 0.42;

          const activeShout = player.shout && player.shout.expiresAt > serverNow ? player.shout : null;
          visual.bubble.visible = activeShout !== null;
          if (activeShout) {
            visual.bubble.rotation = -visual.root.rotation;
            visual.bubbleText.text = activeShout.phrase;
            const width = Math.max(84, visual.bubbleText.width + 28);
            visual.bubblePlate.clear();
            visual.bubblePlate.roundRect(-width / 2, -21, width, 42, 15).fill(0xfffbeb).stroke({ color: 0x2f2940, width: 4 });
            visual.bubblePlate.moveTo(-8, 20).lineTo(0, 31).lineTo(8, 20).fill(0xfffbeb).stroke({ color: 0x2f2940, width: 3 });
          }
        }

        for (const [id, visual] of playerVisuals) {
          if (!presentIds.has(id)) {
            visual.root.destroy({ children: true });
            playerVisuals.delete(id);
          }
        }

        for (const event of frame.events) {
          if (eventVisuals.has(event.id)) continue;
          const root = new Container();
          const plate = new Graphics();
          const isBreak = event.kind === "break";
          const text = new Text({
            text: event.text,
            style: {
              fill: isBreak ? 0xfff2a8 : 0xffffff,
              stroke: { color: 0x2f2940, width: 7 },
              fontFamily: "Arial, sans-serif",
              fontSize: isBreak ? 27 : 24,
              fontWeight: "900",
            },
          });
          text.anchor.set(0.5);
          plate.circle(0, 0, isBreak ? 33 : 26).fill({ color: isBreak ? 0xef5b4c : 0x2f2940, alpha: 0.38 });
          root.position.set(event.x, event.y - 28);
          root.addChild(plate, text);
          effectLayer.addChild(root);
          eventVisuals.set(event.id, { root, bornAt: event.at });
        }
        for (const [id, visual] of eventVisuals) {
          const age = serverNow - visual.bornAt;
          visual.root.y -= _ticker.deltaMS * 0.045;
          visual.root.alpha = Math.max(0, 1 - Math.max(0, age - 900) / 900);
          visual.root.scale.set(1 + Math.sin(Math.min(1, age / 120) * Math.PI) * 0.18);
          if (age <= 1_850) continue;
          visual.root.destroy({ children: true });
          eventVisuals.delete(id);
        }
      };

      nextApp.ticker.add(renderFrame);
    };

    void start();
    return () => {
      disposed = true;
      if (app) {
        app.destroy(true, { children: true, texture: true, textureSource: true });
      }
    };
  }, [clockOffset, latency, level, snapshots]);

  return <div className="game-canvas" ref={hostRef} />;
}
