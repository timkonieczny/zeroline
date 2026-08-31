import { App } from '@/App';

const bootCard = document.getElementById('boot');
const bootStatus = document.getElementById('boot-status');

function status(text: string): void {
  if (bootStatus) bootStatus.textContent = text;
}

const app = new App(status);

app
  .start()
  .then(() => {
    bootCard?.classList.add('hidden');
    window.setTimeout(() => bootCard?.remove(), 500);
    // A handle on the running game, for poking at it from the console. Dev
    // builds only — it is stripped from a production bundle.
    if (import.meta.env.DEV) {
      (window as unknown as { zeroline: App }).zeroline = app;
    }
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    bootStatus?.classList.add('error');
    status(`COULD NOT START — ${message}`);
    console.error(error);
  });
