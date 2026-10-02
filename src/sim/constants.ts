/**
 * Network constants.
 *
 * One simulation step is one millisecond of the network's own time. The
 * network is a neuro-inspired artwork, not a model of a brain: the units are
 * dimensionless (membrane threshold = 1) and "milliseconds" are the network's
 * clock, chosen so that spike timing can be changed by a handful of steps.
 */

/** Simulation steps per second of network time (dt = 1 ms). */
export const STEPS_PER_SECOND = 1000;
export const MS_PER_STEP = 1000 / STEPS_PER_SECOND;

/** Steps a newly seeded mind is run before anyone sees it, so it is already alive. */
export const WARMUP_STEPS = 1000;
/** Step at which the ambiguous stimulus begins to appear (absolute, part of the model). */
export const STIM_ON = 2600;
/** Steps over which the stimulus fades in to full contrast. */
export const STIM_RAMP = 1500;

// ---- population -----------------------------------------------------------

/** Stimulus fragments: each feeds one channel of sensory units. */
export const N_CHANNELS = 5;
export const CH_HOUSE = 0;
export const CH_RAIN = 1;
export const CH_FIGURE = 2;
export const CH_DOOR = 3;
export const CH_TEXTURE = 4;
export const SENSORY_PER_CHANNEL = 10;
export const N_SENSORY = N_CHANNELS * SENSORY_PER_CHANNEL;

/** Excitatory assemblies. Each one's self-sustaining activity is an attractor. */
export const N_ASSEMBLIES = 6;
export const ASSEMBLY_SIZE = 60;
export const N_EXC = N_ASSEMBLIES * ASSEMBLY_SIZE;
export const N_INH = 90;

export const N_NEURONS = N_SENSORY + N_EXC + N_INH;
/** Index ranges: sensory, then excitatory (assembly-major), then inhibitory. */
export const SENS_START = 0;
export const EXC_START = N_SENSORY;
export const INH_START = N_SENSORY + N_EXC;

export const TYPE_SENSORY = 0;
export const TYPE_EXC = 1;
export const TYPE_INH = 2;

/** Synaptic delays are 1 … MAX_DELAY steps; the delay lines hold MAX_DELAY + 1 slots. */
export const MAX_DELAY = 9;
export const RING = MAX_DELAY + 1;

/** Visual radius of a mind (neuron positions lie in the unit disk). */
export const MIND_RADIUS = 1;

/** Small ring of discrete, low-volume events kept in each mind's state. */
export const EVENT_RING = 64;

/** Up to this many synapse weight changes can be carried by one mind. */
export const MAX_WEIGHT_OVERRIDES = 16;
