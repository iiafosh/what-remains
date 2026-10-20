// Credits panel: everything the page streams in that needs (or deserves)
// attribution. The map providers' own credits stay on the globe at the bottom
// left, as their terms require; this panel covers the rest.

import { SOUND_CREDITS } from './config.js';

const LICENSES = {
  'CC BY-SA 4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
  'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC0': 'https://creativecommons.org/publicdomain/zero/1.0/',
};

const SCENES = {
  desert: 'Giza',
  rome: 'Rome',
  acropolis: 'Athens',
  alpine: 'Matterhorn',
  fuji: 'Mount Fuji',
};

function link(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

function licence(name) {
  return LICENSES[name] ? link(LICENSES[name], name) : document.createTextNode(name);
}

// On phones the map providers' credits wrap to several lines. Publish their
// height so the CSS can stack the status row, dock and card above them:
// those credits must stay visible.
function trackMapCredits() {
  const box = document.querySelector('.cesium-viewer-bottom');
  if (!box || !window.ResizeObserver) return;
  const set = () => document.documentElement.style.setProperty('--map-credits-h', `${Math.ceil(box.offsetHeight)}px`);
  new ResizeObserver(set).observe(box);
  set();
}

export function setupCredits() {
  trackMapCredits();
  const button = document.getElementById('btn-credits');
  const dialog = document.getElementById('credits');
  const list = document.getElementById('credits-sound');
  if (!button || !dialog || !list) return;

  for (const c of SOUND_CREDITS) {
    const li = document.createElement('li');
    const where = c.scene.split(',').map((s) => SCENES[s.trim()] || s.trim()).join(', ');
    li.append(link(c.page, c.title), ` by ${c.author} · `, licence(c.license));
    const small = document.createElement('small');
    small.textContent = where;
    li.append(small);
    list.append(li);
  }

  button.addEventListener('click', () => dialog.showModal());
  dialog.querySelector('.credits-close').addEventListener('click', () => dialog.close());
  // Clicking the dimmed backdrop (the dialog element itself) closes it too.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  // Keys pressed in the panel must not reach the HUD's shortcuts (1–5 fly, Esc goes to space).
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
}
