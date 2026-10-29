import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { App } from './ui/App';
import './styles.css';

registerSW({ immediate: true });

// Drop caches from earlier versions that may hold the HTML fallback page stored under
// a model URL (see asr.worker.ts and vite.config.ts). Models re-cache on next load.
if ('caches' in window) {
  for (const name of ['transformers-cache', 'ftr-models']) caches.delete(name).catch(() => {});
}
render(<App />, document.getElementById('app')!);
