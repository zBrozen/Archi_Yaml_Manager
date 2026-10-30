// Mise en relation des joueurs qui partagent leur écran et des overlays, par le service des rooms
// (WebSocket, Durable Object ScreenRoom du dossier worker/). Partagé par screens.js (joueur) et overlay.js.
import { screensSocketUrl } from "./rooms-api.js";

// Serveurs STUN publics : suffisent pour la plupart des connexions. Sans relais TURN, certains réseaux
// (NAT strict, 4G, réseaux d'entreprise) ne passent pas : l'overlay l'indique sur l'écran du joueur.
export const ICE_SERVERS = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

// Connexion au service, reprise seule après une coupure. `onState(state, message)` : connecting, ready,
// retrying, ou refused (accès refusé par le service : pas de nouvelle tentative). Le message de bienvenue
// passe aussi par `onMessage` (il porte les dispositions pour un overlay).
export function signaling(code, hello, onMessage, onState) {
  let ws = null;
  let retry = null;
  let ping = null;
  let stopped = false;
  const open = () => {
    onState("connecting");
    ws = new WebSocket(screensSocketUrl(code));
    ws.onopen = () => {
      ws.send(JSON.stringify(hello));
      ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 25000);
    };
    ws.onmessage = (event) => {
      if (event.data === "pong") return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "error") { stopped = true; onState("refused", msg.message); return; }
      if (msg.type === "welcome") onState("ready");
      onMessage(msg);
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (stopped) return;
      onState("retrying");
      retry = setTimeout(open, 3000);
    };
  };
  open();
  return {
    send: (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
    close: () => { stopped = true; clearTimeout(retry); clearInterval(ping); ws?.close(); },
  };
}

// Messages traités un par un : une réponse doit être appliquée avant les candidats ICE qui la suivent.
export function serial() {
  let queue = Promise.resolve();
  return (fn) => { queue = queue.then(fn).catch((e) => console.warn("écrans :", e)); };
}
