/**
 * Procedural sound. Nothing is pre-recorded and nothing loops: every voice
 * is driven by simulation state.
 *
 *   lineage composition  →  harmony: each founder lineage owns one tone of an
 *                           open chord; its loudness is its share of the world.
 *                           A world taken over by one lineage hums one note;
 *                           a diverse world sounds the whole chord; an empty
 *                           world is silent.
 *   resource / energy    →  brightness (low-pass cutoff)
 *   hunters              →  a low, slow pulse
 *   motion               →  breath of filtered noise
 *   births               →  soft bells, pitched by lineage
 *   catches              →  muted percussive ticks
 *
 * Two futures play in two places: World A on the left, World B on the right.
 * While they are the same, you hear one sound. As they diverge, the stereo
 * image comes apart. Many futures are summed into one aggregate field.
 */

const CHORD = [110.0, 164.81, 196.0, 246.94, 293.66, 369.99];
const BELL_SCALE = [440.0, 659.25, 783.99, 987.77, 1174.66, 1479.98];

export interface VoiceState {
  /** −1 … 1 */
  pan: number;
  /** Share of each lineage among grazers (sums to ≤ 1). */
  shares: number[];
  /** Population relative to a healthy world (0 … ~1.5). */
  vitality: number;
  hunters: number;
  resource: number;
  motion: number;
  /** Overall loudness 0 … 1. */
  level: number;
}

export interface SoundEvent {
  type: 'birth' | 'catch' | 'death';
  lineage: number;
  pan: number;
  gain: number;
}

class Voice {
  readonly out: StereoPannerNode;
  private readonly filter: BiquadFilterNode;
  private readonly tones: GainNode[] = [];
  private readonly sub: GainNode;
  private readonly noise: GainNode;
  private readonly bus: GainNode;

  constructor(ctx: AudioContext, dest: AudioNode, noiseBuf: AudioBuffer, detune: number) {
    this.out = ctx.createStereoPanner();
    this.out.connect(dest);
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 800;
    this.filter.Q.value = 0.6;
    this.filter.connect(this.bus);
    this.bus.connect(this.out);

    CHORD.forEach((f, i) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.filter);
      const o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = f;
      o1.detune.value = detune + (i % 2 ? 3 : -3);
      const o2 = ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.value = f * 2;
      o2.detune.value = detune - 4;
      const g2 = ctx.createGain();
      g2.gain.value = 0.18;
      o1.connect(g);
      o2.connect(g2).connect(g);
      // Slow individual shimmer.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.05 + i * 0.023;
      const lg = ctx.createGain();
      lg.gain.value = 4;
      lfo.connect(lg).connect(o1.detune);
      o1.start();
      o2.start();
      lfo.start();
      this.tones.push(g);
    });

    this.sub = ctx.createGain();
    this.sub.gain.value = 0;
    const so = ctx.createOscillator();
    so.frequency.value = 55;
    const trem = ctx.createOscillator();
    trem.frequency.value = 0.35;
    const tg = ctx.createGain();
    tg.gain.value = 0.5;
    const subAmp = ctx.createGain();
    subAmp.gain.value = 0.5;
    trem.connect(tg).connect(subAmp.gain);
    so.connect(subAmp).connect(this.sub).connect(this.bus);
    so.start();
    trem.start();

    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 0.7;
    this.noise = ctx.createGain();
    this.noise.gain.value = 0;
    src.connect(bp).connect(this.noise).connect(this.bus);
    src.start(0, Math.random() * 2);
  }

  set(s: VoiceState, t: number): void {
    const tc = 0.6;
    this.out.pan.setTargetAtTime(Math.max(-1, Math.min(1, s.pan)), t, 0.3);
    const vit = Math.max(0, Math.min(1.4, s.vitality));
    this.bus.gain.setTargetAtTime(s.level * 0.9, t, 0.4);
    for (let i = 0; i < this.tones.length; i++) {
      const share = s.shares[i] ?? 0;
      this.tones[i].gain.setTargetAtTime(Math.sqrt(share) * 0.06 * vit, t, tc);
    }
    this.filter.frequency.setTargetAtTime(260 + 2600 * Math.pow(Math.max(0, Math.min(1, s.resource)), 1.2), t, 0.8);
    this.sub.gain.setTargetAtTime(Math.min(1, s.hunters / 14) * 0.05, t, 0.8);
    this.noise.gain.setTargetAtTime(Math.min(1, s.motion / 1.4) * 0.012 * vit, t, 0.8);
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
    reverb.buffer = impulse(ctx, 3.2, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
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

  update(states: Array<VoiceState | null>, events: SoundEvent[]): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime;
    for (let i = 0; i < this.voices.length; i++) {
      const s = states[i];
      if (s) this.voices[i].set({ ...s, level: s.level * this.level }, t);
      else this.voices[i].set({ pan: 0, shares: [], vitality: 0, hunters: 0, resource: 0, motion: 0, level: 0 }, t);
    }
    // At most ~7 events a second, so a thousand worlds become rain, not noise.
    const dt = Math.min(0.25, Math.max(0, t - this.lastT));
    this.lastT = t;
    this.budget = Math.min(3, this.budget + dt * 7);
    for (const e of events) {
      if (this.budget < 1) break;
      this.budget -= 1;
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
    if (e.type === 'birth') {
      const f = BELL_SCALE[e.lineage % BELL_SCALE.length] * (e.lineage >= 6 ? 0.5 : 1);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = f * 2.76;
      const g2 = ctx.createGain();
      g2.gain.value = 0.18;
      o.connect(g);
      o2.connect(g2).connect(g);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.035 * gain, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      o.start(t);
      o2.start(t);
      o.stop(t + 1.7);
      o2.stop(t + 1.7);
    } else if (e.type === 'catch') {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(180, t);
      o.frequency.exponentialRampToValueAtTime(60, t + 0.18);
      o.connect(g);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.07 * gain, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.start(t);
      o.stop(t + 0.32);
    } else {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(CHORD[e.lineage % CHORD.length] * 2, t);
      o.frequency.exponentialRampToValueAtTime(CHORD[e.lineage % CHORD.length], t + 0.9);
      o.connect(g);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.012 * gain, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
      o.start(t);
      o.stop(t + 1.05);
    }
  }

  /** One sustained tone for the ending. */
  tone(lineage: number, seconds: number): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = BELL_SCALE[lineage % BELL_SCALE.length];
    const g = ctx.createGain();
    o.connect(g).connect(this.fxIn!);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.04, t + 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    o.start(t);
    o.stop(t + seconds + 0.1);
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
