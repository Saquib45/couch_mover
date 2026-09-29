#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import Matter from "matter-js";
import ts from "typescript";

const source = await readFile(new URL("../packages/shared/src/index.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const shared = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const { LEVELS, canClimbLadder, getHandlePoints } = shared;

const TICK_MS = 40;
const SUBSTEPS = 3;
const MOVER_FORCE = 0.00145;
const MOVER_MAX_SPEED = 5.4;
const MOVER_RADIUS = 24;
const ROPE_STIFFNESS = 0.00062;
const ROPE_DAMPING = 0.0022;
const ROPE_MAX_TENSION = 0.042;
const COUCH_WIDTH = 160;
const COUCH_HEIGHT = 88;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalAngle(value) {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function makeSimulation(level, playerCount) {
  const engine = Matter.Engine.create({ enableSleeping: false });
  engine.gravity.scale = 0;
  const couch = Matter.Bodies.rectangle(
    level.couchStart.x,
    level.couchStart.y,
    COUCH_WIDTH,
    COUCH_HEIGHT,
    {
      label: "couch",
      chamfer: { radius: 8 },
      friction: 0.48,
      frictionAir: 0.075,
      restitution: 0.08,
      density: 0.004,
      collisionFilter: { category: 0x0002, mask: 0xffffffff },
    },
  );
  Matter.Body.setAngle(couch, level.couchStart.angle);
  Matter.Body.setMass(couch, (4 + playerCount * 6) * level.couchMassScale);

  const walls = level.walls.map((wall) => Matter.Bodies.rectangle(
    wall.x,
    wall.y,
    wall.width,
    wall.height,
    {
      isStatic: true,
      label: `wall:${wall.id}`,
      friction: 0.65,
      restitution: 0.08,
    },
  ));
  const movers = level.moverSpawns.slice(0, playerCount).map((spawn, index) => {
    const mover = Matter.Bodies.circle(spawn.x, spawn.y, MOVER_RADIUS, {
      label: `mover:${index}`,
      friction: 0.1,
      frictionAir: 0.18,
      restitution: 0.12,
      density: 0.0025,
      collisionFilter: { category: 0x0004, mask: 0xfffffffd },
    });
    Matter.Body.setMass(mover, 2.4);
    return mover;
  });
  Matter.Composite.add(engine.world, [couch, ...walls, ...movers]);
  return { engine, couch, movers, handles: getHandlePoints(playerCount) };
}

function handleState(couch, localHandle) {
  const offset = Matter.Vector.rotate(localHandle, couch.angle);
  return {
    offset,
    point: Matter.Vector.add(couch.position, offset),
    velocity: {
      x: couch.velocity.x - offset.y * couch.angularVelocity,
      y: couch.velocity.y + offset.x * couch.angularVelocity,
    },
  };
}

function applyRope(simulation, level, mover, localHandle) {
  const state = handleState(simulation.couch, localHandle);
  const rope = Matter.Vector.sub(mover.position, state.point);
  const distance = Matter.Vector.magnitude(rope);
  if (distance <= level.ropeLength || distance < 0.001) return;
  const direction = Matter.Vector.mult(rope, 1 / distance);
  const separatingSpeed = Matter.Vector.dot(Matter.Vector.sub(mover.velocity, state.velocity), direction);
  const tension = clamp(
    (distance - level.ropeLength) * ROPE_STIFFNESS + separatingSpeed * ROPE_DAMPING,
    0,
    ROPE_MAX_TENSION,
  );
  if (tension <= 0) return;
  const force = Matter.Vector.mult(direction, tension);
  Matter.Body.applyForce(simulation.couch, state.point, force);
  Matter.Body.applyForce(mover, mover.position, Matter.Vector.neg(force));
}

function step(simulation, level, inputs, gripped = true) {
  for (let substep = 0; substep < SUBSTEPS; substep += 1) {
    for (let index = 0; index < simulation.movers.length; index += 1) {
      const mover = simulation.movers[index];
      const input = inputs[index] ?? { x: 0, y: 0 };
      const hasGrip = Array.isArray(gripped) ? Boolean(gripped[index]) : gripped;
      const moveY = canClimbLadder(level, mover.position, hasGrip, MOVER_RADIUS) ? input.y : 0;
      Matter.Body.applyForce(mover, mover.position, {
        x: input.x * MOVER_FORCE * SUBSTEPS * level.moverForceScale * mover.mass,
        y: moveY * MOVER_FORCE * SUBSTEPS * level.moverForceScale * mover.mass,
      });
      Matter.Body.applyForce(mover, mover.position, {
        x: 0,
        y: level.ladderGravity * SUBSTEPS * mover.mass,
      });
      if (hasGrip) applyRope(simulation, level, mover, simulation.handles[index]);
    }
    Matter.Body.applyForce(simulation.couch, simulation.couch.position, {
      x: level.slopeForce.x * SUBSTEPS * simulation.couch.mass,
      y: level.slopeForce.y * SUBSTEPS * simulation.couch.mass,
    });
    Matter.Engine.update(simulation.engine, TICK_MS / SUBSTEPS);
  }
  for (const mover of simulation.movers) {
    const speed = Matter.Vector.magnitude(mover.velocity);
    if (speed > MOVER_MAX_SPEED) {
      Matter.Body.setVelocity(mover, Matter.Vector.mult(mover.velocity, MOVER_MAX_SPEED / speed));
    }
  }
}

function controllerInputs(simulation, level, waypoint) {
  const positionError = Matter.Vector.sub(waypoint, simulation.couch.position);
  const direction = waypoint.mode === "climb"
    ? Matter.Vector.normalise(positionError)
    : waypoint.mode === "transfer"
      ? Matter.Vector.normalise({ x: Math.sign(positionError.x), y: waypoint.lift ? -0.55 : 0 })
      : { x: Math.sign(positionError.x), y: 0 };
  const angleError = normalAngle(waypoint.angle - simulation.couch.angle);

  return simulation.movers.map((mover, index) => {
    const state = handleState(simulation.couch, simulation.handles[index]);
    const radius = Math.max(1, Matter.Vector.magnitude(state.offset));
    const clockwiseTangent = { x: state.offset.y / radius, y: -state.offset.x / radius };
    let pull = Matter.Vector.add(
      direction,
      Matter.Vector.mult(clockwiseTangent, clamp(-angleError * 3.2, -2.2, 2.2)),
    );
    if (waypoint.mode === "climb" || waypoint.lift) {
      // Keep each mover above its own handle so all four remain inside the shaft.
      pull = Matter.Vector.add(pull, { x: 0, y: -0.35 });
    }
    const pullLength = Matter.Vector.magnitude(pull);
    const pullDirection = pullLength > 0.001 ? Matter.Vector.mult(pull, 1 / pullLength) : { x: 0, y: 0 };
    const desired = Matter.Vector.add(
      state.point,
      Matter.Vector.mult(pullDirection, level.ropeLength + 38),
    );
    const moverError = Matter.Vector.sub(desired, mover.position);
    const controlled = Matter.Vector.sub(moverError, Matter.Vector.mult(mover.velocity, 7));
    const controlledLength = Matter.Vector.magnitude(controlled);
    return controlledLength > 1 ? Matter.Vector.mult(controlled, 1 / controlledLength) : { x: 0, y: 0 };
  });
}

function waypointReached(simulation, waypoint) {
  const xTolerance = waypoint.mode === "climb" ? 19 : 24;
  const yTolerance = waypoint.mode === "climb" ? 7 : waypoint.mode === "transfer" ? 24 : 34;
  return Math.abs(simulation.couch.position.x - waypoint.x) <= xTolerance &&
    Math.abs(simulation.couch.position.y - waypoint.y) <= yTolerance &&
    Math.abs(normalAngle(simulation.couch.angle - waypoint.angle)) <= 0.24;
}

function targetContains(level, couch) {
  const target = level.target;
  const left = target.x - target.width / 2;
  const right = target.x + target.width / 2;
  const top = target.y - target.height / 2;
  const bottom = target.y + target.height / 2;
  const inside = couch.vertices.every((vertex) => (
    vertex.x >= left && vertex.x <= right && vertex.y >= top && vertex.y <= bottom
  ));
  if (!inside || target.requiredAngle === undefined) return inside;
  const rawDifference = Math.abs(couch.angle - target.requiredAngle) % Math.PI;
  return Math.min(rawDifference, Math.PI - rawDifference) <= (target.angleTolerance ?? 0.25);
}

const paths = {
  "attic-ladder": [
    { x: 640, y: 580, angle: 0, mode: "floor" },
    { x: 640, y: 220, angle: 0, mode: "climb" },
    { x: 875, y: 299, angle: 0, mode: "transfer" },
    { x: 1040, y: 299, angle: 0, mode: "floor" },
  ],
  "fire-escape-finale": [
    { x: 920, y: 580, angle: 0, mode: "floor" },
    { x: 920, y: 380, angle: 0, mode: "climb" },
    { x: 700, y: 414, angle: 0, mode: "transfer" },
    { x: 350, y: 414, angle: 0, mode: "floor" },
    { x: 350, y: 170, angle: 0, mode: "climb" },
    { x: 560, y: 224, angle: 0, mode: "transfer" },
    { x: 1065, y: 224, angle: 0, mode: "floor" },
  ],
  "h-ladder-heist": [
    { x: 330, y: 580, angle: 0, mode: "floor" },
    { x: 330, y: 380, angle: 0, mode: "climb" },
    { x: 600, y: 409, angle: 0, mode: "transfer" },
    { x: 950, y: 409, angle: 0, mode: "floor" },
    { x: 950, y: 170, angle: 0, mode: "climb" },
    { x: 690, y: 214, angle: 0, mode: "transfer" },
    { x: 190, y: 214, angle: 0, mode: "floor" },
  ],
};

console.log("COUCH MOVERS vertical-ladder physics audit");
for (const level of LEVELS.filter((candidate) => candidate.mechanic === "rope-climb")) {
  const shaftIds = new Set(level.ladders?.map((ladder) => ladder.shaftId));
  assert(shaftIds.size === level.floorCount - 1, `${level.title}: floors and paired ladder shafts do not match`);
  for (let floor = 1; floor < level.floorCount; floor += 1) {
    const lanes = level.ladders.filter((ladder) => ladder.fromFloor === floor && ladder.toFloor === floor + 1);
    assert(lanes.length === 2, `${level.title}: floor ${floor} needs two ladder lanes`);
  }
  for (const ladder of level.ladders) {
    assert(canClimbLadder(level, { x: ladder.x, y: ladder.y }, true), `${level.title}: gripped mover cannot enter ${ladder.id}`);
    assert(!canClimbLadder(level, { x: ladder.x, y: ladder.y }, false), `${level.title}: ungripped mover can climb ${ladder.id}`);
    assert(
      !canClimbLadder(level, { x: ladder.x + ladder.width / 2 + 1, y: ladder.y }, true),
      `${level.title}: climb input leaks outside ${ladder.id}`,
    );
  }

  for (const playerCount of [2, 4]) {
    const simulation = makeSimulation(level, playerCount);
    const waypoints = paths[level.id];
    assert(waypoints, `${level.title}: no automated floor route`);
    let waypointIndex = 0;
    let holdTicks = 0;
    let completed = false;
    for (let tick = 0; tick < 4_500; tick += 1) {
      const waypoint = waypoints[Math.min(waypointIndex, waypoints.length - 1)];
      step(simulation, level, controllerInputs(simulation, level, waypoint));
      if (waypointReached(simulation, waypoint) && waypointIndex < waypoints.length - 1) {
        if (process.env.DEBUG_LADDER) {
          console.log(`    reached leg ${waypointIndex + 1}: couch ${simulation.couch.position.x.toFixed(1)},${simulation.couch.position.y.toFixed(1)} movers ${simulation.movers.map((mover) => `${mover.position.x.toFixed(0)},${mover.position.y.toFixed(0)}`).join(" | ")}`);
        }
        waypointIndex += 1;
      }
      holdTicks = targetContains(level, simulation.couch) ? holdTicks + 1 : 0;
      if (holdTicks >= 50) {
        completed = true;
        break;
      }
    }
    assert(
      completed,
      `${level.title}: ${playerCount}-player crew stalled at leg ${waypointIndex + 1}/${waypoints.length}` +
        ` couch(${simulation.couch.position.x.toFixed(1)},${simulation.couch.position.y.toFixed(1)},${simulation.couch.angle.toFixed(2)})` +
        ` movers ${simulation.movers.map((mover) => `${mover.position.x.toFixed(0)},${mover.position.y.toFixed(0)}`).join(" | ")}`,
    );

    const drop = makeSimulation(level, playerCount);
    const firstLadder = level.ladders[0];
    const firstShaft = level.ladders.filter((ladder) => ladder.shaftId === firstLadder.shaftId);
    const shaftCenterX = firstShaft.reduce((sum, ladder) => sum + ladder.x, 0) / firstShaft.length;
    Matter.Body.setPosition(drop.couch, {
      x: shaftCenterX,
      y: firstLadder.y - firstLadder.height * 0.25,
    });
    Matter.Body.setVelocity(drop.couch, { x: 0, y: 0 });
    const beforeDrop = drop.couch.position.y;
    for (let tick = 0; tick < 90; tick += 1) {
      step(drop, level, drop.movers.map(() => ({ x: 0, y: -1 })), false);
    }
    const dropDistance = drop.couch.position.y - beforeDrop;
    assert(dropDistance > 45, `${level.title}: released ${playerCount}-player couch did not fall through the ladder opening`);
    assert(
      drop.movers.every((mover, index) => mover.position.y >= level.moverSpawns[index].y - 8),
      `${level.title}: an ungripped mover climbed from vertical input alone`,
    );
    console.log(`  PASS ${level.number}/${LEVELS.length} ${level.title} | ${playerCount} players | released drop ${dropDistance.toFixed(1)}u`);
  }
}

console.log("LADDER PHYSICS AUDIT PASS: 2/4-player crews reach every floor; ungripped movers cannot climb");
