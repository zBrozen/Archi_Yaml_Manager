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
