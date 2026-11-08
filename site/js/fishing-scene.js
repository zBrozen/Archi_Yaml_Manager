// Décor de la pêche au large (fishing.js) : l'île où l'on pêche (le monde d'un joueur), la traversée d'une île à
// l'autre, la mer qui bouge (courants, objets à la dérive, ombres des nuages) et les effets de bords d'écran.
// Décor seulement : rien n'y porte d'information (le nom de l'île est aussi écrit dans le tableau de bord, chaque effet de
// bord accompagne un message écrit). Mouvement réduit : rien ne défile, la traversée est un simple fondu, pas d'éclat
// sur les bords (seulement les teintes qui durent : nuit, banc, carte maudite…).

const TRAVEL_MS = 2600; // traversée d'une île à l'autre
const FADE_MS = 500; // mouvement réduit : fondu d'une île à l'autre
const DRIFT = 14; // courant : la mer glisse vers la gauche (px/s)

// Hachage stable d'un texte, et tirage pseudo-aléatoire qui en découle (même île, même dessin, à chaque visite).
const hash = (text) => [...String(text)].reduce((h, ch) => (Math.imul(h, 31) + ch.codePointAt(0)) | 0, 7) >>> 0;
function rng(seed) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Paysages : une île par joueur, tirée de son nom et de son jeu.
export const BIOMES = {
  tropical: { label: "île tropicale", sand: "#ecd39a", edge: "#c9a865", land: "#6fae5a", land2: "#4c8a41" },
  forest: { label: "île forestière", sand: "#e0c68e", edge: "#b8995c", land: "#4f8a3c", land2: "#3a6e2c" },
  rocky: { label: "île rocheuse", sand: "#d6ccb4", edge: "#a99f86", land: "#8d959b", land2: "#6f777d" },
  volcano: { label: "île volcanique", sand: "#9c8a76", edge: "#6f6152", land: "#5b4a44", land2: "#45372f" },
  snow: { label: "île des glaces", sand: "#dfe9ef", edge: "#a9c0cf", land: "#f4f8fb", land2: "#d5e3ee" },
  ruins: { label: "île aux ruines", sand: "#ecd39a", edge: "#c9a865", land: "#d9b77a", land2: "#c39e5e" },
};
const BIOME_KEYS = Object.keys(BIOMES);
export const biomeOf = (island) => BIOME_KEYS[hash(`${island.name}|${island.game}`) % BIOME_KEYS.length];
const flagOf = (island) => `hsl(${(hash(island.name) * 137) % 360}, 70%, 52%)`; // noms voisins, couleurs éloignées
const ofName = (name) => (/^[aeiouyâàéèêëîïôöûü]/i.test(name) ? `d'${name}` : `de ${name}`);

function islandPath(ctx, cx, cy, r, seed, scale) {
  ctx.beginPath();
  for (let a = 0; a <= 64; a++) {
    const th = (a / 64) * Math.PI * 2;
    const rr = r * scale * (1 + 0.14 * Math.sin(2 * th + seed) + 0.08 * Math.sin(3 * th + seed * 2) + 0.05 * Math.sin(5 * th + seed * 3));
    const x = cx + Math.cos(th) * rr * 1.25, y = cy + Math.sin(th) * rr;
    if (a) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

// Partie fixe d'une île (plage, terres, décor, ponton, panneau), dessinée une fois sur un canvas à part.
function paintIsland(island, R, dpr, dark) {
  const biome = biomeOf(island), B = BIOMES[biome], seed = (hash(island.name) % 1000) / 100;
  const W = Math.ceil(R * 3.4), H = Math.ceil(R * 2.6);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(W * dpr); canvas.height = Math.ceil(H * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const cx = W * 0.6, cy = H / 2; // l'île est vue de son côté gauche : marge à gauche pour le ponton et le panneau
  if (dark) ctx.filter = "brightness(0.72) saturate(0.85)";
  const rand = rng(hash(`${island.name}|${island.game}|décor`));
  // Un point sur les terres, du côté visible (l'île dépasse à droite de l'écran) : `spread` élargit la zone.
  const spot = (spread = 0.6) => {
    for (let n = 0; n < 200; n++) {
      const x = -0.86 + rand() * 0.62, y = (rand() * 2 - 1) * spread * 0.85;
      if (((x - 0.06) / 0.85) ** 2 + (y / 0.66) ** 2 < 0.9) return [cx + x * R, cy + y * R];
    }
    return [cx - R * 0.5, cy];
  };

  // Ponton : des planches vers le large, sous la plage.
  const py = cy + R * 0.32, px0 = cx - R * 1.05, px1 = cx - R * 1.38;
  ctx.fillStyle = "#3b2a1a";
  for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(px1 + k * (px0 - px1) / 2.2, py + 9, 3, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = "#8a5f36"; ctx.strokeStyle = "#4a3320"; ctx.lineWidth = 1.2;
  for (let x = px1; x < px0; x += 9) { ctx.fillRect(x, py - 7, 7, 14); ctx.strokeRect(x, py - 7, 7, 14); }

  // Plage, puis terres
  islandPath(ctx, cx, cy, R, seed, 1); ctx.fillStyle = B.sand; ctx.fill();
  ctx.strokeStyle = B.edge; ctx.lineWidth = 2; ctx.stroke();
  islandPath(ctx, cx + R * 0.06, cy - R * 0.04, R, seed + 1, 0.7); ctx.fillStyle = B.land; ctx.fill();
  islandPath(ctx, cx + R * 0.1, cy - R * 0.08, R, seed + 2, 0.4); ctx.fillStyle = B.land2; ctx.fill();

  if (biome === "tropical") {
    for (let k = 0; k < 6; k++) {
      const [x, y] = spot(0.6), a0 = rand() * 6;
      ctx.fillStyle = "#3f7d39";
      for (let l = 0; l < 6; l++) {
        const a = a0 + l * 1.05;
        ctx.beginPath(); ctx.ellipse(x + Math.cos(a) * 9, y + Math.sin(a) * 9, 11, 3.6, a, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = "#7a5230"; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  } else if (biome === "forest") {
    for (let k = 0; k < 16; k++) {
      const [x, y] = spot(0.62), r = R * (0.07 + rand() * 0.06);
      ctx.fillStyle = "#2f6b2f"; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(160, 210, 120, 0.45)"; ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.45, 0, Math.PI * 2); ctx.fill();
    }
  } else if (biome === "rocky") {
    for (let k = 0; k < 8; k++) {
      const [x, y] = spot(0.62), r = R * (0.05 + rand() * 0.06);
      ctx.fillStyle = "#5f676c"; ctx.beginPath(); ctx.ellipse(x, y, r * 1.3, r, rand() * 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255, 255, 255, 0.25)"; ctx.beginPath(); ctx.ellipse(x - r * 0.3, y - r * 0.3, r * 0.5, r * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    }
    // Phare (vu d'en haut : tour ronde rayée)
    const lx = cx - R * 0.7, ly = cy - R * 0.2;
    ctx.fillStyle = "#fbf4e2"; ctx.strokeStyle = "#3b2a1a"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(lx, ly, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = "#c8432c"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(lx, ly, 7, 0, Math.PI * 2); ctx.stroke();
  } else if (biome === "volcano") {
    const vx = cx - R * 0.3, vy = cy - R * 0.05;
    [[0.5, "#4a3a33"], [0.36, "#3a2d27"], [0.22, "#2c211c"]].forEach(([r, c]) => {
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(vx, vy, R * r, 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = "#e0521f"; ctx.beginPath(); ctx.arc(vx, vy, R * 0.11, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#e0761f"; ctx.lineWidth = 3; // coulée de lave
    ctx.beginPath(); ctx.moveTo(vx - R * 0.08, vy + R * 0.05);
    ctx.quadraticCurveTo(vx - R * 0.35, vy + R * 0.2, vx - R * 0.55, vy + R * 0.42); ctx.stroke();
  } else if (biome === "snow") {
    for (let k = 0; k < 10; k++) {
      const [x, y] = spot(0.6), s = R * (0.06 + rand() * 0.05);
      ctx.fillStyle = "#2f5a3c";
      ctx.beginPath(); ctx.moveTo(x, y - s * 1.4); ctx.lineTo(x + s, y + s * 0.8); ctx.lineTo(x - s, y + s * 0.8); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.moveTo(x, y - s * 1.4); ctx.lineTo(x + s * 0.4, y - s * 0.5); ctx.lineTo(x - s * 0.4, y - s * 0.5); ctx.closePath(); ctx.fill();
    }
  } else if (biome === "ruins") {
    const rx = cx - R * 0.55, ry = cy - R * 0.25, gw = R * 0.5, gh = R * 0.32;
    ctx.strokeStyle = "#a08a64"; ctx.lineWidth = 4; ctx.setLineDash([R * 0.12, R * 0.05]);
    ctx.strokeRect(rx - gw / 2, ry - gh / 2, gw, gh); ctx.setLineDash([]);
    for (let k = 0; k < 6; k++) {
      const x = rx - gw / 2 + (k % 3) * (gw / 2), y = k < 3 ? ry - gh / 2 : ry + gh / 2;
      ctx.fillStyle = "#efe2c4"; ctx.strokeStyle = "#8f7a55"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    for (let k = 0; k < 3; k++) {
      const [x, y] = spot(0.6);
      ctx.fillStyle = "#4f8a3c"; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.filter = "none";

  // Panneau au bout du ponton : le nom de l'île (aussi écrit dans le tableau de bord).
  const text = `Île ${ofName(island.name)}`;
  ctx.font = "700 15px Lexend, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const tw = Math.min(ctx.measureText(text).width + 16, R * 1.5), sx = px1 + 6, sy = py - 24;
  ctx.fillStyle = "#3b2a1a"; ctx.fillRect(sx - 1.5, sy, 3, 18);
  ctx.fillStyle = "#e9d4a6"; ctx.strokeStyle = "#4a3320"; ctx.lineWidth = 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(sx - tw / 2, sy - 13, tw, 24, 4); else ctx.rect(sx - tw / 2, sy - 13, tw, 24);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#24170a"; ctx.fillText(text, sx, sy - 1, tw - 10);
  return { canvas, W, H, cx, cy, biome, seed };
}

// Objets à la dérive : de quoi sentir le courant (rien à pêcher).
const FLOTSAM = ["leaf", "weed", "wood", "barrel", "bottle"];
function drawFlotsam(ctx, f, t, dark) {
  ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.rot + Math.sin(t / 900 + f.phase) * 0.25);
  ctx.globalAlpha = dark ? 0.75 : 0.9;
  if (f.type === "leaf") {
    ctx.fillStyle = "#6fae5a"; ctx.beginPath(); ctx.ellipse(0, 0, 9, 4.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#3f7d39"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(9, 0); ctx.stroke();
  } else if (f.type === "weed") {
    ctx.strokeStyle = "#4c7a3a"; ctx.lineWidth = 2.5; ctx.lineCap = "round";
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath(); ctx.moveTo(-14, k * 4);
      for (let x = -14; x <= 14; x += 4) ctx.lineTo(x, k * 4 + Math.sin(x / 4 + t / 300 + k) * 2);
      ctx.stroke();
    }
  } else if (f.type === "wood") {
    ctx.fillStyle = "#8a5f36"; ctx.strokeStyle = "#4a3320"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(0, 0, 20, 4.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else if (f.type === "barrel") {
    ctx.fillStyle = "#9a6a3c"; ctx.strokeStyle = "#3b2a1a"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 5.5, 0, Math.PI * 2); ctx.stroke();
  } else {
    ctx.fillStyle = "rgba(170, 220, 200, 0.85)"; ctx.strokeStyle = "rgba(20, 60, 50, 0.8)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, 0, 8, 3.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#8a5f36"; ctx.fillRect(8, -1.5, 4, 3);
  }
  ctx.restore();
}

export function createScene() {
  let area = { x0: 0, y0: 0, x1: 0, y1: 0 }, w = 0, h = 0, dpr = 1, R = 120;
  let island = null; // île où l'on est (ou null : le large)
  let travel = null; // { t0, dur, from, to, S, pos }
  let arrivedAt = 0;
  const cache = new Map();
  const streaks = Array.from({ length: 22 }, () => ({ x: Math.random(), y: Math.random(), len: 30 + Math.random() * 70, a: 0.05 + Math.random() * 0.08 }));
  const clouds = Array.from({ length: 3 }, (_, k) => ({ x: Math.random(), y: Math.random(), r: 0.22 + k * 0.08, vx: 7 + k * 3, vy: 2 + k }));
  let flotsam = [], nextFlotsam = 0, speed = 0;

  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
  const anchor = () => ({ x: area.x1 + R * 0.3, y: area.y0 + (area.y1 - area.y0) * 0.42 });
  function art(isle, dark) {
    const key = `${isle.name}|${isle.game}|${Math.round(R)}|${dark}|${dpr}`;
    if (!cache.has(key)) { if (cache.size > 8) cache.clear(); cache.set(key, paintIsland(isle, R, dpr, dark)); }
    return cache.get(key);
  }

  return {
    resize(nextArea, nextW, nextH, nextDpr) {
      area = nextArea; w = nextW; h = nextH; dpr = nextDpr;
      const H = area.y1 - area.y0, W = area.x1 - area.x0;
      R = Math.max(70, Math.min(220, H * 0.34, W * 0.3));
    },
    island: () => (travel ? travel.to : island),
    traveling: () => !!travel,
    // Part de la mer prise par l'île, à droite : les poissons nagent à côté (rien pendant la traversée).
    cut: () => (travel ? 0 : island ? R * 1.25 * Math.min(1, Math.max(0, performance.now() - arrivedAt) / 600) : 0),
    // Arriver directement (ouverture, changement de room).
    place(next) { travel = null; island = next; arrivedAt = 0; },
    // Partir vers une île (ou le large). Mouvement réduit : un fondu.
    go(next, reduced) {
      const from = travel ? travel.to : island;
      if ((from?.slot ?? null) === (next?.slot ?? null)) return false;
      travel = { t0: performance.now(), dur: reduced ? FADE_MS : TRAVEL_MS, from, to: next, S: (area.x1 - area.x0) + R * 3.2, pos: 0, reduced };
      return true;
    },
    // Avance le décor : renvoie de combien le monde a glissé vers la gauche cette image (les poissons suivent), et
    // l'île atteinte quand la traversée s'achève.
    update(dt, t, reduced) {
      let dx = 0, arrived;
      if (travel) {
        const p = Math.min(1, (t - travel.t0) / travel.dur);
        if (!travel.reduced) {
          const pos = travel.S * ease(p);
          dx = pos - travel.pos; travel.pos = pos;
        }
        if (p >= 1) { island = travel.to; arrived = { island }; travel = null; arrivedAt = t; }
      }
      speed = dt > 0 ? dx / dt : 0;
      if (reduced) return { dx, arrived };
      const move = dx + DRIFT * dt;
      const W = area.x1 - area.x0, H = area.y1 - area.y0;
      for (const s of streaks) {
        s.x -= move / Math.max(1, W);
        if (s.x < -0.3) { s.x += 1.5; s.y = Math.random(); }
      }
      for (const c of clouds) {
        c.x += (c.vx * dt - dx * 0.35) / Math.max(1, W); c.y += (c.vy * dt) / Math.max(1, H);
        if (c.x > 1.5) c.x = -0.5; if (c.x < -0.6) c.x = 1.4; if (c.y > 1.4) c.y = -0.4;
      }
      flotsam = flotsam.filter((f) => { f.x -= move * f.k; f.rot += f.spin * dt; return f.x > area.x0 - 60; });
      if (t >= nextFlotsam && flotsam.length < (travel ? 6 : 2)) {
        flotsam.push({ type: FLOTSAM[Math.floor(Math.random() * FLOTSAM.length)], x: area.x1 + 40,
          y: area.y0 + 20 + Math.random() * (H - 40), k: 0.8 + Math.random() * 0.5, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 0.4, phase: Math.random() * 6 });
        nextFlotsam = t + (travel ? 300 : 7000 + Math.random() * 7000);
      }
      return { dx, arrived };
    },
    speed: () => Math.abs(speed),
    // Sous les poissons : ombres des nuages, courants, objets à la dérive, îles.
    drawBack(ctx, t, { dark, night, reduced }) {
      const W = area.x1 - area.x0, H = area.y1 - area.y0;
      ctx.save();
      ctx.beginPath(); ctx.rect(area.x0, 0, W, h); ctx.clip();
      if (!dark && !night) {
        for (const c of clouds) {
          const x = area.x0 + c.x * W, y = area.y0 + c.y * H, r = c.r * Math.max(W, H);
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, "rgba(10, 40, 60, 0.09)"); g.addColorStop(1, "rgba(10, 40, 60, 0)");
          ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, r * 1.4, r, 0.3, 0, Math.PI * 2); ctx.fill();
        }
      }
      // Courants : des traits d'écume qui glissent (et s'étirent pendant la traversée).
      const stretch = Math.min(320, Math.abs(speed) * 0.35);
      ctx.lineCap = "round";
      for (const s of streaks) {
        const x = area.x0 + s.x * W, y = area.y0 + s.y * H;
        ctx.strokeStyle = `rgba(255, 255, 255, ${(dark || night ? 0.6 : 1) * Math.min(0.45, s.a + stretch / 900)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + s.len + stretch, y + Math.sin(s.y * 40) * 2); ctx.stroke();
      }
      for (const f of flotsam) drawFlotsam(ctx, f, t, dark || night);
      // Îles : celle qu'on quitte glisse vers la gauche, la suivante arrive de la droite.
      const a = anchor();
      const drawIsle = (isle, x, alpha) => {
        if (!isle || alpha <= 0) return;
        const pic = art(isle, dark || night), seed = pic.seed;
        ctx.save(); ctx.globalAlpha = alpha;
        islandPath(ctx, x, a.y, R, seed, 1.7);
        ctx.fillStyle = dark || night ? "rgba(60, 120, 140, 0.35)" : "rgba(189, 232, 223, 0.55)"; ctx.fill();
        for (let j = 0; j < 3; j++) { // écume autour de l'île
          const f = reduced ? 0.3 + j * 0.2 : (t / 3200 + j / 3 + seed) % 1;
          islandPath(ctx, x, a.y, R, seed, 1.03 + f * 0.55);
          ctx.strokeStyle = `rgba(255, 255, 255, ${(1 - f) * (dark || night ? 0.4 : 0.7)})`; ctx.lineWidth = 1.6; ctx.stroke();
        }
        ctx.drawImage(pic.canvas, x - pic.cx, a.y - pic.cy, pic.W, pic.H);
        // Ce qui bouge : drapeau, fumée du volcan, faisceau du phare la nuit.
        const fx = x - R * 0.72, fy = a.y - R * 0.5;
        ctx.strokeStyle = "#3b2a1a"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(fx, fy + 16); ctx.lineTo(fx, fy - 12); ctx.stroke();
        ctx.fillStyle = flagOf(isle); ctx.beginPath(); ctx.moveTo(fx, fy - 12);
        for (let q = 0; q <= 7; q++) ctx.lineTo(fx + q * 3, fy - 12 + (reduced ? 0 : Math.sin(t / 200 + q * 0.9 + seed) * 1.6));
        for (let q = 7; q >= 0; q--) ctx.lineTo(fx + q * 3, fy - 2 + (reduced ? 0 : Math.sin(t / 200 + q * 0.9 + seed) * 1.6));
        ctx.closePath(); ctx.fill(); ctx.strokeStyle = "rgba(20, 14, 6, 0.6)"; ctx.lineWidth = 1; ctx.stroke();
        if (pic.biome === "volcano") {
          const vx = x - R * 0.3, vy = a.y - R * 0.05;
          const glow = ctx.createRadialGradient(vx, vy, 0, vx, vy, R * 0.3);
          const pulse = reduced ? 0.6 : 0.5 + 0.3 * Math.sin(t / 400);
          glow.addColorStop(0, `rgba(255, 140, 50, ${pulse})`); glow.addColorStop(1, "rgba(255, 140, 50, 0)");
          ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(vx, vy, R * 0.3, 0, Math.PI * 2); ctx.fill();
          if (!reduced) {
            for (let k = 0; k < 5; k++) {
              const p = ((t / 2600) + k / 5) % 1;
              ctx.fillStyle = `rgba(${dark || night ? "120, 120, 130" : "90, 90, 95"}, ${0.35 * (1 - p)})`;
              ctx.beginPath(); ctx.arc(vx - p * R * 0.5 + Math.sin(p * 6 + k) * 6, vy - p * R * 0.35, 6 + p * 18, 0, Math.PI * 2); ctx.fill();
            }
          }
        }
        if (pic.biome === "rocky" && (dark || night)) {
          const lx = x - R * 0.7, ly = a.y - R * 0.2, reach = R * 2.6, ang = Math.PI + (reduced ? 0.3 : Math.sin(t / 1600) * 0.9);
          const beam = ctx.createRadialGradient(lx, ly, 0, lx, ly, reach);
          beam.addColorStop(0, "rgba(255, 232, 160, 0.35)"); beam.addColorStop(1, "rgba(255, 232, 160, 0)");
          ctx.fillStyle = beam; ctx.beginPath(); ctx.moveTo(lx, ly); ctx.arc(lx, ly, reach, ang - 0.15, ang + 0.15); ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      };
      if (travel) {
        const p = Math.min(1, (t - travel.t0) / travel.dur);
        if (travel.reduced) { drawIsle(travel.from, a.x, 1 - p); drawIsle(travel.to, a.x, p); }
        else { drawIsle(travel.from, a.x - travel.pos, 1); drawIsle(travel.to, a.x + travel.S - travel.pos, 1); }
      } else drawIsle(island, a.x, 1);
      ctx.restore();
    },
    // Par-dessus tout, pendant la traversée : traits de vitesse le long des bords et sillage du bateau.
    drawFront(ctx, t, { reduced }) {
      if (!travel || reduced) return;
      const v = Math.min(1, Math.abs(speed) / 900);
      if (v < 0.02) return;
      ctx.save(); ctx.lineCap = "round";
      for (let k = 0; k < 26; k++) {
        const band = k % 2 ? area.y1 - (k * 37 % 90) - 6 : area.y0 + (k * 53 % 90) + 6;
        const x = area.x1 - (((t * (1.2 + (k % 5) * 0.25)) + k * 211) % (area.x1 - area.x0 + 400)) + 200;
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.5 * v})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, band); ctx.lineTo(x + 60 + 160 * v, band); ctx.stroke();
      }
      // Sillage : deux lignes d'écume qui partent de l'étrave (en bas à droite, là où l'on tient la canne).
      const bx = area.x1 - 70, by = area.y1 + 30;
      for (const side of [-1, 1]) {
        const ex = bx - 420, ey = by - 60 + side * 70 * (0.5 + v);
        const g = ctx.createLinearGradient(bx, by, ex, ey);
        g.addColorStop(0, `rgba(255, 255, 255, ${0.65 * v})`); g.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.strokeStyle = g; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo(bx - 160, by - 50 + side * 20, ex, ey); ctx.stroke();
      }
      ctx.restore();
    },
  };
}

// Effets de bords d'écran : des teintes qui montent depuis les quatre bords. `layers` : [{ color: "r, g, b", alpha,
// size }] (size : part du plus petit côté de l'écran).
export function drawEdges(ctx, w, h, layers) {
  const m = Math.min(w, h);
  for (const { color, alpha, size } of layers) {
    if (alpha <= 0.005) continue;
    const T = m * size;
    const band = (x0, y0, x1, y1, rx, ry, rw, rh) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, `rgba(${color}, ${alpha})`); g.addColorStop(1, `rgba(${color}, 0)`);
      ctx.fillStyle = g; ctx.fillRect(rx, ry, rw, rh);
    };
    band(0, 0, 0, T, 0, 0, w, T);
    band(0, h, 0, h - T, 0, h - T, w, T);
    band(0, 0, T, 0, 0, 0, T, h);
    band(w, 0, w - T, 0, w - T, 0, T, h);
  }
}
