// Fond du site : la mer vue du ciel, dessinée en direct sur un canvas fixé derrière la page. Les îles se placent dans
// les marges libres autour de la feuille (.sheet) ; une fenêtre étroite ne montre que l'eau. Le jour (thème clair) a
// ses mouettes et ses reflets de soleil, la nuit (thème sombre) son phare, ses reflets d'étoiles et la lanterne du
// navire ; le passage de l'un à l'autre est progressif.
// Décor seulement : rien n'y porte d'information. Figé si « réduire les animations » est demandé ou si le réglage
// « Fond animé » est coupé ; en pause quand l'onglet est caché (requestAnimationFrame).
import { html, useEffect, useRef } from "../vendor/preact-htm.js";

const DAY = {
  sea0: "#8fd0d8", sea1: "#3f95ad", shallow: "#bde8df", sand: "#ecd39a", sandEdge: "#c9a865", grass: "#6fae5a",
  grass2: "#4c8a41", foam: "#ffffff", grid: "#24505d", wave: "#2c6d80", route: "#b23a22", hull: "#6b4422",
  sail: "#fbf3e0", trunk: "#7a5230", palm: "#3f7d39",
};
const NIGHT = {
  sea0: "#163a52", sea1: "#08182a", shallow: "#1f4c5f", sand: "#8f7a55", sandEdge: "#5f5038", grass: "#2f5a3c",
  grass2: "#1f4029", foam: "#cfe6ff", grid: "#a9c8d8", wave: "#4a7f9c", route: "#ff8064", hull: "#3a2614",
  sail: "#d8cdb4", trunk: "#4a3320", palm: "#22462b",
};
const FLAGS = ["#e0a526", "#2f8f9d", "#5f9e4a", "#c8553d", "#8a6fc0", "#d77a2e"];
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const DAY_RGB = Object.fromEntries(Object.entries(DAY).map(([k, v]) => [k, rgb(v)]));
const NIGHT_RGB = Object.fromEntries(Object.entries(NIGHT).map(([k, v]) => [k, rgb(v)]));
const FRAME = 1000 / 30; // 30 images par seconde suffisent à un décor

const isNight = () => {
  const forced = document.documentElement.dataset.theme;
  return forced ? forced === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const quad = (a, b, c, t) => [
  (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0],
  (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1],
];
const bend = (a, b, k) => {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1];
  return [mx - dy * k, my + dx * k];
};

function createSea(canvas) {
  const ctx = canvas.getContext("2d");
  const glints = Array.from({ length: 60 }, () => ({ x: Math.random(), y: Math.random(), p: Math.random() * 6, s: 0.6 + Math.random() }));
  const waves = Array.from({ length: 50 }, () => ({ x: Math.random(), y: Math.random(), p: Math.random() * 6 }));
  let w = 0, h = 0, dpr = 1, k = isNight() ? 1 : 0, target = k, islands = [], route = [];
  let raf = 0, last = 0, lastFrame = 0, nextCoin = 0, coins = [], splashes = [], animate = false;
  const C = {};
  const mix = () => { for (const key in DAY_RGB) C[key] = DAY_RGB[key].map((v, i) => Math.round(v + (NIGHT_RGB[key][i] - v) * k)); };
  const col = (name, a = 1) => `rgba(${C[name][0]}, ${C[name][1]}, ${C[name][2]}, ${a})`;
  mix();

  // Îles dans les marges libres de part et d'autre de la feuille.
  function layout() {
    dpr = Math.min(1.25, devicePixelRatio || 1);
    w = innerWidth; h = innerHeight;
    // Redimensionner le canvas l'efface : seulement si la fenêtre a changé.
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const sheet = document.querySelector(".sheet")?.getBoundingClientRect();
    const side = document.querySelector(".site-side")?.getBoundingClientRect();
    const sideRight = side && side.height > h * 0.6 ? side.right : 0;
    islands = [];
    if (sheet) {
      const zones = [[sideRight, sheet.left], [sheet.right, w]].filter(([a, b]) => b - a >= 80);
      zones.forEach(([a, b], z) => {
        const r = Math.min((b - a) * 0.26, 62);
        const rows = z ? [0.22, 0.58, 0.88] : [0.38, 0.8];
        rows.forEach((y, i) => islands.push({ x: (a + b) / 2 + (i % 2 ? -1 : 1) * (b - a) * 0.12, y: h * y, r: r * (0.8 + ((i + z) % 3) * 0.14), seed: islands.length }));
      });
    }
    // Route du navire : d'île en île, en boucle.
    route = islands.length >= 2 ? [...islands.map((i) => [i.x, i.y]), [islands[0].x, islands[0].y]] : [];
    coins = coins.filter((c) => islands[c.a] && islands[c.b]);
    draw(performance.now());
  }

  function islandPath(cx, cy, r, seed, scale) {
    ctx.beginPath();
    for (let a = 0; a <= 56; a++) {
      const th = (a / 56) * Math.PI * 2;
      const rr = r * scale * (1 + 0.17 * Math.sin(2 * th + seed) + 0.1 * Math.sin(3 * th + seed * 2) + 0.05 * Math.sin(5 * th + seed * 3));
      const x = cx + Math.cos(th) * rr * 1.25, y = cy + Math.sin(th) * rr;
      if (a) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
  }

  function draw(t) {
    const s = t / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createRadialGradient(w * 0.7, h * 0.3, 0, w * 0.7, h * 0.3, Math.max(w, h) * 0.9);
    g.addColorStop(0, col("sea0")); g.addColorStop(1, col("sea1"));
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

    // Quadrillage de la carte
    ctx.strokeStyle = col("grid", 0.12); ctx.lineWidth = 1; ctx.setLineDash([2, 6]);
    for (let x = 60; x < w; x += 120) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 60; y < h; y += 120) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.setLineDash([]);

    if (k > 0.01) {
      const moon = ctx.createRadialGradient(w * 0.85, h * 0.05, 0, w * 0.85, h * 0.05, h * 0.7);
      moon.addColorStop(0, `rgba(255, 241, 196, ${0.16 * k})`); moon.addColorStop(1, "rgba(255, 241, 196, 0)");
      ctx.fillStyle = moon; ctx.fillRect(0, 0, w, h);
    }
    // Vaguelettes
    ctx.strokeStyle = col("wave", 0.45); ctx.lineWidth = 1.5; ctx.lineCap = "round";
    for (const v of waves) {
      const x = ((v.x * w + s * 6) % (w + 40)) - 20, y = v.y * h + Math.sin(s * 0.8 + v.p) * 2;
      ctx.beginPath(); ctx.arc(x, y, 6, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();
      ctx.beginPath(); ctx.arc(x + 11, y, 6, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();
    }
    // Reflets : soleil le jour, étoiles la nuit
    for (const gl of glints) {
      const tw = Math.max(0, Math.sin(s * 1.6 * gl.s + gl.p)), x = gl.x * w, y = gl.y * h;
      if (k < 0.99) {
        ctx.strokeStyle = `rgba(255, 255, 255, ${tw * 0.8 * (1 - k)})`; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x - 3 * tw, y); ctx.lineTo(x + 3 * tw, y); ctx.moveTo(x, y - 3 * tw); ctx.lineTo(x, y + 3 * tw); ctx.stroke();
      }
      if (k > 0.01) { ctx.fillStyle = `rgba(255, 244, 210, ${(0.25 + 0.6 * tw) * k})`; ctx.fillRect(x, y, 1.6, 1.6); }
    }

    if (route.length) {
      ctx.strokeStyle = col("route", 0.7); ctx.lineWidth = 2.5; ctx.setLineDash([7, 9]); ctx.lineDashOffset = -s * 10;
      ctx.beginPath(); ctx.moveTo(...route[0]);
      for (let i = 1; i < route.length; i++) { const c = bend(route[i - 1], route[i], 0.16); ctx.quadraticCurveTo(c[0], c[1], route[i][0], route[i][1]); }
      ctx.stroke(); ctx.setLineDash([]);
    }

    islands.forEach(({ x: cx, y: cy, r, seed }, i) => {
      islandPath(cx, cy, r, seed, 1.75); ctx.fillStyle = col("shallow", 0.55); ctx.fill();
      for (let j = 0; j < 3; j++) {
        const f = (s * 0.32 + j / 3 + seed * 0.13) % 1;
        islandPath(cx, cy, r, seed, 1.04 + f * 0.6);
        ctx.strokeStyle = col("foam", (1 - f) * 0.7); ctx.lineWidth = 1.6; ctx.stroke();
      }
      islandPath(cx, cy, r, seed, 1); ctx.fillStyle = col("sand"); ctx.fill();
      ctx.strokeStyle = col("sandEdge"); ctx.lineWidth = 1.5; ctx.stroke();
      islandPath(cx + r * 0.08, cy - r * 0.06, r, seed + 1, 0.66); ctx.fillStyle = col("grass"); ctx.fill();
      islandPath(cx + r * 0.12, cy - r * 0.1, r, seed + 2, 0.36); ctx.fillStyle = col("grass2"); ctx.fill();
      // palmier
      const tx = cx - r * 0.45, ty = cy + r * 0.2, sway = Math.sin(s * 1.2 + seed) * 0.08;
      ctx.strokeStyle = col("trunk"); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.quadraticCurveTo(tx - 3, ty - 10, tx + 2, ty - 18); ctx.stroke();
      ctx.fillStyle = col("palm");
      for (let l = 0; l < 5; l++) {
        const a = -Math.PI / 2 + (l - 2) * 0.75 + sway;
        ctx.beginPath(); ctx.ellipse(tx + 2 + Math.cos(a) * 7, ty - 18 + Math.sin(a) * 5, 8, 2.6, a, 0, Math.PI * 2); ctx.fill();
      }
      // drapeau
      const fx = cx + r * 0.25, fy = cy - r * 0.55;
      ctx.strokeStyle = col("hull"); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(fx, fy + 14); ctx.lineTo(fx, fy - 10); ctx.stroke();
      ctx.fillStyle = FLAGS[i % FLAGS.length]; ctx.beginPath(); ctx.moveTo(fx, fy - 10);
      for (let q = 0; q <= 6; q++) ctx.lineTo(fx + q * 2.6, fy - 10 + Math.sin(s * 5 + q * 0.9 + seed) * 1.3);
      for (let q = 6; q >= 0; q--) ctx.lineTo(fx + q * 2.6, fy - 2 + Math.sin(s * 5 + q * 0.9 + seed) * 1.3);
      ctx.closePath(); ctx.fill();
    });

    // Croix du trésor sur la dernière île, phare sur la première (allumé la nuit)
    if (islands.length) {
      const x = islands.at(-1), xx = x.x + x.r * 0.6, xy = x.y + x.r * 0.15, p = 1 + Math.sin(s * 3) * 0.08;
      ctx.strokeStyle = col("route"); ctx.lineWidth = 4; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(xx - 7 * p, xy - 7 * p); ctx.lineTo(xx + 7 * p, xy + 7 * p); ctx.moveTo(xx + 7 * p, xy - 7 * p); ctx.lineTo(xx - 7 * p, xy + 7 * p); ctx.stroke();
      const l = islands[0], lx = l.x - l.r * 0.3, ly = l.y + l.r * 0.1;
      if (k > 0.01) {
        const reach = Math.max(w, h) * 0.45, a = s * 0.7;
        const beam = ctx.createRadialGradient(lx, ly, 0, lx, ly, reach);
        beam.addColorStop(0, `rgba(255, 232, 160, ${0.38 * k})`); beam.addColorStop(1, "rgba(255, 232, 160, 0)");
        ctx.fillStyle = beam; ctx.beginPath(); ctx.moveTo(lx, ly); ctx.arc(lx, ly, reach, a - 0.16, a + 0.16); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = col("sail"); ctx.fillRect(lx - 3, ly - 2, 6, 10);
      ctx.fillStyle = k > 0.5 ? "#ffe8a0" : col("route"); ctx.beginPath(); ctx.arc(lx, ly - 4, 3.2, 0, Math.PI * 2); ctx.fill();
    }

    // Navire
    if (route.length) {
      const seg = route.length - 1, u = ((s * 0.02) % 1) * seg, si = Math.floor(u), f = u - si;
      const c = bend(route[si], route[si + 1], 0.16);
      const [bx, by] = quad(route[si], route[si + 1], c, f), [nx, ny] = quad(route[si], route[si + 1], c, Math.min(1, f + 0.01));
      ctx.save(); ctx.translate(bx, by); ctx.rotate(Math.atan2(ny - by, nx - bx));
      ctx.strokeStyle = col("foam", 0.55); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(-10, -3); ctx.lineTo(-26, -9); ctx.moveTo(-10, 3); ctx.lineTo(-26, 9); ctx.stroke();
      ctx.fillStyle = col("hull"); ctx.beginPath(); ctx.moveTo(14, 0); ctx.quadraticCurveTo(4, -7, -10, -5); ctx.lineTo(-10, 5); ctx.quadraticCurveTo(4, 7, 14, 0); ctx.fill();
      ctx.fillStyle = col("sail"); ctx.beginPath(); ctx.ellipse(1, 0, 2.6, 9, 0, 0, Math.PI * 2); ctx.fill();
      if (k > 0.01) {
        const glow = ctx.createRadialGradient(10, 0, 0, 10, 0, 16);
        glow.addColorStop(0, `rgba(255, 210, 120, ${0.7 * k})`); glow.addColorStop(1, "rgba(255, 210, 120, 0)");
        ctx.fillStyle = glow; ctx.fillRect(-6, -16, 32, 32);
      }
      ctx.restore();
    }

    // Mouettes (jour)
    if (k < 0.99) {
      ctx.strokeStyle = `rgba(250, 250, 245, ${0.9 * (1 - k)})`; ctx.lineWidth = 1.8;
      for (let m = 0; m < 3; m++) {
        const gx = ((s * (18 + m * 5) + m * 260) % (w + 120)) - 60, gy = h * (0.18 + m * 0.24) + Math.sin(s * 1.3 + m) * 10;
        const flap = 3 + Math.sin(s * 8 + m) * 2.5;
        ctx.beginPath(); ctx.moveTo(gx - 8, gy - flap); ctx.quadraticCurveTo(gx - 4, gy - flap - 2, gx, gy);
        ctx.quadraticCurveTo(gx + 4, gy - flap - 2, gx + 8, gy - flap); ctx.stroke();
      }
    }

    // Pièces d'or d'une île à l'autre (comme les objets d'une partie), et leur éclaboussure
    coins = coins.filter((coin) => {
      const p = (t - coin.start) / coin.dur, a = islands[coin.a], b = islands[coin.b];
      if (!a || !b) return false;
      const from = [a.x, a.y], to = [b.x, b.y], top = [(a.x + b.x) / 2, Math.min(a.y, b.y) - 90];
      if (p >= 1) { splashes.push({ x: b.x, y: b.y, start: t }); return false; }
      for (let d = 1; d <= 6; d++) {
        const [x, y] = quad(from, to, top, Math.max(0, ease(Math.max(0, p)) - d * 0.04));
        ctx.fillStyle = `rgba(242, 184, 75, ${0.7 - d * 0.1})`; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
      }
      const [x, y] = quad(from, to, top, ease(Math.max(0, p)));
      ctx.fillStyle = "#f2b84b"; ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#8a5a0a"; ctx.lineWidth = 1.5; ctx.stroke();
      return true;
    });
    splashes = splashes.filter((sp) => {
      const p = (t - sp.start) / 800;
      if (p >= 1) return false;
      ctx.strokeStyle = col("foam", 1 - p); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(sp.x, sp.y, 10 + p * 46, 6 + p * 28, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(sp.x, sp.y, 4 + p * 26, 2 + p * 15, 0, 0, Math.PI * 2); ctx.stroke();
      return true;
    });
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (t - lastFrame < FRAME) return;
    lastFrame = t;
    const dt = Math.min(0.1, (t - (last || t)) / 1000);
    last = t;
    if (k !== target) { k += (target - k) * Math.min(1, dt * 7); if (Math.abs(target - k) < 0.003) k = target; mix(); }
    if (islands.length >= 2 && t > nextCoin) {
      const a = Math.floor(Math.random() * islands.length);
      coins.push({ a, b: (a + 1 + Math.floor(Math.random() * (islands.length - 1))) % islands.length, start: t, dur: 1500 });
      nextCoin = t + 3500 + Math.random() * 2500;
    }
    draw(t);
  }

  return {
    layout,
    setNight(night) {
      target = night ? 1 : 0;
      if (!animate) { k = target; mix(); draw(performance.now()); }
    },
    setAnimate(on) {
      animate = on;
      cancelAnimationFrame(raf);
      if (on) { last = 0; raf = requestAnimationFrame(loop); } else { k = target; mix(); draw(performance.now()); }
    },
    stop() { cancelAnimationFrame(raf); },
  };
}

// `motion` : réglage « Fond animé » du menu.
export function Sea({ motion }) {
  const ref = useRef(null);
  const sea = useRef(null);
  useEffect(() => {
    const s = createSea(ref.current);
    sea.current = s;
    s.layout();
    // La feuille et le menu bougent avec la fenêtre (et le menu se replie en fenêtre étroite).
    let pending = 0;
    const relayout = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(s.layout); };
    const observer = new ResizeObserver(relayout);
    observer.observe(document.body);
    addEventListener("resize", relayout);
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const theme = () => s.setNight(isNight());
    const themes = new MutationObserver(theme);
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    scheme.addEventListener("change", theme);
    return () => {
      s.stop(); observer.disconnect(); themes.disconnect();
      removeEventListener("resize", relayout); scheme.removeEventListener("change", theme);
    };
  }, []);
  useEffect(() => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => sea.current?.setAnimate(motion && !reduce.matches);
    apply();
    reduce.addEventListener("change", apply);
    return () => reduce.removeEventListener("change", apply);
  }, [motion]);
  return html`<canvas class="sea" ref=${ref} aria-hidden="true"></canvas>`;
}
