import '@fontsource/cormorant-garamond/latin-300-italic.css';
import '@fontsource/cormorant-garamond/latin-400-italic.css';
import '@fontsource/jost/latin-300.css';
import '@fontsource/jost/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-300.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './ui/styles.css';
import { Director, randomSeed } from './experience/director';

function fail(message: string): void {
  const ui = document.getElementById('ui')!;
  ui.innerHTML = `<div class="layer title"><h1>The Butterfly Machine</h1><p>${message}</p></div>`;
}

function boot(): void {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  const params = new URLSearchParams(location.search);
  const cores = navigator.hardwareConcurrency || 4;
  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  const seedParam = params.get('seed');
  const seed = seedParam !== null && /^\d+$/.test(seedParam) ? Number(seedParam) % 1000000 : randomSeed();
  // 1,024 futures on capable machines; fewer where cores (or screen) are scarce.
  const maxDepth = small || cores <= 4 ? 8 : 10;
  const workers = Math.max(2, Math.min(12, cores - 2));
  try {
    const director = new Director(canvas, ui, {
      workers,
      maxDepth,
      seed,
      debug: params.has('debug'),
      small,
      share: location.hash.includes('f=') ? location.hash : null,
    });
    void director.start();
  } catch (err) {
    console.error(err);
    fail('This artwork needs a browser with WebGL2.<br/>Please try a recent desktop browser.');
  }
}

boot();
