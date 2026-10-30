// Suivi d'une partie Archipelago pour un tracker de pack PopTracker : le navigateur se connecte au
// serveur comme simple tracker (tag « Tracker ») sur le slot du joueur et transmet au pack ce que
// PopTracker lui transmettrait (objets reçus, lieux faits, données de la partie). Rien n'est envoyé.
import { Client } from "../vendor/archipelago.js";

// « archipelago.gg:38281 » → wss://… ; ws:// pour un serveur lancé sur l'ordinateur.
export function serverUrl(address) {
  const text = address.trim();
  if (/^wss?:\/\//i.test(text)) return text;
  const local = /^(localhost|127\.|\[::1\])/i.test(text);
  return `${local ? "ws" : "wss"}://${text}`;
}

export async function connectTracker(tracker, { address, slot, password }, onState) {
  const client = new Client();
  const socket = client.socket;
  let game = "";
  let players = [];
  const slotGames = new Map();
  const bridge = {
    connected: false,
    get: (keys) => keys.length && socket.send({ cmd: "Get", keys }),
    notify: (keys) => keys.length && socket.send({ cmd: "SetNotify", keys }),
    player: (number, field) => {
      if (field === "game") return slotGames.get(number);
      return players.find((p) => p.slot === number)?.alias;
    },
    name: (kind, id, forGame) => (kind === "item"
      ? client.package.lookupItemName(forGame || game, id, true)
      : client.package.lookupLocationName(forGame || game, id, true)),
    disconnect: () => socket.disconnect(),
  };

  // Ordre de PopTracker : remise à zéro (slot_data), lieux déjà faits, puis objets reçus.
  socket.on("connected", (packet) => {
    game = packet.slot_info[packet.slot]?.game || "";
    players = packet.players || [];
    for (const [number, info] of Object.entries(packet.slot_info || {})) slotGames.set(Number(number), info.game);
    bridge.connected = true;
    tracker.ap = bridge;
    tracker.apState({ player: packet.slot, team: packet.team, seed: client.room?.seedName || "", checked: packet.checked_locations, missing: packet.missing_locations });
    tracker.apEvent("clear", packet.slot_data || {});
    for (const id of packet.checked_locations || []) tracker.apEvent("location", id, bridge.name("location", id));
    onState?.("connected");
  });
  socket.on("receivedItems", (packet) => {
    packet.items.forEach((item, i) => {
      tracker.apEvent("item", packet.index + i, item.item, bridge.name("item", item.item), item.player);
    });
  });
  socket.on("roomUpdate", (packet) => {
    for (const id of packet.checked_locations || []) {
      tracker.apChecked(id);
      tracker.apEvent("location", id, bridge.name("location", id));
    }
    if (packet.players) players = packet.players;
  });
  socket.on("locationInfo", (packet) => {
    for (const item of packet.locations || []) {
      tracker.apEvent("scout", item.location, bridge.name("location", item.location), item.item,
        client.package.lookupItemName(slotGames.get(item.player) || game, item.item, true), item.player);
    }
  });
  socket.on("bounced", (packet) => tracker.apEvent("bounced", packet));
  socket.on("retrieved", (packet) => {
    for (const [key, value] of Object.entries(packet.keys || {})) tracker.apEvent("retrieved", key, value);
  });
  socket.on("setReply", (packet) => tracker.apEvent("setreply", packet.key, packet.value, packet.original_value));
  socket.on("disconnected", () => {
    bridge.connected = false;
    if (tracker.ap === bridge) tracker.ap = null;
    onState?.("closed");
  });

  try {
    await client.login(serverUrl(address), slot, "", { password: password || "", tags: ["Tracker"], slotData: true });
  } catch (e) {
    socket.disconnect();
    throw new Error(/password/i.test(e.message) ? "Mot de passe incorrect." : /slot|name/i.test(e.message) ? `Joueur « ${slot} » inconnu dans cette partie.` : e.message);
  }
  return bridge;
}
