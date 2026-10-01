/**
 * World constants. One simulation unit is shown as one "pixel" in the
 * interface: when the visitor moves an organism by 0.7 px, it has moved 0.7
 * units in a world 800 units across.
 */

export const WORLD_RADIUS = 400;
export const STEPS_PER_SECOND = 60;
/** Steps a newly seeded world is run before anyone sees it, so it is already alive. */
export const WARMUP_STEPS = 1200;

export const MAX_AGENTS = 300;
export const MAX_REMNANTS = 160;
export const N_LINEAGES = 6;

export const KIND_GRAZER = 0;
export const KIND_HUNTER = 1;

/** Resource field resolution (cells per side) over the bounding square of the disk. */
export const FIELD_N = 48;
export const FIELD_CELL = (2 * WORLD_RADIUS) / FIELD_N;

/** Spatial hash for neighbour queries. */
export const GRID_N = 16;
export const GRID_CELL = (2 * WORLD_RADIUS) / GRID_N;

/** Distance at which two organisms are considered to touch (a "collision"). */
export const TOUCH_RADIUS = 10;
export const CATCH_RADIUS = 9;
/** Remnants within this distance grow into one connected structure. */
export const REMNANT_LINK = 56;

export const POP_HIST = 64;
/** Population is sampled into the history ring every this many steps. */
export const POP_SAMPLE_EVERY = 30;

export const EVENT_RING = 128;
