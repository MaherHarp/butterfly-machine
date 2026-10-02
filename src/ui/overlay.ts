/**
 * The DOM layer: typography over the canvas. Deliberately thin — it shows
 * and hides text; the director decides what and when.
 */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

export interface Action {
  label: string;
  onClick: () => void;
  primary?: boolean;
  breathe?: boolean;
  id?: string;
}

export interface LabelSpec {
  id: string;
  x: number;
  y: number;
  name: string;
  sub?: string;
  metric?: string;
  alpha: number;
  small?: boolean;
}

export class Overlay {
  readonly root: HTMLElement;
  private title: HTMLElement;
  private caption: HTMLElement;
  private capBig: HTMLElement;
  private capLine: HTMLElement;
  private readoutEl: HTMLElement;
  private actionsEl: HTMLElement;
  private labelsEl: HTMLElement;
  private cornerEl: HTMLElement;
  private controls: HTMLElement;
  private summaryEl: HTMLElement;
  private cardEl: HTMLElement;
  private debugEl: HTMLElement;
  private live: HTMLElement;
  private timingEl: HTMLElement;
  private timingInput: HTMLInputElement;
  private timingValue: HTMLElement;
  private timingHandler: ((v: number) => void) | null = null;
  private timingCommit: (() => void) | null = null;
  private labelEls = new Map<string, HTMLElement>();
  private markerEls = new Map<string, HTMLElement>();
  private actionKey = '';
  private readoutKey = '';
  muteBtn: HTMLButtonElement;
  motionBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;

  constructor(root: HTMLElement) {
    this.root = root;

    this.title = el('div', 'layer title hidden', root);
    const h1 = el('h1', '', this.title);
    h1.textContent = 'The Butterfly Machine';
    const p = el('p', '', this.title);
    p.innerHTML = 'One tiny choice.<br />Hundreds of different worlds.';
    const sub = el('div', 'sub', this.title);
    sub.textContent = 'A neuro-inspired artwork';

    this.caption = el('div', 'layer caption', root);
    this.capBig = el('div', 'big hidden', this.caption);
    this.capLine = el('div', 'line hidden', this.caption);

    this.readoutEl = el('div', 'layer readout hidden', root);
    this.actionsEl = el('div', 'layer actions hidden', root);
    this.labelsEl = el('div', 'layer labels', root);
    this.cornerEl = el('div', 'layer corner hidden', root);
    this.summaryEl = el('div', 'layer summary hidden', root);
    this.cardEl = el('div', 'layer card hidden', root);
    this.debugEl = el('div', 'layer debug hidden', root);

    this.timingEl = el('div', 'layer timing hidden', root);
    const lab = el('label', 'tl', this.timingEl);
    lab.textContent = 'delay';
    this.timingInput = el('input', '', this.timingEl);
    this.timingInput.type = 'range';
    this.timingInput.min = '1';
    this.timingInput.max = '10';
    this.timingInput.step = '1';
    this.timingInput.setAttribute('aria-label', 'Delay this spike, in milliseconds');
    this.timingValue = el('span', 'tv', this.timingEl);
    this.timingInput.addEventListener('input', () => {
      const v = Number(this.timingInput.value);
      this.timingValue.textContent = `${v} ms`;
      this.timingHandler?.(v);
    });
    this.timingInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.timingCommit?.();
      }
    });

    this.controls = el('div', 'layer controls', root);
    this.saveBtn = el('button', 'btn', this.controls);
    this.saveBtn.textContent = 'Save frame';
    this.saveBtn.title = 'Save a high-resolution image of this view (P)';
    this.motionBtn = el('button', 'btn', this.controls);
    this.muteBtn = el('button', 'btn', this.controls);

    this.live = el('div', 'sr-only', root);
    this.live.setAttribute('aria-live', 'polite');
  }

  showTitle(on: boolean, begin?: () => void, note?: string): void {
    this.title.classList.toggle('hidden', !on);
    let btn = this.title.querySelector<HTMLButtonElement>('.begin');
    if (on && begin) {
      if (!btn) {
        btn = el('button', 'btn primary begin', this.title);
        btn.textContent = 'Begin';
      }
      btn.onclick = begin;
      setTimeout(() => btn?.focus({ preventScroll: true }), 50);
    }
    let n = this.title.querySelector<HTMLElement>('.note');
    if (note) {
      if (!n) n = el('div', 'note', this.title);
      n.textContent = note;
    } else n?.remove();
  }

  /** Large spaced capitals. Pass null to fade out. */
  big(text: string | null): void {
    if (text) {
      this.capBig.textContent = text;
      this.announce(text);
    }
    this.capBig.classList.toggle('hidden', !text);
  }

  /** A serif line (may contain <em> numbers). Pass null to fade out. */
  line(html: string | null): void {
    if (html) {
      this.capLine.innerHTML = html;
      this.announce(this.capLine.textContent ?? '');
    }
    this.capLine.classList.toggle('hidden', !html);
  }

  captionHigh(high: boolean): void {
    this.caption.classList.toggle('high', high);
  }

  captionLow(low: boolean): void {
    this.caption.classList.toggle('low', low);
  }

  readout(html: string | null, key?: string): void {
    if (html === null) {
      this.readoutEl.classList.add('hidden');
      return;
    }
    // Rebuild structure only when its shape changes, so numbers update without flicker.
    if (key !== undefined && key === this.readoutKey) {
      const nums = this.readoutEl.querySelectorAll<HTMLElement>('[data-v]');
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const next = tmp.querySelectorAll<HTMLElement>('[data-v]');
      nums.forEach((n, i) => {
        const v = next[i]?.innerHTML;
        if (v !== undefined && n.innerHTML !== v) n.innerHTML = v;
      });
    } else {
      this.readoutEl.innerHTML = html;
      this.readoutKey = key ?? '';
    }
    this.readoutEl.classList.remove('hidden');
  }

  actions(list: Action[] | null): void {
    const key = list ? list.map((a) => a.label + (a.breathe ? '*' : '')).join('|') : '';
    if (!list || list.length === 0) {
      this.actionsEl.classList.add('hidden');
      this.actionKey = '';
      return;
    }
    if (key !== this.actionKey) {
      this.actionsEl.innerHTML = '';
      for (const a of list) {
        const b = el('button', 'btn' + (a.primary ? ' primary' : '') + (a.breathe ? ' breathe' : ''), this.actionsEl);
        b.textContent = a.label;
        if (a.id) b.id = a.id;
        b.onclick = (e) => {
          e.stopPropagation();
          a.onClick();
        };
      }
      this.actionKey = key;
    } else {
      // Refresh handlers (closures may have changed).
      const btns = this.actionsEl.querySelectorAll('button');
      list.forEach((a, i) => {
        if (btns[i]) btns[i].onclick = (e) => {
          e.stopPropagation();
          a.onClick();
        };
      });
    }
    this.actionsEl.classList.remove('hidden');
  }

  corner(html: string | null): void {
    if (html === null) {
      this.cornerEl.classList.add('hidden');
      return;
    }
    if (this.cornerEl.innerHTML !== html) this.cornerEl.innerHTML = html;
    this.cornerEl.classList.remove('hidden');
  }

  summary(html: string | null): void {
    if (html === null) {
      this.summaryEl.classList.add('hidden');
      return;
    }
    if (this.summaryEl.innerHTML !== html) this.summaryEl.innerHTML = html;
    this.summaryEl.classList.remove('hidden');
  }

  card(html: string | null, x = 0, y = 0): void {
    if (html === null) {
      this.cardEl.classList.add('hidden');
      return;
    }
    if (this.cardEl.innerHTML !== html) this.cardEl.innerHTML = html;
    const w = this.cardEl.offsetWidth || 180;
    const h = this.cardEl.offsetHeight || 90;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const px = x + 18 + w > vw - 8 ? x - w - 18 : x + 18;
    const py = Math.min(vh - h - 8, Math.max(8, y - h / 2));
    this.cardEl.style.transform = `translate(${px}px, ${py}px)`;
    this.cardEl.classList.remove('hidden');
  }

  /**
   * The one control of the artwork: a tiny timing slider (1–10 ms) beneath
   * the spike being changed. Pass null to hide it.
   */
  timing(spec: { x: number; y: number; value: number } | null, onInput?: (v: number) => void, onCommit?: () => void): void {
    if (!spec) {
      this.timingEl.classList.add('hidden');
      this.timingHandler = null;
      this.timingCommit = null;
      return;
    }
    if (onInput) this.timingHandler = onInput;
    if (onCommit) this.timingCommit = onCommit;
    if (Number(this.timingInput.value) !== spec.value) this.timingInput.value = String(spec.value);
    this.timingValue.textContent = `${spec.value} ms`;
    this.timingEl.style.transform = `translate(${spec.x.toFixed(1)}px, ${spec.y.toFixed(1)}px) translate(-50%, 0)`;
    const wasHidden = this.timingEl.classList.contains('hidden');
    this.timingEl.classList.remove('hidden');
    if (wasHidden) setTimeout(() => this.timingInput.focus({ preventScroll: true }), 60);
  }

  debug(text: string | null): void {
    if (text === null) {
      this.debugEl.classList.add('hidden');
      return;
    }
    this.debugEl.textContent = text;
    this.debugEl.classList.remove('hidden');
  }

  /** Positions world labels (CSS px). Labels not listed fade away. */
  labels(specs: LabelSpec[]): void {
    const seen = new Set<string>();
    for (const s of specs) {
      seen.add(s.id);
      let e = this.labelEls.get(s.id);
      if (!e) {
        e = el('div', 'wlabel', this.labelsEl);
        e.innerHTML = '<div class="n"></div><div class="s"></div><div class="m"></div>';
        e.style.opacity = '0';
        this.labelEls.set(s.id, e);
      }
      e.classList.toggle('small', !!s.small);
      const [n, sub, m] = e.children as unknown as HTMLElement[];
      if (n.textContent !== s.name) n.textContent = s.name;
      const subText = s.sub ?? '';
      if (sub.textContent !== subText) sub.textContent = subText;
      sub.style.display = subText ? '' : 'none';
      const mt = s.metric ?? '';
      if (m.textContent !== mt) m.textContent = mt;
      m.style.display = mt ? '' : 'none';
      e.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, 0)`;
      e.style.opacity = String(Math.max(0, Math.min(1, s.alpha)));
    }
    for (const [id, e] of this.labelEls) {
      if (!seen.has(id)) {
        e.style.opacity = '0';
        if (e.dataset.dying !== '1') {
          e.dataset.dying = '1';
          setTimeout(() => {
            if (e.style.opacity === '0') {
              e.remove();
              this.labelEls.delete(id);
            } else e.dataset.dying = '';
          }, 700);
        }
      } else e.dataset.dying = '';
    }
  }

  /** Small floating text markers at screen positions (CSS px). */
  markers(specs: Array<{ id: string; x: number; y: number; html: string; alpha: number; cls?: string }>): void {
    const seen = new Set<string>();
    for (const s of specs) {
      seen.add(s.id);
      let e = this.markerEls.get(s.id);
      if (!e) {
        e = el('div', s.cls ?? 'marker', this.labelsEl);
        this.markerEls.set(s.id, e);
      }
      if (e.innerHTML !== s.html) e.innerHTML = s.html;
      e.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`;
      e.style.opacity = String(s.alpha);
    }
    for (const [id, e] of this.markerEls) {
      if (!seen.has(id)) {
        e.remove();
        this.markerEls.delete(id);
      }
    }
  }

  announce(text: string): void {
    this.live.textContent = text;
  }
}
