export const WORLD_WIDTH = 1280;
export const WORLD_HEIGHT = 720;
export const SERVER_TICK_RATE = 25;
export const SERVER_TICK_MS = 1000 / SERVER_TICK_RATE;
export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;
export const ROOM_CODE_LENGTH = 6;
export const DELIVERY_HOLD_MS = 2_000;
export const COUCH_MAX_HP = 100;

export const MOVER_COLORS = [
  { id: "tomato", name: "Tomato", hex: "#ef5b4c", dark: "#9f2f2b" },
  { id: "sunny", name: "Sunny", hex: "#f6c445", dark: "#9a6811" },
  { id: "mint", name: "Mint", hex: "#45c99a", dark: "#197658" },
  { id: "sky", name: "Sky", hex: "#4a9ee8", dark: "#235e9e" },
] as const;

export const MOVER_HATS = [
  { id: "cap", name: "Moving Cap", glyph: "🧢" },
  { id: "hardhat", name: "Hard Hat", glyph: "⛑️" },
  { id: "cowboy", name: "Cowboy", glyph: "🤠" },
  { id: "crown", name: "Management", glyph: "👑" },
] as const;

export const SHOUTS = ["LEFT!", "PIVOT!", "STOP!", "MY BAD"] as const;

export type MoverColorId = (typeof MOVER_COLORS)[number]["id"];
export type MoverHatId = (typeof MOVER_HATS)[number]["id"];
export type ShoutPhrase = (typeof SHOUTS)[number];
export type RoomPhase = "lobby" | "countdown" | "playing" | "paused" | "complete" | "failed";
export type LevelTheme = "hallway" | "corner" | "living-room" | "cat-chaos" | "balcony" | "attic-ladder" | "fire-escape" | "office" | "ladder-maze";
export type LevelMechanic = "carry" | "rope-climb";
export type BreakableKind = "vase" | "lamp" | "tv" | "fishbowl";

export interface Vec2 {
  x: number;
  y: number;
}

export interface RectDefinition extends Vec2 {
  width: number;
  height: number;
}

export interface TargetDefinition extends RectDefinition {
  requiredAngle?: number;
  angleTolerance?: number;
}

export interface BreakableDefinition extends RectDefinition {
  id: string;
  kind: BreakableKind;
  value: number;
}

export interface LadderDefinition extends RectDefinition {
  id: string;
  shaftId: string;
  lane: "left" | "right";
  fromFloor: number;
  toFloor: number;
}

export interface CatDefinition {
  start: Vec2;
  path: Vec2[];
  speed: number;
  radius: number;
}

export interface LevelDefinition {
  id: string;
  number: number;
  title: string;
  subtitle: string;
  theme: LevelTheme;
  mechanic: LevelMechanic;
  parTimeMs: number;
  baseScore: number;
  starThresholds: readonly [number, number, number];
  couchMassScale: number;
  moverForceScale: number;
  couchStart: Vec2 & { angle: number };
  moverSpawns: Vec2[];
  target: TargetDefinition;
  walls: Array<RectDefinition & { id: string }>;
  breakables: BreakableDefinition[];
  /** Resting rope length in world units. Only used by rope-climb jobs. */
  ropeLength?: number;
  /** Constant downhill acceleration applied to the couch by the server. */
  slopeForce?: Vec2;
  /** Side-view climb zones. Up/down input only works here while the player's rope is gripped. */
  ladders?: LadderDefinition[];
  /** Downward acceleration applied to movers and loose props in side-view ladder jobs. */
  ladderGravity?: number;
  /** Human-readable floor count for ladder-job presentation and validation. */
  floorCount?: 2 | 3;
  cat?: CatDefinition;
}

const OUTER_WALLS: Array<RectDefinition & { id: string }> = [
  { id: "north", x: 640, y: 72, width: 1200, height: 42 },
  { id: "south", x: 640, y: 648, width: 1200, height: 42 },
  { id: "west", x: 40, y: 360, width: 42, height: 618 },
  { id: "east", x: 1240, y: 360, width: 42, height: 618 },
];

export const LEVELS: readonly LevelDefinition[] = [
  {
    id: "tutorial-hallway",
    number: 1,
    title: "THE EASY JOB",
    subtitle: "One hallway. One couch. What could go wrong?",
    theme: "hallway",
    mechanic: "carry",
    parTimeMs: 32_000,
    baseScore: 3_000,
    starThresholds: [1_600, 2_800, 3_900],
    couchMassScale: 1,
    moverForceScale: 1,
    couchStart: { x: 220, y: 360, angle: 0 },
    moverSpawns: [
      { x: 108, y: 360 },
      { x: 332, y: 360 },
      { x: 220, y: 270 },
      { x: 220, y: 450 },
    ],
    target: { x: 1060, y: 360, width: 250, height: 180 },
    walls: [
      ...OUTER_WALLS,
      { id: "door-top", x: 655, y: 188, width: 34, height: 232 },
      { id: "door-bottom", x: 655, y: 532, width: 34, height: 232 },
    ],
    breakables: [
      { id: "welcome-vase", kind: "vase", x: 815, y: 180, width: 30, height: 30, value: 50 },
    ],
  },
  {
    id: "l-corner",
    number: 2,
    title: "THE L-CORNER",
    subtitle: "Straight is easy. Corners have opinions.",
    theme: "corner",
    mechanic: "carry",
    parTimeMs: 52_000,
    baseScore: 3_600,
    starThresholds: [1_700, 3_000, 4_500],
    couchMassScale: 1.04,
    moverForceScale: 1,
    couchStart: { x: 220, y: 525, angle: 0 },
    moverSpawns: [
      { x: 108, y: 525 },
      { x: 332, y: 525 },
      { x: 220, y: 452 },
      { x: 220, y: 598 },
    ],
    target: { x: 1110, y: 190, width: 178, height: 205, requiredAngle: Math.PI / 2, angleTolerance: 0.42 },
    walls: [
      ...OUTER_WALLS,
      { id: "inside-horizontal", x: 520, y: 397, width: 960, height: 44 },
      { id: "inside-vertical", x: 1000, y: 220, width: 44, height: 398 },
    ],
    breakables: [
      { id: "corner-lamp", kind: "lamp", x: 939, y: 555, width: 32, height: 32, value: 75 },
      { id: "corner-vase", kind: "vase", x: 1195, y: 335, width: 28, height: 28, value: 50 },
    ],
  },
  {
    id: "living-room-liability",
    number: 3,
    title: "LIVING ROOM LIABILITY",
    subtitle: "Everything in here is apparently priceless.",
    theme: "living-room",
    mechanic: "carry",
    parTimeMs: 58_000,
    baseScore: 4_100,
    starThresholds: [1_800, 3_300, 4_900],
    couchMassScale: 1.08,
    moverForceScale: 0.98,
    couchStart: { x: 194, y: 365, angle: 0 },
    moverSpawns: [
      { x: 86, y: 365 },
      { x: 298, y: 365 },
      { x: 190, y: 275 },
      { x: 190, y: 455 },
    ],
    target: { x: 1085, y: 365, width: 220, height: 180 },
    walls: [
      ...OUTER_WALLS,
      { id: "sofa-island", x: 575, y: 253, width: 210, height: 70 },
      { id: "coffee-table", x: 730, y: 490, width: 225, height: 58 },
      { id: "bookcase", x: 930, y: 190, width: 54, height: 185 },
    ],
    breakables: [
      { id: "vase-a", kind: "vase", x: 430, y: 195, width: 28, height: 28, value: 50 },
      { id: "lamp-a", kind: "lamp", x: 530, y: 500, width: 34, height: 34, value: 75 },
      { id: "vase-b", kind: "vase", x: 688, y: 185, width: 28, height: 28, value: 50 },
      { id: "tv-a", kind: "tv", x: 830, y: 315, width: 74, height: 34, value: 300 },
      { id: "fish-a", kind: "fishbowl", x: 930, y: 545, width: 40, height: 40, value: 200 },
      { id: "lamp-b", kind: "lamp", x: 1055, y: 190, width: 34, height: 34, value: 75 },
    ],
  },
  {
    id: "cat-chaos",
    number: 4,
    title: "CAT CHAOS",
    subtitle: "The homeowner forgot to mention Mr. Pickles.",
    theme: "cat-chaos",
    mechanic: "carry",
    parTimeMs: 66_000,
    baseScore: 4_600,
    starThresholds: [1_900, 3_500, 5_300],
    couchMassScale: 1.1,
    moverForceScale: 0.98,
    couchStart: { x: 205, y: 535, angle: 0 },
    moverSpawns: [
      { x: 96, y: 535 },
      { x: 314, y: 535 },
      { x: 205, y: 452 },
      { x: 205, y: 610 },
    ],
    target: { x: 1085, y: 170, width: 225, height: 160 },
    walls: [
      ...OUTER_WALLS,
      { id: "lower-divider", x: 570, y: 430, width: 650, height: 44 },
      { id: "upper-divider", x: 840, y: 285, width: 710, height: 44 },
      { id: "cat-counter", x: 435, y: 125, width: 235, height: 50 },
    ],
    breakables: [
      { id: "cat-vase", kind: "vase", x: 390, y: 535, width: 28, height: 28, value: 50 },
      { id: "cat-lamp", kind: "lamp", x: 720, y: 600, width: 34, height: 34, value: 75 },
      { id: "cat-fish", kind: "fishbowl", x: 690, y: 120, width: 42, height: 42, value: 200 },
      { id: "cat-tv", kind: "tv", x: 1040, y: 565, width: 76, height: 36, value: 300 },
    ],
    cat: {
      start: { x: 560, y: 520 },
      path: [
        { x: 560, y: 520 },
        { x: 930, y: 520 },
        { x: 930, y: 350 },
        { x: 535, y: 350 },
        { x: 430, y: 350 },
        { x: 430, y: 225 },
        { x: 1040, y: 225 },
        { x: 430, y: 225 },
        { x: 430, y: 350 },
        { x: 930, y: 350 },
        { x: 930, y: 520 },
      ],
      speed: 2.2,
      radius: 27,
    },
  },
  {
    id: "balcony-boss",
    number: 5,
    title: "THE BALCONY BOSS",
    subtitle: "Measure never. Pivot forever.",
    theme: "balcony",
    mechanic: "carry",
    parTimeMs: 74_000,
    baseScore: 5_200,
    starThresholds: [2_000, 3_800, 5_900],
    couchMassScale: 1.14,
    moverForceScale: 0.96,
    couchStart: { x: 225, y: 440, angle: Math.PI / 2 },
    moverSpawns: [
      { x: 225, y: 335 },
      { x: 200, y: 545 },
      { x: 135, y: 500 },
      { x: 315, y: 500 },
    ],
    target: { x: 1080, y: 355, width: 220, height: 150, requiredAngle: 0, angleTolerance: 0.16 },
    walls: [
      ...OUTER_WALLS,
      { id: "approach-top", x: 505, y: 280, width: 560, height: 44 },
      { id: "approach-bottom", x: 505, y: 594, width: 560, height: 44 },
      { id: "balcony-door-top", x: 845, y: 191.5, width: 42, height: 199 },
      { id: "balcony-door-bottom", x: 845, y: 528.5, width: 42, height: 199 },
    ],
    breakables: [
      { id: "boss-vase-a", kind: "vase", x: 735, y: 510, width: 28, height: 28, value: 50 },
      { id: "boss-vase-b", kind: "vase", x: 940, y: 215, width: 28, height: 28, value: 50 },
      { id: "boss-lamp", kind: "lamp", x: 1000, y: 520, width: 34, height: 34, value: 75 },
    ],
  },
  {
    id: "attic-ladder",
    number: 6,
    title: "THE TWO-FLOOR HOIST",
    subtitle: "One ladder. Two floors. Keep every rope tight.",
    theme: "attic-ladder",
    mechanic: "rope-climb",
    parTimeMs: 88_000,
    baseScore: 5_800,
    starThresholds: [2_200, 4_200, 6_500],
    couchMassScale: 1.16,
    moverForceScale: 1.12,
    ropeLength: 70,
    slopeForce: { x: 0, y: 0.0001 },
    ladderGravity: 0.00032,
    floorCount: 2,
    ladders: [
      { id: "attic-ladder-left", shaftId: "attic-shaft", lane: "left", x: 560, y: 359, width: 110, height: 532, fromFloor: 1, toFloor: 2 },
      { id: "attic-ladder-right", shaftId: "attic-shaft", lane: "right", x: 720, y: 359, width: 110, height: 532, fromFloor: 1, toFloor: 2 },
    ],
    couchStart: { x: 220, y: 580, angle: 0 },
    moverSpawns: [
      { x: 115, y: 545 },
      { x: 325, y: 545 },
      { x: 325, y: 595 },
      { x: 115, y: 595 },
    ],
    target: { x: 1040, y: 299, width: 270, height: 130, requiredAngle: 0, angleTolerance: 0.35 },
    walls: [
      ...OUTER_WALLS,
      { id: "floor-2-left", x: 260.5, y: 360, width: 399, height: 34 },
      { id: "floor-2-right", x: 1019.5, y: 360, width: 399, height: 34 },
      { id: "floor-2-low-beam", x: 1100, y: 183, width: 150, height: 34 },
    ],
    breakables: [
      { id: "attic-tv", kind: "tv", x: 400, y: 570, width: 74, height: 34, value: 300 },
      { id: "attic-vase", kind: "vase", x: 1160, y: 600, width: 28, height: 28, value: 50 },
      { id: "attic-lamp", kind: "lamp", x: 500, y: 320, width: 34, height: 34, value: 75 },
      { id: "attic-fish", kind: "fishbowl", x: 1180, y: 315, width: 42, height: 42, value: 200 },
    ],
  },
  {
    id: "fire-escape-finale",
    number: 7,
    title: "THE THREE-FLOOR WALK-UP",
    subtitle: "No elevator. Two ladders. Several bad decisions.",
    theme: "fire-escape",
    mechanic: "rope-climb",
    parTimeMs: 118_000,
    baseScore: 6_400,
    starThresholds: [2_300, 4_600, 7_300],
    couchMassScale: 1.2,
    moverForceScale: 1.16,
    ropeLength: 50,
    slopeForce: { x: 0, y: 0.00004 },
    ladderGravity: 0.00034,
    floorCount: 3,
    ladders: [
      { id: "escape-ladder-1-left", shaftId: "escape-shaft-1", lane: "left", x: 840, y: 463.5, width: 100, height: 323, fromFloor: 1, toFloor: 2 },
      { id: "escape-ladder-1-right", shaftId: "escape-shaft-1", lane: "right", x: 1000, y: 463.5, width: 100, height: 323, fromFloor: 1, toFloor: 2 },
      { id: "escape-ladder-2-left", shaftId: "escape-shaft-2", lane: "left", x: 270, y: 284, width: 100, height: 382, fromFloor: 2, toFloor: 3 },
      { id: "escape-ladder-2-right", shaftId: "escape-shaft-2", lane: "right", x: 430, y: 284, width: 100, height: 382, fromFloor: 2, toFloor: 3 },
    ],
    couchStart: { x: 200, y: 580, angle: 0 },
    moverSpawns: [
      { x: 90, y: 545 },
      { x: 310, y: 545 },
      { x: 310, y: 595 },
      { x: 90, y: 595 },
    ],
    target: { x: 1065, y: 224, width: 285, height: 120, requiredAngle: 0, angleTolerance: 0.3 },
    walls: [
      ...OUTER_WALLS,
      { id: "floor-2-left", x: 405.5, y: 475, width: 689, height: 34 },
      { id: "floor-2-right", x: 1154.5, y: 475, width: 129, height: 34 },
      { id: "floor-3-left", x: 125.5, y: 285, width: 129, height: 34 },
      { id: "floor-3-right", x: 864.5, y: 285, width: 709, height: 34 },
      { id: "floor-2-low-beam", x: 650, y: 348, width: 170, height: 30 },
      { id: "floor-3-low-beam", x: 785, y: 150, width: 185, height: 32 },
    ],
    breakables: [
      { id: "escape-fish-low", kind: "fishbowl", x: 1185, y: 600, width: 42, height: 42, value: 200 },
      { id: "escape-tv-low", kind: "tv", x: 1120, y: 590, width: 74, height: 34, value: 300 },
      { id: "escape-lamp-mid", kind: "lamp", x: 1160, y: 435, width: 34, height: 34, value: 75 },
      { id: "escape-vase-mid", kind: "vase", x: 110, y: 440, width: 28, height: 28, value: 50 },
      { id: "escape-tv-high", kind: "tv", x: 125, y: 245, width: 74, height: 34, value: 300 },
      { id: "escape-fish-high", kind: "fishbowl", x: 1185, y: 240, width: 42, height: 42, value: 200 },
    ],
  },
  {
    id: "office-slalom",
    number: 8,
    title: "THE OFFICE SLALOM",
    subtitle: "Three cubicles. Two clean lines. One very expensive printer.",
    theme: "office",
    mechanic: "carry",
    parTimeMs: 104_000,
    baseScore: 6_900,
    starThresholds: [2_500, 4_900, 7_700],
    couchMassScale: 1.22,
    moverForceScale: 0.96,
    couchStart: { x: 194, y: 540, angle: 0 },
    moverSpawns: [
      { x: 86, y: 540 },
      { x: 302, y: 540 },
      { x: 180, y: 457 },
      { x: 180, y: 610 },
    ],
    target: { x: 1110, y: 180, width: 210, height: 210, requiredAngle: Math.PI / 2, angleTolerance: 0.28 },
    walls: [
      ...OUTER_WALLS,
      { id: "cubicle-wall-a", x: 430, y: 485, width: 44, height: 285 },
      { id: "cubicle-wall-b", x: 700, y: 235, width: 44, height: 285 },
      { id: "cubicle-wall-c", x: 970, y: 485, width: 44, height: 285 },
    ],
    breakables: [
      { id: "office-printer-a", kind: "tv", x: 430, y: 285, width: 74, height: 34, value: 300 },
      { id: "office-lamp-a", kind: "lamp", x: 700, y: 540, width: 34, height: 34, value: 75 },
      { id: "office-fish-a", kind: "fishbowl", x: 970, y: 150, width: 42, height: 42, value: 200 },
      { id: "office-vase-a", kind: "vase", x: 300, y: 390, width: 28, height: 28, value: 50 },
      { id: "office-printer-b", kind: "tv", x: 835, y: 520, width: 74, height: 34, value: 300 },
    ],
  },
  {
    id: "h-ladder-heist",
    number: 9,
    title: "THE H-LADDER HEIST",
    subtitle: "Two ladders per shaft. Only the top-left platform pays.",
    theme: "ladder-maze",
    mechanic: "rope-climb",
    parTimeMs: 142_000,
    baseScore: 7_600,
    starThresholds: [2_700, 5_400, 8_600],
    couchMassScale: 1.24,
    moverForceScale: 1.18,
    ropeLength: 50,
    slopeForce: { x: 0, y: 0.00004 },
    ladderGravity: 0.00036,
    floorCount: 3,
    ladders: [
      { id: "heist-ladder-1-left", shaftId: "heist-shaft-1", lane: "left", x: 250, y: 461, width: 100, height: 326, fromFloor: 1, toFloor: 2 },
      { id: "heist-ladder-1-right", shaftId: "heist-shaft-1", lane: "right", x: 410, y: 461, width: 100, height: 326, fromFloor: 1, toFloor: 2 },
      { id: "heist-ladder-2-left", shaftId: "heist-shaft-2", lane: "left", x: 870, y: 281.5, width: 100, height: 377, fromFloor: 2, toFloor: 3 },
      { id: "heist-ladder-2-right", shaftId: "heist-shaft-2", lane: "right", x: 1030, y: 281.5, width: 100, height: 377, fromFloor: 2, toFloor: 3 },
    ],
    couchStart: { x: 1050, y: 580, angle: 0 },
    moverSpawns: [
      { x: 945, y: 545 },
      { x: 1155, y: 545 },
      { x: 1155, y: 595 },
      { x: 945, y: 595 },
    ],
    target: { x: 190, y: 214, width: 260, height: 120, requiredAngle: 0, angleTolerance: 0.3 },
    walls: [
      ...OUTER_WALLS,
      { id: "floor-2-left", x: 125.5, y: 470, width: 129, height: 34 },
      { id: "floor-2-right", x: 844.5, y: 470, width: 749, height: 34 },
      { id: "floor-3-left", x: 435.5, y: 275, width: 749, height: 34 },
      { id: "floor-3-right", x: 1154.5, y: 275, width: 129, height: 34 },
      { id: "floor-2-low-beam", x: 700, y: 330, width: 180, height: 24 },
      { id: "floor-3-low-beam", x: 500, y: 143, width: 180, height: 30 },
    ],
    breakables: [
      { id: "heist-tv-low", kind: "tv", x: 1180, y: 380, width: 74, height: 34, value: 300 },
      { id: "heist-fish-low", kind: "fishbowl", x: 90, y: 600, width: 42, height: 42, value: 200 },
      { id: "heist-lamp-mid", kind: "lamp", x: 1160, y: 430, width: 34, height: 34, value: 75 },
      { id: "heist-vase-mid", kind: "vase", x: 105, y: 435, width: 28, height: 28, value: 50 },
      { id: "heist-tv-high", kind: "tv", x: 1175, y: 245, width: 74, height: 34, value: 300 },
      { id: "heist-fish-high", kind: "fishbowl", x: 1100, y: 235, width: 42, height: 42, value: 200 },
    ],
  },
  {
    id: "dinner-table-drift",
    number: 10,
    title: "DINNER TABLE DRIFT",
    subtitle: "The clean line is long. The shortcut is fully insured.",
    theme: "living-room",
    mechanic: "carry",
    parTimeMs: 112_000,
    baseScore: 8_100,
    starThresholds: [2_900, 5_800, 9_100],
    couchMassScale: 1.25,
    moverForceScale: 0.96,
    couchStart: { x: 220, y: 520, angle: 0 },
    moverSpawns: [
      { x: 110, y: 520 },
      { x: 330, y: 520 },
      { x: 220, y: 425 },
      { x: 220, y: 600 },
    ],
    target: { x: 1090, y: 195, width: 210, height: 190, requiredAngle: Math.PI / 2, angleTolerance: 0.26 },
    walls: [
      ...OUTER_WALLS,
      { id: "lower-banquet-table", x: 500, y: 430, width: 270, height: 76 },
      { id: "upper-banquet-table", x: 790, y: 230, width: 300, height: 76 },
      { id: "china-cabinet", x: 1010, y: 500, width: 58, height: 180 },
    ],
    breakables: [
      { id: "dinner-fish", kind: "fishbowl", x: 350, y: 280, width: 42, height: 42, value: 200 },
      { id: "dinner-vase-a", kind: "vase", x: 605, y: 165, width: 28, height: 28, value: 50 },
      { id: "dinner-lamp", kind: "lamp", x: 755, y: 545, width: 34, height: 34, value: 75 },
      { id: "dinner-tv", kind: "tv", x: 1100, y: 535, width: 74, height: 34, value: 300 },
      { id: "dinner-vase-b", kind: "vase", x: 940, y: 135, width: 28, height: 28, value: 50 },
    ],
  },
  {
    id: "midnight-zoomies",
    number: 11,
    title: "MIDNIGHT ZOOMIES",
    subtitle: "Cross the room twice. Mr. Pickles crosses it faster.",
    theme: "cat-chaos",
    mechanic: "carry",
    parTimeMs: 132_000,
    baseScore: 8_800,
    starThresholds: [3_100, 6_300, 9_900],
    couchMassScale: 1.27,
    moverForceScale: 0.95,
    couchStart: { x: 220, y: 180, angle: 0 },
    moverSpawns: [
      { x: 110, y: 180 },
      { x: 330, y: 180 },
      { x: 220, y: 100 },
      { x: 220, y: 270 },
    ],
    target: { x: 1080, y: 560, width: 230, height: 120, requiredAngle: 0, angleTolerance: 0.28 },
    walls: [
      ...OUTER_WALLS,
      { id: "zoomies-upper-divider", x: 500, y: 285, width: 880, height: 42 },
      { id: "zoomies-lower-divider", x: 780, y: 475, width: 880, height: 42 },
    ],
    breakables: [
      { id: "zoomies-fish", kind: "fishbowl", x: 400, y: 125, width: 42, height: 42, value: 200 },
      { id: "zoomies-lamp", kind: "lamp", x: 600, y: 125, width: 34, height: 34, value: 75 },
      { id: "zoomies-tv", kind: "tv", x: 800, y: 125, width: 74, height: 34, value: 300 },
      { id: "zoomies-vase-a", kind: "vase", x: 1000, y: 125, width: 28, height: 28, value: 50 },
      { id: "zoomies-vase-b", kind: "vase", x: 1160, y: 125, width: 28, height: 28, value: 50 },
    ],
    cat: {
      start: { x: 280, y: 377 },
      path: [
        { x: 280, y: 377 },
        { x: 1080, y: 377 },
      ],
      speed: 2.75,
      radius: 25,
    },
  },
  {
    id: "keyhole-gauntlet",
    number: 12,
    title: "THE KEYHOLE GAUNTLET",
    subtitle: "Up. Down. Up again. Try not to become part of the wall.",
    theme: "balcony",
    mechanic: "carry",
    parTimeMs: 154_000,
    baseScore: 9_600,
    starThresholds: [3_300, 6_900, 10_900],
    couchMassScale: 1.3,
    moverForceScale: 0.95,
    couchStart: { x: 220, y: 520, angle: 0 },
    moverSpawns: [
      { x: 110, y: 520 },
      { x: 330, y: 520 },
      { x: 220, y: 425 },
      { x: 220, y: 600 },
    ],
    target: { x: 1090, y: 195, width: 210, height: 190, requiredAngle: Math.PI / 2, angleTolerance: 0.18 },
    walls: [
      ...OUTER_WALLS,
      { id: "keyhole-gate-a", x: 420, y: 475, width: 44, height: 304 },
      { id: "keyhole-gate-b", x: 690, y: 225, width: 44, height: 264 },
      { id: "keyhole-gate-c", x: 960, y: 475, width: 44, height: 304 },
    ],
    breakables: [
      { id: "keyhole-tv-a", kind: "tv", x: 215, y: 145, width: 74, height: 34, value: 300 },
      { id: "keyhole-vase-a", kind: "vase", x: 500, y: 555, width: 28, height: 28, value: 50 },
      { id: "keyhole-fish", kind: "fishbowl", x: 600, y: 145, width: 42, height: 42, value: 200 },
      { id: "keyhole-lamp", kind: "lamp", x: 790, y: 545, width: 34, height: 34, value: 75 },
      { id: "keyhole-tv-b", kind: "tv", x: 865, y: 145, width: 74, height: 34, value: 300 },
      { id: "keyhole-vase-b", kind: "vase", x: 1155, y: 450, width: 28, height: 28, value: 50 },
    ],
  },
] as const;

export const TUTORIAL_LEVEL = LEVELS[0];

export function getClimbableLadder(
  level: LevelDefinition,
  position: Vec2,
  ropeGripped: boolean,
  verticalPadding = 0,
): LadderDefinition | undefined {
  if (!ropeGripped) return undefined;
  return level.ladders?.filter((ladder) => (
    Math.abs(position.x - ladder.x) <= ladder.width / 2 &&
    Math.abs(position.y - ladder.y) <= ladder.height / 2 + verticalPadding
  )).sort((first, second) => Math.abs(position.x - first.x) - Math.abs(position.x - second.x))[0];
}

export function canClimbLadder(
  level: LevelDefinition,
  position: Vec2,
  ropeGripped: boolean,
  verticalPadding = 0,
): boolean {
  return getClimbableLadder(level, position, ropeGripped, verticalPadding) !== undefined;
}

export interface PlayerProfile {
  color: MoverColorId;
  hat: MoverHatId;
}

export interface RoomPlayer {
  id: string;
  slot: number;
  label: string;
  profile: PlayerProfile;
  ready: boolean;
  connected: boolean;
  host: boolean;
  spectator: boolean;
  gripped: boolean;
  stats: PlayerStats;
}

export interface PlayerStats {
  damageCaused: number;
  itemsBroken: number;
  shouts: number;
  pivotShouts: number;
}

export interface ReplayPlayerFrame extends Vec2 {
  id: string;
  slot: number;
  profile: PlayerProfile;
  angle: number;
  gripped: boolean;
}

export interface ReplayFrame {
  at: number;
  couch: Vec2 & { angle: number; hp: number };
  players: ReplayPlayerFrame[];
}

export interface CrashReplay {
  event: GameEvent;
  frames: ReplayFrame[];
}

export interface LevelResult {
  score: number;
  stars: 1 | 2 | 3;
  elapsedMs: number;
  timeBonus: number;
  damagePenalty: number;
  itemsPenalty: number;
  hpRemaining: number;
  brokenItems: number;
  worstCrash: CrashReplay | null;
}

export interface RoomView {
  code: string;
  phase: RoomPhase;
  players: RoomPlayer[];
  levelId: string;
  levelIndex: number;
  totalLevels: number;
  countdownEndsAt: number | null;
  pausedReason: string | null;
  elapsedMs: number;
  result: LevelResult | null;
}

export interface BodySnapshot extends Vec2 {
  angle: number;
  vx: number;
  vy: number;
  angularVelocity: number;
}

export interface CouchSnapshot extends BodySnapshot {
  hp: number;
  maxHp: number;
}

export interface BreakableSnapshot extends Vec2 {
  id: string;
  kind: BreakableKind;
  angle: number;
  value: number;
  broken: boolean;
}

export interface CatSnapshot extends BodySnapshot {
  targetIndex: number;
  direction: -1 | 1;
}

export type GameEventKind = "impact" | "break" | "cat_bump";

export interface GameEvent {
  id: number;
  kind: GameEventKind;
  at: number;
  x: number;
  y: number;
  amount: number;
  text: string;
  playerId: string | null;
}

export interface ScoreSnapshot {
  score: number;
  timeBonus: number;
  damagePenalty: number;
  itemsPenalty: number;
}

export interface SnapshotPlayer extends BodySnapshot {
  id: string;
  slot: number;
  profile: PlayerProfile;
  connected: boolean;
  gripped: boolean;
  handleIndex: number | null;
  shout: { phrase: ShoutPhrase; expiresAt: number } | null;
}

export interface GameSnapshot {
  type: "snapshot";
  tick: number;
  serverTime: number;
  phase: RoomPhase;
  levelIndex: number;
  couch: CouchSnapshot;
  players: SnapshotPlayer[];
  target: TargetDefinition;
  breakables: BreakableSnapshot[];
  cat: CatSnapshot | null;
  events: GameEvent[];
  score: ScoreSnapshot;
  deliveryProgress: number;
  elapsedMs: number;
}

export type ClientMessage =
  | { type: "hello"; sessionToken?: string; profile: PlayerProfile }
  | { type: "set_profile"; profile: PlayerProfile }
  | { type: "set_ready"; ready: boolean }
  | { type: "select_level"; levelIndex: number }
  | { type: "start_game" }
  | { type: "move"; seq: number; x: number; y: number }
  | { type: "grip_toggle"; seq: number }
  | { type: "shout"; phrase: ShoutPhrase }
  | { type: "play_again" }
  | { type: "next_level" }
  | { type: "leave_room" }
  | { type: "ping"; clientTime: number };

export type ServerMessage =
  | {
      type: "welcome";
      playerId: string;
      sessionToken: string;
      serverTime: number;
      room: RoomView;
      level: LevelDefinition;
    }
  | { type: "room_state"; serverTime: number; room: RoomView }
  | { type: "level_state"; serverTime: number; level: LevelDefinition }
  | GameSnapshot
  | { type: "notice"; kind: "grip_miss" | "host_changed" | "player_rejoined"; message: string }
  | { type: "error"; code: string; message: string }
  | { type: "pong"; clientTime: number; serverTime: number };

export interface CreateRoomResponse {
  roomCode: string;
}

export function isMoverColor(value: unknown): value is MoverColorId {
  return MOVER_COLORS.some((color) => color.id === value);
}

export function isMoverHat(value: unknown): value is MoverHatId {
  return MOVER_HATS.some((hat) => hat.id === value);
}

export function isShout(value: unknown): value is ShoutPhrase {
  return SHOUTS.some((shout) => shout === value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeRoomCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, ROOM_CODE_LENGTH);
}

export function getHandlePoints(playerCount: number): Vec2[] {
  if (playerCount <= 2) {
    return [
      { x: -76, y: 0 },
      { x: 76, y: 0 },
    ];
  }

  return [
    { x: -70, y: -36 },
    { x: 70, y: -36 },
    { x: 70, y: 36 },
    { x: -70, y: 36 },
  ].slice(0, playerCount);
}
