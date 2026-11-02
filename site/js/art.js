// Dessins de la DA « Carte de l'Archipel » : traits à l'encre (currentColor) et touches de rouge (--mark), pour qu'ils
// suivent le thème clair (jour) ou sombre (nuit).
import { html } from "../vendor/preact-htm.js";

export const Compass = ({ class: cls }) => html`<svg class=${cls} viewBox="0 0 100 100" aria-hidden="true">
  <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" stroke-width="2.5" />
  <circle cx="50" cy="50" r="38" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 4" />
  ${[45, 135, 225, 315].map((a) => html`<polygon points="50,14 56,44 50,50 44,44" fill="currentColor" opacity=".45" transform=${`rotate(${a} 50 50)`} />`)}
  <polygon points="50,6 57,43 50,50 43,43" fill="var(--mark)" />
  <polygon points="50,94 57,57 50,50 43,57" fill="currentColor" />
  <polygon points="94,50 57,57 50,50 57,43" fill="currentColor" />
  <polygon points="6,50 43,43 50,50 43,57" fill="currentColor" />
  <circle cx="50" cy="50" r="4.5" fill="var(--bg)" stroke="currentColor" stroke-width="2" />
</svg>`;

export const Bottle = ({ class: cls }) => html`<svg class=${cls} viewBox="0 0 64 64" aria-hidden="true">
  <g transform="rotate(-35 32 32)">
    <rect x="27" y="4" width="10" height="8" rx="2" fill="var(--gold)" />
    <path d="M28 12h8v8c6 3 9 8 9 14v20a4 4 0 0 1-4 4H23a4 4 0 0 1-4-4V34c0-6 3-11 9-14z" fill="none" stroke="currentColor" stroke-width="3" />
    <rect x="25" y="32" width="14" height="16" rx="1.5" fill="currentColor" opacity=".35" />
    <path d="M27 37h10M27 41h7" stroke="currentColor" stroke-width="1.6" />
  </g>
</svg>`;

// Navire de profil, sur ses vagues (avancement d'un joueur vers sa croix).
export const Ship = ({ class: cls }) => html`<svg class=${cls} viewBox="0 0 64 64" aria-hidden="true">
  <path d="M8 42h48l-7 11H15z" fill="currentColor" />
  <path d="M32 8v34" stroke="currentColor" stroke-width="2.5" />
  <path d="M34 12c13 6 13 20 0 26z" fill="currentColor" opacity=".55" />
  <path d="M30 16c-10 5-10 15 0 20z" fill="currentColor" opacity=".35" />
  <path d="M32 8l9 3-9 3z" fill="var(--mark)" />
</svg>`;

// Croix du trésor (objectif, objet arrivé).
export const Cross = ({ class: cls }) => html`<svg class=${cls} viewBox="0 0 64 64" aria-hidden="true">
  <path d="M16 16l32 32M48 16L16 48" stroke="currentColor" stroke-width="8" stroke-linecap="round" />
</svg>`;

// Drapeau d'un joueur, à sa couleur (--pc).
export const Flag = ({ class: cls }) => html`<svg class=${cls} viewBox="0 0 40 40" aria-hidden="true">
  <path d="M10 4v34" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
  <path d="M11 6c6-3 10 3 17 0s6 0 8 0v13c-2 0-2-2-8 0s-11-3-17 0z" fill="var(--pc)" stroke="currentColor" stroke-width="1.6" />
</svg>`;

export const Chest = ({ class: cls }) => html`<svg class=${cls} viewBox="0 0 64 64" aria-hidden="true">
  <path d="M10 30h44v24H10z" fill="currentColor" opacity=".8" />
  <path d="M10 30c0-12 9-18 22-18s22 6 22 18z" fill="currentColor" />
  <rect x="27" y="26" width="10" height="12" rx="2" fill="var(--gold)" />
</svg>`;
