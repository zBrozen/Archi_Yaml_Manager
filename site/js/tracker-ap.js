// Suivi d'une partie Archipelago pour les trackers : le navigateur se connecte au serveur comme simple
// tracker (tag « Tracker ») sur le slot du joueur. Rien n'est envoyé au serveur.
// Une session garde l'état de la partie (slot_data, lieux faits, objets reçus) : le pack PopTracker
// (attachPack) et la logique du jeu (ut.js) s'y abonnent, même après coup, et reçoivent l'état déjà connu.
import { Client } from "../vendor/archipelago.js";

// « archipelago.gg:38281 » → wss://… ; ws:// pour un serveur lancé sur l'ordinateur.
export function serverUrl(address) {
  const text = address.trim();
  if (/^wss?:\/\//i.test(text)) return text;
  const local = /^(localhost|127\.|\[::1\])/i.test(text);
  return `${local ? "ws" : "wss"}://${text}`;
}

// Session : { game, slotName, slot, team, slotData, items: [NetworkItem], checked: Set, missing: Set, connected,
//   subscribe(listener), name(kind, id, game), player(slot, field), get(keys), notify(keys), disconnect() }.
// Événements : { type: "items", index, items }, { type: "checked", ids }, { type: "scouted", locations },
//   { type: "bounced", packet }, { type: "retrieved", keys }, { type: "setReply", packet }, { type: "closed" }.
export async function openSession({ address, slot, password }) {
  const client = new Client();
  const socket = client.socket;
  const listeners = new Set();
  let players = [];
  const slotGames = new Map();
  const session = {
    game: "", slotName: slot, slot: -1, team: -1, seed: "", slotData: {}, items: [], checked: new Set(), missing: new Set(), connected: false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    name: (kind, id, forGame) => (kind === "item"
      ? client.package.lookupItemName(forGame || session.game, id, true)
      : client.package.lookupLocationName(forGame || session.game, id, true)),
    player: (number, field) => (field === "game" ? slotGames.get(number) : players.find((p) => p.slot === number)?.alias),
    get: (keys) => keys.length && socket.send({ cmd: "Get", keys }),
    notify: (keys) => keys.length && socket.send({ cmd: "SetNotify", keys }),
    disconnect: () => socket.disconnect(),
  };
  const emit = (event) => { for (const listener of listeners) listener(event); };

  socket.on("connected", (packet) => {
    players = packet.players || [];
    for (const [number, info] of Object.entries(packet.slot_info || {})) slotGames.set(Number(number), info.game);
    Object.assign(session, {
      game: packet.slot_info[packet.slot]?.game || "", slotName: packet.slot_info[packet.slot]?.name || slot,
      slot: packet.slot, team: packet.team,
      seed: client.room?.seedName || "", slotData: packet.slot_data || {}, items: [],
      checked: new Set(packet.checked_locations || []), missing: new Set(packet.missing_locations || []), connected: true,
    });
  });
  socket.on("receivedItems", (packet) => {
    packet.items.forEach((item, i) => { session.items[packet.index + i] = item; });
    emit({ type: "items", index: packet.index, items: packet.items });
  });
  socket.on("roomUpdate", (packet) => {
    if (packet.players) players = packet.players;
    const ids = (packet.checked_locations || []).filter((id) => !session.checked.has(id));
    if (!ids.length) return;
    for (const id of ids) { session.checked.add(id); session.missing.delete(id); }
    emit({ type: "checked", ids });
  });
  socket.on("locationInfo", (packet) => emit({ type: "scouted", locations: packet.locations || [] }));
  socket.on("bounced", (packet) => emit({ type: "bounced", packet }));
  socket.on("retrieved", (packet) => emit({ type: "retrieved", keys: packet.keys || {} }));
  socket.on("setReply", (packet) => emit({ type: "setReply", packet }));
  socket.on("disconnected", () => { session.connected = false; emit({ type: "closed" }); });

  try {
    await client.login(serverUrl(address), slot, "", { password: password || "", tags: ["Tracker"], slotData: true });
  } catch (e) {
    socket.disconnect();
    throw new Error(/password/i.test(e.message) ? "Mot de passe incorrect." : /slot|name/i.test(e.message) ? `Joueur « ${slot} » inconnu dans cette partie.` : e.message);
  }
  return session;
}

// Transmet la partie à un pack PopTracker, dans l'ordre de PopTracker : remise à zéro (slot_data),
// lieux déjà faits, objets reçus, puis les nouveautés. Renvoie la fonction qui détache le pack.
export function attachPack(tracker, session) {
  const bridge = {
    get connected() { return session.connected; },
    get: session.get, notify: session.notify, player: session.player, name: session.name,
  };
  const item = (index, it) => tracker.apEvent("item", index, it.item, session.name("item", it.item), it.player);
  tracker.ap = bridge;
  tracker.apState({ player: session.slot, team: session.team, seed: session.seed, checked: [...session.checked], missing: [...session.missing] });
  tracker.apEvent("clear", session.slotData);
  for (const id of session.checked) tracker.apEvent("location", id, session.name("location", id));
  session.items.forEach((it, index) => it && item(index, it));
  const detach = session.subscribe((event) => {
    if (event.type === "items") event.items.forEach((it, i) => item(event.index + i, it));
    else if (event.type === "checked") {
      for (const id of event.ids) {
        tracker.apChecked(id);
        tracker.apEvent("location", id, session.name("location", id));
      }
    } else if (event.type === "scouted") {
      for (const it of event.locations) {
        tracker.apEvent("scout", it.location, session.name("location", it.location), it.item,
          session.name("item", it.item, session.player(it.player, "game")), it.player);
      }
    } else if (event.type === "bounced") tracker.apEvent("bounced", event.packet);
    else if (event.type === "retrieved") for (const [key, value] of Object.entries(event.keys)) tracker.apEvent("retrieved", key, value);
    else if (event.type === "setReply") tracker.apEvent("setreply", event.packet.key, event.packet.value, event.packet.original_value);
    else if (event.type === "closed") tracker.touch();
  });
  return () => {
    detach();
    if (tracker.ap === bridge) tracker.ap = null;
  };
}
