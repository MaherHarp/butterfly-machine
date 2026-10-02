/**
 * Procedural sound. Nothing is pre-recorded and nothing loops: every voice
 * is driven by the network's state.
 *
 *   assembly activity   →  harmony: each assembly owns one tone of an open
 *                          chord, as loud as its share of the activity. An
 *                          undecided mind sounds the whole chord, shimmering;
 *                          as it settles into an attractor the chord collapses
 *                          onto that assembly's tone and its fifth, and the
 *                          shimmer stills (tonal stability).
 *   inhibition          →  a low, slow pulse
 *   spiking density     →  breath of filtered noise
 *   spikes              →  tiny transients
 *   pink (causal)       →  a glassy, high shimmer — the change, audible
 *   settling            →  a soft bell on that assembly's tone
 *
 * Two minds play in two places, the original on the left and the altered on
 * the right. While they are the same you hear one sound; as they diverge,
 * the stereo image comes apart. Many minds are summed into one field.
 */

const CHORD = [146.83, 196.0, 220.0, 293.66, 329.63, 392.0];
const TICK = [587.33, 783.99, 880.0, 1174.66, 1318.51, 1567.98, 440.0, 659.25];

export interface VoiceState {
  /** −1 … 1 */
  pan: number;
  /** Share of activity of each assembly (sums to ≤ 1). */
  shares: number[];
  /** Overall excitatory activity (0 … ~1.5). */
  activity: number;
  /** Inhibitory rate (Hz). */
  inhibition: number;
  /** How settled the mind is in an attractor (0 … 1). */
  stability: number;
  /** Share of the network carrying the change (0 … 1). */
  pink: number;
  /** Spikes per step. */
  density: number;
  /** Overall loudness 0 … 1. */
  level: number;
}

export interface SoundEvent {
  type: 'spike' | 'pinkspike' | 'settle' | 'release';
  /** Assembly index, or 6 (inhibitory) / 7 (sensory). */
  voice: number;
  pan: number;
  gain: number;
}

class Voice {
  readonly out: StereoPannerNode;
  private readonly filter: BiquadFilterNode;
  private readonly tones: GainNode[] = [];
  private readonly fifths: GainNode[] = [];
  private readonly shimmer: GainNode[] = [];
  private readonly sub: GainNode;
  private readonly subRate: OscillatorNode;
  private readonly noise: GainNode;
  private readonly glass: GainNode;
  private readonly bus: GainNode;

  constructor(ctx: AudioContext, dest: AudioNode, noiseBuf: AudioBuffer, detune: number) {
    this.out = ctx.createStereoPanner();
    this.out.connect(dest);
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 900;
    this.filter.Q.value = 0.5;
    this.filter.connect(this.bus);
    this.bus.connect(this.out);

    CHORD.forEach((f, i) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.filter);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.detune.value = detune + (i % 2 ? 2 : -2);
      o.connect(g);
      // The fifth above, heard only once the mind has settled on this tone.
      const g5 = ctx.createGain();
      g5.gain.value = 0;
      g5.connect(this.filter);
      const o5 = ctx.createOscillator();
      o5.type = 'triangle';
      o5.frequency.value = f * 1.5;
      o5.detune.value = detune;
      o5.connect(g5);
      // Unsettled shimmer: a slow vibrato whose depth follows instability.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.11 + i * 0.037;
      const depth = ctx.createGain();
      depth.gain.value = 0;
      lfo.connect(depth).connect(o.detune);
      o.start();
      o5.start();
      lfo.start();
      this.tones.push(g);
      this.fifths.push(g5);
      this.shimmer.push(depth);
    });

    this.sub = ctx.createGain();
    this.sub.gain.value = 0;
    const so = ctx.createOscillator();
    so.frequency.value = 55;
    this.subRate = ctx.createOscillator();
    this.subRate.frequency.value = 0.5;
    const tg = ctx.createGain();
    tg.gain.value = 0.5;
    const subAmp = ctx.createGain();
    subAmp.gain.value = 0.5;
    this.subRate.connect(tg).connect(subAmp.gain);
    so.connect(subAmp).connect(this.sub).connect(this.bus);
    so.start();
    this.subRate.start();

    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 0.8;
    this.noise = ctx.createGain();
    this.noise.gain.value = 0;
    src.connect(bp).connect(this.noise).connect(this.bus);
    src.start(0, Math.random() * 2);

    // Pink: two inharmonic high partials with a fast tremolo.
    this.glass = ctx.createGain();
    this.glass.gain.value = 0;
    this.glass.connect(this.out);
    const trem = ctx.createOscillator();
    trem.frequency.value = 5.3;
    const tAmt = ctx.createGain();
    tAmt.gain.value = 0.4;
    const gAmp = ctx.createGain();
    gAmp.gain.value = 0.6;
    trem.connect(tAmt).connect(gAmp.gain);
    for (const f of [1864.7, 2489.0 * 1.003]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.detune.value = detune * 3;
      o.connect(gAmp);
      o.start();
    }
    gAmp.connect(this.glass);
    trem.start();
  }

  set(s: VoiceState, t: number): void {
    this.out.pan.setTargetAtTime(Math.max(-1, Math.min(1, s.pan)), t, 0.3);
    this.bus.gain.setTargetAtTime(s.level * 0.9, t, 0.4);
    const act = Math.max(0.15, Math.min(1.3, s.activity + 0.25));
    const stab = Math.max(0, Math.min(1, s.stability));
    let dom = 0;
    for (let i = 1; i < this.tones.length; i++) if ((s.shares[i] ?? 0) > (s.shares[dom] ?? 0)) dom = i;
    for (let i = 0; i < this.tones.length; i++) {
      const share = s.shares[i] ?? 0;
      const isDom = i === dom;
      const g = Math.sqrt(share) * 0.05 * act * (isDom ? 1 + stab * 0.6 : 1 - stab * 0.75);
      this.tones[i].gain.setTargetAtTime(g, t, 0.7);
      this.fifths[i].gain.setTargetAtTime(isDom ? 0.022 * stab * act : 0, t, 0.9);
      this.shimmer[i].gain.setTargetAtTime(14 * (1 - stab), t, 1.2);
    }
    this.filter.frequency.setTargetAtTime(380 + 1900 * Math.min(1, s.activity), t, 0.8);
    this.sub.gain.setTargetAtTime(Math.min(1, s.inhibition / 30) * 0.035, t, 0.8);
    this.subRate.frequency.setTargetAtTime(0.25 + Math.min(2, s.inhibition / 20), t, 1);
    this.noise.gain.setTargetAtTime(Math.min(1, s.density / 12) * 0.01 * s.level, t, 0.6);
    this.glass.gain.setTargetAtTime(Math.min(1, s.pink) * 0.009 * s.level, t, 0.5);
  }
}

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private fxIn: GainNode | null = null;
  private voices: Voice[] = [];
  private muted = false;
  private budget = 0;
  private lastT = 0;
  private level = 1;

  get started(): boolean {
    return !!this.ctx;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Must be called from a user gesture. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 0.0001;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    master.connect(comp).connect(ctx.destination);
    this.master = master;
    master.gain.setTargetAtTime(this.muted ? 0 : 0.9, ctx.currentTime, 1.5);

    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx, 3.4, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.6;
    reverb.connect(wet).connect(master);
    const fxIn = ctx.createGain();
    fxIn.connect(reverb);
    fxIn.connect(master);
    this.fxIn = fxIn;

    const noise = noiseBuffer(ctx);
    const dry = ctx.createGain();
    dry.gain.value = 0.85;
    dry.connect(master);
    dry.connect(reverb);
    this.voices = [new Voice(ctx, dry, noise, -2), new Voice(ctx, dry, noise, 2)];
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.25);
  }

  /** Global level for fades (0–1). */
  setLevel(level: number): void {
    this.level = level;
  }

  suspend(on: boolean): void {
    if (!this.ctx) return;
    if (on) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  update(states: Array<VoiceState | null>, events: SoundEvent[], timeScale: number): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime;
    for (let i = 0; i < this.voices.length; i++) {
      const s = states[i];
      if (s) this.voices[i].set({ ...s, level: s.level * this.level }, t);
      else this.voices[i].set({ pan: 0, shares: [], activity: 0, inhibition: 0, stability: 0, pink: 0, density: 0, level: 0 }, t);
    }
    // A budget of about ten transients a second, so hundreds of minds become rain, not noise.
    const dt = Math.min(0.25, Math.max(0, t - this.lastT));
    this.lastT = t;
    this.budget = Math.min(3, this.budget + dt * (4 + 6 * Math.min(1, timeScale)));
    for (const e of events) {
      const cost = e.type === 'spike' || e.type === 'pinkspike' ? 1 : 0.5;
      if (this.budget < cost) continue;
      this.budget -= cost;
      this.play(e, t + Math.random() * 0.03);
    }
  }

  private play(e: SoundEvent, t: number): void {
    const ctx = this.ctx!;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, e.pan));
    pan.connect(this.fxIn!);
    const g = ctx.createGain();
    g.connect(pan);
    const gain = e.gain * this.level;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.connect(g);
    g.gain.setValueAtTime(0, t);
    if (e.type === 'spike') {
      o.frequency.value = TICK[e.voice % TICK.length];
      g.gain.linearRampToValueAtTime(0.012 * gain, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      o.start(t);
      o.stop(t + 0.1);
    } else if (e.type === 'pinkspike') {
      o.frequency.value = TICK[e.voice % TICK.length] * 2.76;
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = TICK[e.voice % TICK.length] * 4.07;
      o2.connect(g);
      g.gain.linearRampToValueAtTime(0.01 * gain, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.start(t);
      o2.start(t);
      o.stop(t + 0.4);
      o2.stop(t + 0.4);
    } else if (e.type === 'settle') {
      o.frequency.value = CHORD[e.voice % CHORD.length] * 2;
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = CHORD[e.voice % CHORD.length] * 3;
      const g2 = ctx.createGain();
      g2.gain.value = 0.4;
      o2.connect(g2).connect(g);
      g.gain.linearRampToValueAtTime(0.03 * gain, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
      o.start(t);
      o2.start(t);
      o.stop(t + 2.7);
      o2.stop(t + 2.7);
    } else {
      this.chime(t, 2.2, 0.03 * gain, pan);
      o.disconnect();
    }
  }

  /** The glassy pink chime of a postponed spike. */
  private chime(t: number, seconds: number, peak: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    for (const f of [1864.7, 2489.0, 3520.0 * 1.01]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(g);
      o.start(t);
      o.stop(t + seconds + 0.05);
    }
  }

  /** The single sustained pink tone of the ending. */
  release(_voice: number, seconds: number): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    this.chime(ctx.currentTime, seconds, 0.035, this.fxIn!);
  }
}

function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.997 * b0 + w * 0.029;
    b1 = 0.985 * b1 + w * 0.032;
    b2 = 0.95 * b2 + w * 0.048;
    d[i] = (b0 + b1 + b2) * 0.6;
  }
  return buf;
}

function impulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}
