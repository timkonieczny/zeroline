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
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    bootStatus?.classList.add('error');
    status(`COULD NOT START — ${message}`);
    console.error(error);
  });
