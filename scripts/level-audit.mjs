#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import ts from "typescript";

const source = await readFile(new URL("../packages/shared/src/index.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const shared = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const { LEVELS, WORLD_WIDTH, WORLD_HEIGHT, getHandlePoints } = shared;

const COUCH_WIDTH = 160;
const COUCH_HEIGHT = 88;
const MOVER_RADIUS = 24;
const SPAWN_PROP_CLEARANCE = 8;
const LADDER_LANDING_CLEARANCE = 10;
const CELL = 10;
const EXPECTED_LEVEL_COUNT = 12;
const EXPECTED_ROPE_LEVEL_COUNT = 3;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function overlapsWall(x, y, orientation, wall) {
  const width = orientation === 0 ? COUCH_WIDTH : COUCH_HEIGHT;
  const height = orientation === 0 ? COUCH_HEIGHT : COUCH_WIDTH;
  return Math.abs(x - wall.x) * 2 < width + wall.width - 0.01 &&
    Math.abs(y - wall.y) * 2 < height + wall.height - 0.01;
}

function validPose(level, x, y, orientation, avoidBreakables = false) {
  const width = orientation === 0 ? COUCH_WIDTH : COUCH_HEIGHT;
  const height = orientation === 0 ? COUCH_HEIGHT : COUCH_WIDTH;
  if (x - width / 2 < 0 || x + width / 2 > WORLD_WIDTH || y - height / 2 < 0 || y + height / 2 > WORLD_HEIGHT) return false;
  if (!level.walls.every((wall) => !overlapsWall(x, y, orientation, wall))) return false;
  return !avoidBreakables || level.breakables.every((item) => !overlapsWall(x, y, orientation, item));
}

function circleTouchesRect(point, radius, rect) {
  const closestX = Math.max(rect.x - rect.width / 2, Math.min(point.x, rect.x + rect.width / 2));
  const closestY = Math.max(rect.y - rect.height / 2, Math.min(point.y, rect.y + rect.height / 2));
  return Math.hypot(point.x - closestX, point.y - closestY) < radius;
}

function circleTouchesCouch(point, level) {
  const dx = point.x - level.couchStart.x;
  const dy = point.y - level.couchStart.y;
  const cosine = Math.cos(-level.couchStart.angle);
  const sine = Math.sin(-level.couchStart.angle);
  return circleTouchesRect(
    { x: dx * cosine - dy * sine, y: dx * sine + dy * cosine },
    MOVER_RADIUS,
    { x: 0, y: 0, width: COUCH_WIDTH, height: COUCH_HEIGHT },
  );
}

function moverStarts(level, playerCount) {
  const handles = getHandlePoints(playerCount);
  return handles.map((handle, index) => {
    const configured = level.moverSpawns[index] ?? level.moverSpawns[0];
    if (level.mechanic === "rope-climb" || playerCount <= 2) return configured;
    const length = Math.hypot(handle.x, handle.y) || 1;
    const local = {
      x: handle.x + handle.x / length * 42,
      y: handle.y + handle.y / length * 42,
    };
    const cosine = Math.cos(level.couchStart.angle);
    const sine = Math.sin(level.couchStart.angle);
    return {
      x: level.couchStart.x + local.x * cosine - local.y * sine,
      y: level.couchStart.y + local.x * sine + local.y * cosine,
    };
  });
}

function targetContains(level, x, y, orientation) {
  const width = orientation === 0 ? COUCH_WIDTH : COUCH_HEIGHT;
  const height = orientation === 0 ? COUCH_HEIGHT : COUCH_WIDTH;
  const target = level.target;
  if (Math.abs(x - target.x) * 2 + width > target.width + 0.01) return false;
  if (Math.abs(y - target.y) * 2 + height > target.height + 0.01) return false;
  if (target.requiredAngle === undefined) return true;
  const requiredOrientation = Math.abs(Math.sin(target.requiredAngle)) > 0.5 ? 1 : 0;
  return orientation === requiredOrientation;
}

function circleTouchesWall(point, radius, wall) {
  const closestX = Math.max(wall.x - wall.width / 2, Math.min(point.x, wall.x + wall.width / 2));
  const closestY = Math.max(wall.y - wall.height / 2, Math.min(point.y, wall.y + wall.height / 2));
  return Math.hypot(point.x - closestX, point.y - closestY) < radius;
}

function gridKey(ix, iy, orientation) {
  return `${ix}:${iy}:${orientation}`;
}

function findRoute(level, avoidBreakables = false) {
  const startOrientation = Math.abs(Math.sin(level.couchStart.angle)) > 0.5 ? 1 : 0;
  const start = {
    ix: Math.round(level.couchStart.x / CELL),
    iy: Math.round(level.couchStart.y / CELL),
    orientation: startOrientation,
  };
  if (!validPose(level, start.ix * CELL, start.iy * CELL, start.orientation, avoidBreakables)) return null;
  const queue = [{ ...start, distance: 0 }];
  const visited = new Set([gridKey(start.ix, start.iy, start.orientation)]);
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor++];
    const x = current.ix * CELL;
    const y = current.iy * CELL;
    if (targetContains(level, x, y, current.orientation)) return current.distance;
    const candidates = [
      [current.ix + 1, current.iy, current.orientation],
      [current.ix - 1, current.iy, current.orientation],
      [current.ix, current.iy + 1, current.orientation],
      [current.ix, current.iy - 1, current.orientation],
      [current.ix, current.iy, current.orientation === 0 ? 1 : 0],
    ];
    for (const [ix, iy, orientation] of candidates) {
      const key = gridKey(ix, iy, orientation);
      if (visited.has(key)) continue;
      if (!validPose(level, ix * CELL, iy * CELL, orientation, avoidBreakables)) continue;
      visited.add(key);
      queue.push({ ix, iy, orientation, distance: current.distance + 1 });
    }
  }
  return null;
}

assert(LEVELS.length === EXPECTED_LEVEL_COUNT, `expected ${EXPECTED_LEVEL_COUNT} levels, found ${LEVELS.length}`);
assert(new Set(LEVELS.map((level) => level.id)).size === LEVELS.length, "level ids must be unique");
assert(LEVELS.every((level, index) => level.number === index + 1), "level numbers must be sequential");

const ropeLevels = LEVELS.filter((level) => level.mechanic === "rope-climb");
assert(
  ropeLevels.length === EXPECTED_ROPE_LEVEL_COUNT,
  `expected ${EXPECTED_ROPE_LEVEL_COUNT} rope-climb levels, found ${ropeLevels.length}`,
);
assert(
  ropeLevels.every((level) => level.number >= 6),
  "rope-climb levels must stay in the late campaign",
);

console.log("COUCH MOVERS level audit");
const cleanRouteFailures = [];
for (const level of LEVELS) {
  const startOrientation = Math.abs(Math.sin(level.couchStart.angle)) > 0.5 ? 1 : 0;
  assert(validPose(level, level.couchStart.x, level.couchStart.y, startOrientation), `${level.title}: couch starts inside a wall`);
  assert(validPose(level, level.couchStart.x, level.couchStart.y, startOrientation, true), `${level.title}: couch starts against a breakable`);
  assert(level.target.width >= COUCH_HEIGHT && level.target.height >= COUCH_HEIGHT, `${level.title}: target is smaller than the couch in both orientations`);
  assert(level.moverSpawns.length >= 4, `${level.title}: fewer than four mover spawn points`);
  assert(new Set(level.breakables.map((item) => item.id)).size === level.breakables.length, `${level.title}: duplicate breakable id`);
  for (const item of level.breakables) {
    assert(item.x > 0 && item.x < WORLD_WIDTH && item.y > 0 && item.y < WORLD_HEIGHT, `${level.title}: ${item.id} is outside the world`);
  }
  for (let playerCount = 2; playerCount <= 4; playerCount += 1) {
    const starts = moverStarts(level, playerCount);
    assert(starts.length === playerCount && starts.every(Boolean), `${level.title}: missing a ${playerCount}-player mover start`);
    starts.forEach((start, index) => {
      assert(
        start.x >= MOVER_RADIUS && start.x <= WORLD_WIDTH - MOVER_RADIUS &&
          start.y >= MOVER_RADIUS && start.y <= WORLD_HEIGHT - MOVER_RADIUS,
        `${level.title}: ${playerCount}P mover ${index + 1} starts outside the world`,
      );
      const wall = level.walls.find((candidate) => circleTouchesRect(start, MOVER_RADIUS, candidate));
      assert(!wall, `${level.title}: ${playerCount}P mover ${index + 1} starts against wall ${wall?.id}`);
      const prop = level.breakables.find((candidate) => circleTouchesRect(start, MOVER_RADIUS + SPAWN_PROP_CLEARANCE, candidate));
      assert(!prop, `${level.title}: ${playerCount}P mover ${index + 1} starts against ${prop?.id}`);
      assert(!circleTouchesCouch(start, level), `${level.title}: ${playerCount}P mover ${index + 1} starts inside the couch`);
      for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
        const other = starts[otherIndex];
        assert(
          Math.hypot(start.x - other.x, start.y - other.y) >= MOVER_RADIUS * 2,
          `${level.title}: ${playerCount}P movers ${otherIndex + 1}/${index + 1} overlap at spawn`,
        );
      }
    });
  }
  if (level.cat) {
    assert(level.cat.path.length >= 2, `${level.title}: cat needs at least two patrol points`);
    assert(level.cat.path.every((point) => point.x > 0 && point.x < WORLD_WIDTH && point.y > 0 && point.y < WORLD_HEIGHT), `${level.title}: cat path leaves the world`);
    for (let index = 0; index < level.cat.path.length; index += 1) {
      const from = level.cat.path[index];
      const to = level.cat.path[(index + 1) % level.cat.path.length];
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      const samples = Math.max(1, Math.ceil(distance / 8));
      for (let sample = 0; sample <= samples; sample += 1) {
        const amount = sample / samples;
        const point = { x: from.x + (to.x - from.x) * amount, y: from.y + (to.y - from.y) * amount };
        assert(level.walls.every((wall) => !circleTouchesWall(point, level.cat.radius, wall)), `${level.title}: cat patrol intersects ${level.walls.find((wall) => circleTouchesWall(point, level.cat.radius, wall))?.id ?? "a wall"}`);
        const prop = level.breakables.find((item) => circleTouchesRect(point, level.cat.radius, item));
        assert(!prop, `${level.title}: cat patrol runs through ${prop?.id}`);
      }
    }
  }
  if (level.mechanic === "rope-climb") {
    assert(Number.isFinite(level.ropeLength) && level.ropeLength > 0, `${level.title}: ropeLength must be a positive number`);
    assert(
      Number.isFinite(level.slopeForce?.x) && Number.isFinite(level.slopeForce?.y),
      `${level.title}: slopeForce must contain finite x/y components`,
    );
    const slopeMagnitude = Math.hypot(level.slopeForce.x, level.slopeForce.y);
    assert(slopeMagnitude > 0, `${level.title}: slopeForce must make an unattended couch slide back`);
    const climbDirection = {
      x: level.target.x - level.couchStart.x,
      y: level.target.y - level.couchStart.y,
    };
    const slopeAlongClimb = level.slopeForce.x * climbDirection.x + level.slopeForce.y * climbDirection.y;
    assert(slopeAlongClimb < 0, `${level.title}: slopeForce does not oppose the climb toward the target`);
    assert(level.floorCount === 2 || level.floorCount === 3, `${level.title}: ladder job needs a 2- or 3-floor count`);
    const ladderShafts = new Map();
    for (const ladder of level.ladders ?? []) {
      const lanes = ladderShafts.get(ladder.shaftId) ?? [];
      lanes.push(ladder);
      ladderShafts.set(ladder.shaftId, lanes);
    }
    assert(ladderShafts.size === level.floorCount - 1, `${level.title}: needs one paired shaft between each floor`);
    assert(Number.isFinite(level.ladderGravity) && level.ladderGravity > 0, `${level.title}: ladderGravity must be positive`);
    assert(new Set(level.ladders.map((ladder) => ladder.id)).size === level.ladders.length, `${level.title}: duplicate ladder id`);
    for (let floor = 1; floor < level.floorCount; floor += 1) {
      const lanes = level.ladders.filter((ladder) => ladder.fromFloor === floor && ladder.toFloor === floor + 1);
      assert(lanes.length === 2, `${level.title}: floor ${floor} needs two player ladders`);
      assert(new Set(lanes.map((ladder) => ladder.lane)).size === 2, `${level.title}: floor ${floor} is missing a left/right ladder lane`);
      assert(new Set(lanes.map((ladder) => ladder.shaftId)).size === 1, `${level.title}: paired ladders must share a shaft`);
    }
    for (const ladder of level.ladders) {
      assert(ladder.height > ladder.width, `${level.title}: ${ladder.id} is not visibly vertical`);
      assert(
        ladder.x - ladder.width / 2 > 0 && ladder.x + ladder.width / 2 < WORLD_WIDTH &&
          ladder.y - ladder.height / 2 > 0 && ladder.y + ladder.height / 2 < WORLD_HEIGHT,
        `${level.title}: ${ladder.id} leaves the world`,
      );
      const ladderTop = ladder.y - ladder.height / 2;
      const ladderBottom = ladder.y + ladder.height / 2;
      const crossedFloorYs = [...new Set(level.walls
        .filter((wall) => /^floor-\d-(left|right)$/.test(wall.id) && wall.y > ladderTop + 5 && wall.y < ladderBottom - 5)
        .map((wall) => wall.y))];
      assert(crossedFloorYs.length >= 1, `${level.title}: ${ladder.id} does not cross a floor opening`);
      for (const floorY of crossedFloorYs) {
        const blocksOpening = level.walls.some((wall) =>
          /^floor-\d-(left|right)$/.test(wall.id) && wall.y === floorY &&
          Math.abs(ladder.x - wall.x) < wall.width / 2,
        );
        assert(!blocksOpening, `${level.title}: ${ladder.id} is blocked at floor y=${floorY}`);
        for (const landingY of [floorY - MOVER_RADIUS - 4, floorY + MOVER_RADIUS + 4]) {
          const prop = level.breakables.find((candidate) => circleTouchesRect(
            { x: ladder.x, y: landingY },
            MOVER_RADIUS + LADDER_LANDING_CLEARANCE,
            candidate,
          ));
          assert(!prop, `${level.title}: ${ladder.id} landing is blocked by ${prop?.id}`);
        }
      }
    }
  }
  const routeSteps = findRoute(level);
  assert(routeSteps !== null, `${level.title}: no collision-free center route reaches the target`);
  const cleanRouteSteps = findRoute(level, true);
  if (cleanRouteSteps === null) cleanRouteFailures.push(level.title);
  const handles = getHandlePoints(4);
  assert(handles.length === 4, `${level.title}: four-player handle layout is missing a corner`);
  console.log(
    `  ${cleanRouteSteps === null ? "FAIL" : "PASS"} ${level.number}/${EXPECTED_LEVEL_COUNT} ${level.title.padEnd(24)} route ${String(routeSteps).padStart(3)} / clean ${String(cleanRouteSteps ?? "BLOCKED").padStart(3)} steps` +
      ` | ${level.breakables.length} breakables${level.cat ? " | cat" : ""}${level.mechanic === "rope-climb" ? " | rope climb" : ""}`,
  );
}

assert(cleanRouteFailures.length === 0, `forced breakable routes: ${cleanRouteFailures.join(", ")}`);

console.log(
  `LEVEL AUDIT PASS: ${EXPECTED_LEVEL_COUNT} distinct, reachable stages (${EXPECTED_ROPE_LEVEL_COUNT} rope climbs)`,
);
