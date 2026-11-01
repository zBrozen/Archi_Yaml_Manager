// Onglet « Écrans » de la room : chaque joueur partage la fenêtre de son jeu, et chaque streamer (l'hôte ou un joueur)
// crée ses liens d'overlay pour la source « Navigateur » de son logiciel de stream (grille automatique, ou dispositions
// de l'éditeur de l'hôte, overlay-editor.js). L'overlay est dans overlay.js.
//
// Les images vont directement du navigateur du joueur à l'overlay (WebRTC). Le service des rooms ne fait que
// les mettre en relation (screens-net.js) : le joueur envoie une offre à chaque overlay qui lui demande son flux,
// l'overlay répond.
import { html, useState, useEffect, useRef } from "../vendor/preact-htm.js";
import { CopyButton, plural, useAction, useSetting } from "./ui.js";
import { api, overlayLink, saveAccess, savedAccess } from "./rooms-api.js";
import { ICE_SERVERS, serial, signaling } from "./screens-net.js";
import { CONSOLE_PLACES, FEED_CHECKS, ITEM_FILTERS, PROGRESS_MODES, ROTATIONS, SCREEN_MODES, spaceOf, spaceUses } from "./overlay-layout.js";
import { SpaceLayouts } from "./overlay-editor.js";

// Qualité du partage, choisie par chaque joueur. `bitrate` : débit maximum envoyé à chaque overlay, en bit/s.
// La connexion du joueur (envoi), son processeur (encodage) et la connexion du streamer (réception de tous les
// écrans) limitent ce qui passe réellement : le navigateur baisse la qualité de lui-même s'il le faut.
// `start` et `floor` (kbit/s) : débit de départ et minimum imposés à Chrome. Sans eux, il démarre vers 0,3 Mb/s
// et met des dizaines de secondes à monter ; le minimum n'est imposé qu'aux qualités choisies pour une bonne connexion.
const QUALITIES = {
  legere: { label: "Légère", detail: "720p, 30 images/s, 1,5 Mb/s", width: 1280, height: 720, fps: 30, bitrate: 1_500_000, start: 800, floor: 0 },
  normale: { label: "Normale", detail: "720p, 30 images/s, 3 Mb/s", width: 1280, height: 720, fps: 30, bitrate: 3_000_000, start: 1500, floor: 0 },
  haute: { label: "Haute", detail: "1080p, 30 images/s, 6 Mb/s", width: 1920, height: 1080, fps: 30, bitrate: 6_000_000, start: 4000, floor: 1500 },
  max: { label: "Maximale", detail: "1080p, 60 images/s, 12 Mb/s", width: 1920, height: 1080, fps: 60, bitrate: 12_000_000, start: 8000, floor: 3000 },
};
// Ce que le navigateur sacrifie quand le débit manque. `hint` : nature de l'image, pour l'encodeur.
const PRIORITIES = {
  equilibre: { label: "Équilibre", detail: "baisse un peu la netteté et la fluidité", hint: "motion", degradation: "balanced" },
  nettete: { label: "Netteté", detail: "garde la définition, quitte à saccader (jeux lents, pixel art)", hint: "detail", degradation: "maintain-resolution" },
  fluidite: { label: "Fluidité", detail: "garde les images par seconde, quitte à flouter (jeux rapides)", hint: "motion", degradation: "maintain-framerate" },
};
const DEFAULT_QUALITY = "normale";
const DEFAULT_PRIORITY = "equilibre";
const qualityOf = (name) => QUALITIES[name] || QUALITIES[DEFAULT_QUALITY];
const priorityOf = (name) => PRIORITIES[name] || PRIORITIES[DEFAULT_PRIORITY];
const captureConstraints = (q) => ({ width: { max: q.width }, height: { max: q.height }, frameRate: { ideal: q.fps, max: q.fps } });
// Une caméra (celle d'OBS surtout) choisit sinon une petite définition : on lui demande celle de la qualité.
const cameraConstraints = (q) => ({ width: { ideal: q.width, max: q.width }, height: { ideal: q.height, max: q.height }, frameRate: { ideal: q.fps, max: q.fps } });
const isCamera = (track) => !track.getSettings().displaySurface; // une capture d'écran indique sa surface, pas une caméra

// Son : stéréo et débit d'Opus (par défaut, Chrome l'envoie en mono vers 32 kbit/s, trop peu pour la musique d'un jeu).
const AUDIO_BITRATE = 128_000;
const OPUS_EXTRA = `stereo=1;sprop-stereo=1;maxaveragebitrate=${AUDIO_BITRATE}`;

// Débits de la qualité ajoutés aux codecs vidéo de la réponse de l'overlay (paramètres x-google-*, lus par Chrome
// pour l'envoi, ignorés par les autres navigateurs), et stéréo du son. Un codec sans ligne a=fmtp (VP8) en reçoit une.
function withBitrates(sdp, quality) {
  const extra = [`x-google-start-bitrate=${quality.start}`, `x-google-max-bitrate=${quality.bitrate / 1000}`]
    .concat(quality.floor ? [`x-google-min-bitrate=${quality.floor}`] : []).join(";");
  const lines = sdp.split("\r\n");
  const codecs = new Set();
  const opus = new Set();
  let video = false;
  for (const line of lines) {
    if (line.startsWith("m=")) video = line.startsWith("m=video");
    const rtpmap = /^a=rtpmap:(\d+) ([\w-]+)\//.exec(line);
    if (rtpmap && video && !/^(rtx|red|ulpfec|flexfec)/i.test(rtpmap[2])) codecs.add(rtpmap[1]);
    if (rtpmap && !video && /^opus$/i.test(rtpmap[2])) opus.add(rtpmap[1]);
  }
  const hasFmtp = new Set(lines.map((line) => /^a=fmtp:(\d+) /.exec(line)?.[1]).filter((pt) => codecs.has(pt)));
  return lines.flatMap((line) => {
    const fmtp = /^a=fmtp:(\d+) /.exec(line);
    if (fmtp && opus.has(fmtp[1])) return [`${line.replace(/;?(stereo|sprop-stereo|maxaveragebitrate)=[^;]*/g, "")};${OPUS_EXTRA}`];
    if (fmtp && codecs.has(fmtp[1])) return [`${line};${extra}`];
    const rtpmap = /^a=rtpmap:(\d+) /.exec(line);
    if (rtpmap && codecs.has(rtpmap[1]) && !hasFmtp.has(rtpmap[1])) return [line, `a=fmtp:${rtpmap[1]} ${extra}`];
    return [line];
  }).join("\r\n");
}

// Codec encodé par la carte graphique, s'il y en a un pour cette qualité : meilleure image à débit égal, et le
// processeur reste libre pour le jeu. Proposé en premier ; l'overlay en prend un autre s'il ne sait pas le lire.
// Chaque variante proposée par le navigateur est essayée (profils H.264 surtout : une carte graphique peut encoder
// le profil « high » sans le « baseline »), sinon une variante par codec.
const HARDWARE_CODECS = [
  { mimeType: "video/AV1" },
  { mimeType: "video/VP9" },
  { mimeType: "video/H264", sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f" },
];
const hardwareChoices = new Map();

function codecCandidates() {
  const offered = RTCRtpSender.getCapabilities?.("video")?.codecs || [];
  return HARDWARE_CODECS.flatMap((fallback) => {
    const variants = offered.filter((c) => c.mimeType === fallback.mimeType);
    if (!variants.length) return [fallback];
    const seen = new Set();
    return variants.filter((c) => !seen.has(c.sdpFmtpLine || "") && seen.add(c.sdpFmtpLine || ""));
  });
}

function hardwareCodec(quality) {
  if (!hardwareChoices.has(quality)) {
    hardwareChoices.set(quality, (async () => {
      if (!navigator.mediaCapabilities?.encodingInfo) return null;
      for (const codec of codecCandidates()) {
        const contentType = codec.sdpFmtpLine ? `${codec.mimeType};${codec.sdpFmtpLine}` : codec.mimeType;
        try {
          const info = await navigator.mediaCapabilities.encodingInfo({
            type: "webrtc",
            video: { contentType, width: quality.width, height: quality.height, bitrate: quality.bitrate, framerate: quality.fps },
          });
          if (info.supported && info.powerEfficient) return codec;
        } catch { /* codec inconnu de ce navigateur */ }
      }
      return null;
    })());
  }
  return hardwareChoices.get(quality);
}

// Ordre des codecs proposés à l'overlay : la variante trouvée, puis les autres du même codec, puis le reste.
function preferCodec(transceiver, codec) {
  if (!codec || !transceiver.setCodecPreferences) return;
  const rank = (c) => (c.mimeType !== codec.mimeType ? 2 : (c.sdpFmtpLine || "") === (codec.sdpFmtpLine || "") ? 0 : 1);
  for (const source of [RTCRtpSender, RTCRtpReceiver]) {
    const codecs = source.getCapabilities?.("video")?.codecs || [];
    if (!codecs.some((c) => c.mimeType === codec.mimeType)) continue;
    try {
      transceiver.setCodecPreferences([0, 1, 2].flatMap((r) => codecs.filter((c) => rank(c) === r)));
      return;
    } catch { /* liste refusée : essai avec l'autre */ }
  }
}

const MAX_VIEWERS = 3; // overlays auxquels un joueur envoie son image ; les suivants reçoivent « busy »

// --- Son envoyé avec l'image -------------------------------------------------------------
// Le son de l'ordinateur (capture d'écran du navigateur) et un micro ou une entrée audio (câble audio virtuel…)
// passent par un mélangeur : la piste envoyée aux overlays ne change jamais, on y branche et débranche les sources
// sans refaire les connexions. Sans source, elle envoie du silence et l'overlay n'affiche pas de haut-parleur.

class AudioMix {
  constructor() {
    this.ctx = new AudioContext();
    this.ctx.resume?.().catch(() => {});
    this.out = this.ctx.createMediaStreamDestination();
    this.sum = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.sum.connect(this.out);
    this.sum.connect(this.analyser);
    this.samples = new Float32Array(this.analyser.fftSize);
    this.inputs = new Map(); // "pc" ou "micro" → { track, source, gain }
    this.onChange = null;
  }

  get track() { return this.out.stream.getAudioTracks()[0]; }

  get active() { return this.inputs.size > 0; }

  has(name) { return this.inputs.has(name); }

  // `volume` : 1 = tel quel. La piste remplacée est arrêtée.
  set(name, track, volume = 1) {
    this.remove(name, false);
    const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(this.sum);
    this.inputs.set(name, { track, source, gain });
    // Partage du son arrêté depuis le bandeau du navigateur, ou micro débranché.
    track.addEventListener("ended", () => { if (this.inputs.get(name)?.track === track) this.remove(name); });
    this.onChange?.();
  }

  volume(name, volume) {
    const input = this.inputs.get(name);
    if (input) input.gain.gain.value = volume;
  }

  remove(name, notify = true) {
    const input = this.inputs.get(name);
    if (!input) return;
    this.inputs.delete(name);
    input.source.disconnect();
    input.gain.disconnect();
    input.track.stop();
    if (notify) this.onChange?.();
  }

  // Niveau du son envoyé, de 0 à 1 (crête des derniers instants).
  level() {
    this.analyser.getFloatTimeDomainData(this.samples);
    let peak = 0;
    for (const v of this.samples) peak = Math.max(peak, Math.abs(v));
    return Math.min(1, peak);
  }

  stop() {
    this.onChange = null;
    for (const name of [...this.inputs.keys()]) this.remove(name);
    this.ctx.close().catch(() => {});
  }
}

// Le son capté tel quel, en stéréo : sans les traitements prévus pour la voix, qui abîment la musique d'un jeu.
const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
// Son de l'ordinateur demandé à la capture d'écran. `windowAudio` (Chrome récent) : le son est aussi proposé pour
// une fenêtre ; les navigateurs qui ne le connaissent pas l'ignorent.
const DISPLAY_AUDIO = { audio: RAW_AUDIO, systemAudio: "include", windowAudio: "system", suppressLocalAudioPlayback: false };

// Son de l'ordinateur seul (partage par la caméra d'OBS, ou son oublié à la capture de la fenêtre) : une capture de
// l'écran entier dont on ne garde que le son.
async function capturePcAudio() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "monitor" }, ...DISPLAY_AUDIO, selfBrowserSurface: "exclude" });
  for (const track of stream.getVideoTracks()) track.stop();
  const [track] = stream.getAudioTracks();
  if (!track) throw Object.assign(new Error("son non partagé"), { name: "NoAudioError" });
  return track;
}

const listMics = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");

// `clean` : réduction du bruit et de l'écho, pour un vrai micro (pas pour un câble audio virtuel qui porte le jeu).
async function captureMic(deviceId, clean) {
  const processing = clean ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : RAW_AUDIO;
  const device = deviceId ? { deviceId: { exact: deviceId } } : {};
  try {
    return (await navigator.mediaDevices.getUserMedia({ video: false, audio: { ...processing, ...device } })).getAudioTracks()[0];
  } catch (e) {
    if (e.name !== "OverconstrainedError" || !deviceId) throw e;
    // Entrée mémorisée débranchée : celle par défaut.
    return (await navigator.mediaDevices.getUserMedia({ video: false, audio: processing })).getAudioTracks()[0];
  }
}

// --- Son du jeu seul, par un câble audio virtuel ----------------------------------------------
// Le navigateur ne sait capter que le son de tout l'ordinateur (Discord, musique…). Pour le jeu seul, le joueur envoie
// la sortie du jeu dans un câble audio virtuel (VB-Cable…) depuis le mélangeur de volume de Windows, et le site lit
// l'autre bout du câble comme une entrée audio. Il le rejoue sur la sortie habituelle (sinon le joueur n'entend plus
// son jeu) et le mesure, dès que l'option est choisie, avant même le partage.

// Bout « enregistrement » des câbles connus, et leur bout « lecture » (sortie par défaut à ne pas prendre : boucle).
const CABLE_INPUT = /cable output|vb-audio|voicemeeter out|virtual audio cable|line \d+ \(virtual|blackhole/i;
const CABLE_OUTPUT = /cable input|vb-audio|voicemeeter in|virtual audio cable|blackhole/i;
const findCable = (inputs) => inputs.find((d) => CABLE_INPUT.test(d.label) && d.deviceId !== "default" && d.deviceId !== "communications") || null;
const VB_CABLE_URL = "https://vb-audio.com/Cable/";
const WINDOWS_MIXER = "ms-settings:apps-volume"; // Paramètres de Windows → Son → Mélangeur de volume
const WINDOWS_SOUND = "ms-settings:sound"; // Paramètres de Windows → Son (sortie et entrée par défaut)
const isAlias = (d) => d.deviceId === "default" || d.deviceId === "communications";

// Sorties et entrées par défaut de Windows (l'installation de VB-Cable les met souvent sur le câble), et sorties où
// rejouer le son du jeu (tout sauf le câble).
async function audioDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const label = (kind) => all.find((d) => d.kind === kind && d.deviceId === "default")?.label || "";
  return {
    outputs: all.filter((d) => d.kind === "audiooutput" && d.label && !isAlias(d) && !CABLE_OUTPUT.test(d.label)),
    cableOutput: CABLE_OUTPUT.test(label("audiooutput")),
    cableInput: CABLE_INPUT.test(label("audioinput")),
  };
}

// Gardé hors des composants, comme le partage : le joueur continue d'entendre son jeu sur les autres pages du site.
class GameSound {
  constructor() {
    this.track = null;
    this.deviceId = null;
    this.ctx = null;
    this.analyser = null;
    this.samples = null;
    this.monitor = null; // gain de l'écoute sur ce PC
    this.sink = ""; // sortie de l'écoute ("" : celle par défaut de Windows)
    this.loop = false; // la sortie de l'écoute est le câble : pas d'écoute, elle reviendrait dans le câble
    this.heard = false; // du son est déjà passé par le câble
    this.listeners = new Set();
  }

  changed() { for (const listener of this.listeners) listener(); }

  get running() { return !!this.track && this.track.readyState === "live"; }

  // `listen` : rejouer le son sur `sink` (voir setOutput).
  async start(deviceId, listen, sink) {
    if (this.running && this.deviceId === deviceId) return this.setOutput(listen, sink);
    this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { ...RAW_AUDIO, deviceId: { exact: deviceId } } });
    this.track = stream.getAudioTracks()[0];
    this.deviceId = deviceId;
    this.heard = false;
    this.track.addEventListener("ended", () => { this.stop(); });
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx.resume?.().catch(() => {});
    const source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.samples = new Float32Array(this.analyser.fftSize);
    this.monitor = this.ctx.createGain();
    source.connect(this.analyser);
    this.monitor.gain.value = 0;
    source.connect(this.monitor).connect(this.ctx.destination);
    await this.setOutput(listen, sink);
  }

  // Écoute sur `sink` (identifiant d'une sortie, "" : celle par défaut de Windows). Le casque peut être choisi même
  // si Windows a pris le câble comme sortie par défaut ; les navigateurs sans choix de sortie gardent celle par défaut.
  async setOutput(listen, sink = "") {
    if (!this.ctx) return;
    let target = sink;
    if (this.ctx.setSinkId) {
      try { await this.ctx.setSinkId(sink); } catch { target = ""; }
    } else target = "";
    this.sink = target;
    const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
    this.loop = CABLE_OUTPUT.test(outputs.find((d) => d.deviceId === (target || "default"))?.label || "");
    if (this.monitor) this.monitor.gain.value = listen && !this.loop ? 1 : 0;
    this.changed();
  }

  level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let peak = 0;
    for (const v of this.samples) peak = Math.max(peak, Math.abs(v));
    if (peak > 0.01 && !this.heard) { this.heard = true; this.changed(); }
    return Math.min(1, peak);
  }

  // Copie de la piste pour le mélangeur du partage : arrêter le partage ne coupe pas l'écoute.
  clone() { return this.running ? this.track.clone() : null; }

  stop() {
    if (!this.track && !this.ctx) return;
    this.track?.stop();
    this.ctx?.close().catch(() => {});
    Object.assign(this, { track: null, deviceId: null, ctx: null, analyser: null, monitor: null, sink: "", loop: false });
    this.changed();
  }
}
const gameSound = new GameSound();

const AUDIO_ERRORS = {
  NoAudioError: "Le son de l'ordinateur n'a pas été partagé : dans la fenêtre de choix, prenez l'écran entier et cochez « Partager aussi l'audio du système ».",
  NotAllowedError: "Accès au micro refusé : autorisez le micro pour ce site (icône à gauche de l'adresse), puis réessayez.",
  NotReadableError: "Le micro ne répond pas : il est peut-être utilisé par une autre application.",
  NotFoundError: "Aucun micro ni entrée audio trouvé sur cet ordinateur.",
};

// --- Joueur : partage de la fenêtre du jeu ---------------------------------------------

// `game` : jeu affiché à côté du nom sur les overlays ("" : tous ses jeux, "aucun" : aucun).
// `mix` : son envoyé (AudioMix), arrêté avec le partage.
class Broadcast {
  constructor(code, token, stream, mix, quality, priority, onChange, game = "") {
    this.stream = stream;
    this.mix = mix;
    this.quality = quality;
    this.priority = priority;
    this.peers = new Map(); // overlay → RTCPeerConnection
    this.state = "connecting";
    this.message = null;
    this.onChange = onChange;
    const queue = serial();
    // Présentation renvoyée à chaque reconnexion : elle garde le dernier jeu choisi.
    this.hello = { type: "hello", role: "player", token, game, audio: mix.active };
    mix.onChange = () => this.audioChanged();
    this.signal = signaling(code, this.hello, (msg) => queue(() => this.receive(msg)), (state, message) => {
      this.state = state;
      this.message = message || null;
      // Après une coupure, les overlays redemandent le flux : les anciennes connexions ne servent plus.
      if (state !== "ready") this.closePeers();
      if (state === "refused") this.stopTracks();
      this.changed();
    });
  }

  setGame(game) {
    this.hello.game = game;
    this.signal.send({ type: "game", game });
  }

  // Les overlays n'affichent le haut-parleur que si le joueur envoie vraiment du son.
  audioChanged() {
    if (this.hello.audio !== this.mix.active) {
      this.hello.audio = this.mix.active;
      this.signal.send({ type: "audio", audio: this.mix.active });
    }
    this.changed();
  }

  get viewers() { return [...this.peers.values()].filter((pc) => pc.connectionState === "connected").length; }

  changed() { this.onChange(this); }

  async receive(msg) {
    if (msg.type === "left") return this.drop(msg.id);
    if (msg.type !== "signal" || !msg.data) return;
    const { from, data } = msg;
    if (data.type === "request") return this.offer(from);
    const pc = this.peers.get(from);
    if (!pc) return;
    if (data.type === "answer") await pc.setRemoteDescription({ type: "answer", sdp: withBitrates(data.sdp, this.quality) });
    else if (data.type === "ice") await pc.addIceCandidate(data.candidate);
    else if (data.type === "bye") this.drop(from);
  }

  async offer(to) {
    const codec = await hardwareCodec(this.quality);
    this.drop(to);
    if (this.peers.size >= MAX_VIEWERS) return this.signal.send({ type: "signal", to, data: { type: "busy" } });
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peers.set(to, pc);
    pc.onicecandidate = (e) => e.candidate && this.signal.send({ type: "signal", to, data: { type: "ice", candidate: e.candidate.toJSON() } });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.drop(to);
      this.changed();
    };
    const transceivers = this.stream.getVideoTracks().map((track) => pc.addTransceiver(track, {
      direction: "sendonly",
      streams: [this.stream],
      sendEncodings: [{ maxBitrate: this.quality.bitrate, maxFramerate: this.quality.fps }],
    }));
    for (const transceiver of transceivers) preferCodec(transceiver, codec);
    pc.addTransceiver(this.mix.track, { direction: "sendonly", streams: [this.stream], sendEncodings: [{ maxBitrate: AUDIO_BITRATE }] });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await Promise.all(transceivers.map((transceiver) => this.tune(transceiver.sender)));
    this.signal.send({ type: "signal", to, data: { type: "offer", sdp: offer.sdp } });
  }

  // Débit, images par seconde et priorité d'un envoi. Le choix de priorité n'est pas connu de tous les
  // navigateurs : sans lui, le reste s'applique quand même.
  async tune(sender) {
    const apply = async (withPriority) => {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      for (const encoding of params.encodings) Object.assign(encoding, { maxBitrate: this.quality.bitrate, maxFramerate: this.quality.fps });
      if (withPriority) params.degradationPreference = this.priority.degradation;
      await sender.setParameters(params);
    };
    try { await apply(true); } catch {
      try { await apply(false); } catch (e) { console.warn("écrans :", e); }
    }
  }

  // Nouvelle qualité, appliquée tout de suite à la capture et à chaque overlay. Les débits de départ et le codec
  // se négocient à la connexion : chaque overlay reçoit alors une nouvelle offre (l'image se fige un instant).
  async configure(quality, priority) {
    const renegotiate = quality !== this.quality;
    this.quality = quality;
    this.priority = priority;
    const [track] = this.stream.getVideoTracks();
    if (track) {
      track.contentHint = priority.hint;
      const constraints = isCamera(track) ? cameraConstraints(quality) : captureConstraints(quality);
      try { await track.applyConstraints(constraints); } catch (e) { console.warn("écrans :", e); }
    }
    if (renegotiate) {
      for (const id of [...this.peers.keys()]) await this.offer(id);
      return;
    }
    const senders = [...this.peers.values()].flatMap((pc) => pc.getSenders().filter((s) => s.track?.kind === "video"));
    await Promise.all(senders.map((sender) => this.tune(sender)));
  }

  // Ce qui part réellement vers le premier overlay connecté, et ce qui le limite : débit que le navigateur
  // s'autorise vers l'overlay, latence et pertes (réseau), encodeur (processeur ou carte graphique).
  async sending(previous) {
    const pc = [...this.peers.values()].find((p) => p.connectionState === "connected");
    if (!pc) return null;
    const stats = await pc.getStats();
    let out = null;
    let remote = null;
    let pair = null;
    for (const s of stats.values()) {
      if (s.type === "outbound-rtp" && s.kind === "video") out = s;
      else if (s.type === "remote-inbound-rtp" && s.kind === "video") remote = s;
      else if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
      else if (!pair && s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s;
    }
    if (!out) return null;
    const same = previous?.id === out.id;
    const elapsed = same ? out.timestamp - previous.at : 0;
    return {
      id: out.id,
      width: out.frameWidth,
      height: out.frameHeight,
      fps: out.framesPerSecond,
      // Images fournies par la capture (fenêtre ou caméra), avant l'encodeur.
      captured: stats.get(out.mediaSourceId)?.framesPerSecond ?? null,
      bytes: out.bytesSent,
      at: out.timestamp,
      bitrate: elapsed > 0 && out.bytesSent >= previous.bytes ? ((out.bytesSent - previous.bytes) * 8000) / elapsed : null,
      limit: out.qualityLimitationReason,
      codec: stats.get(out.codecId)?.mimeType?.replace(/^video\//, "") || null,
      hardware: out.powerEfficientEncoder ?? null,
      available: pair?.availableOutgoingBitrate ?? null,
      rtt: pair?.currentRoundTripTime ?? null,
      lost: remote?.fractionLost ?? null,
    };
  }

  // Autre fenêtre : la nouvelle image remplace l'ancienne sans refaire les connexions.
  replace(stream) {
    const [track] = stream.getVideoTracks();
    for (const pc of this.peers.values()) {
      for (const sender of pc.getSenders()) if (sender.track?.kind === "video") sender.replaceTrack(track);
    }
    this.stopTracks();
    this.stream = stream;
    this.changed();
  }

  drop(id) {
    const pc = this.peers.get(id);
    if (!pc) return;
    this.peers.delete(id);
    pc.close();
    this.changed();
  }

  closePeers() {
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
  }

  stopTracks() {
    for (const track of this.stream.getTracks()) track.stop();
  }

  stop() {
    this.signal.close();
    this.closePeers();
    this.stopTracks();
    this.mix.stop();
  }
}

// Partage en cours, gardé hors des composants : aller sur une autre page du site (tracker…) ne le coupe pas,
// seule la fermeture de l'onglet ou « Arrêter le partage » le fait. Un seul à la fois, pour une room.
const sharing = { broadcast: null, code: null, refused: null, listeners: new Set() };

function shareChanged() {
  for (const listener of sharing.listeners) listener();
}

function setSharing(broadcast, code) {
  sharing.broadcast = broadcast;
  sharing.code = code;
  shareChanged();
}

function onBroadcast(broadcast) {
  if (broadcast !== sharing.broadcast) return;
  if (broadcast.state === "refused") {
    sharing.refused = { code: sharing.code, message: broadcast.message };
    setSharing(null, null);
  } else shareChanged();
}

export function stopSharing() {
  sharing.broadcast?.stop();
  setSharing(null, null);
}

function useSharing() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    sharing.listeners.add(listener);
    return () => sharing.listeners.delete(listener);
  }, []);
  return sharing;
}

// Bandeau des autres pages pendant un partage : `code` est la room affichée, où le partage se voit déjà.
export function SharingBanner({ code }) {
  const { broadcast, code: shared } = useSharing();
  if (!broadcast || shared === code) return null;
  const viewers = broadcast.state === "ready" ? broadcast.viewers : 0;
  return html`<div class="notice ok row sharing-banner" role="status">
    <span><strong>● Partage d'écran en cours</strong> (room ${shared})${viewers ? `, affiché dans ${plural(viewers, "overlay")}` : ""}. Gardez cet onglet ouvert.</span>
    <span class="spacer"></span>
    <a class="button ghost small" href=${`#/room/${shared}`}>Voir</a>
    <button type="button" class="ghost small" onClick=${stopSharing}>Arrêter le partage</button>
  </div>`;
}

// `audio` : demande aussi le son de l'ordinateur (case à cocher de la fenêtre de choix).
async function captureWindow(quality, priority, audio) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { ...captureConstraints(quality), displaySurface: "window" }, // propose d'abord les fenêtres, pas l'écran entier
    ...(audio ? DISPLAY_AUDIO : { audio: false }),
    selfBrowserSurface: "exclude",
  });
  const [track] = stream.getVideoTracks();
  if (track) track.contentHint = priority.hint;
  return stream;
}

// Partage par une caméra : surtout la caméra virtuelle d'OBS, qui reprend une « Capture de jeu » et passe donc
// là où le navigateur ne voit rien (jeux en plein écran exclusif). Sans caméra choisie, celle d'OBS est prise
// si elle existe. Les noms des caméras ne sont connus qu'après la première autorisation.
const isObsCamera = (device) => /obs/i.test(device.label);
const listCameras = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");

async function captureCamera(quality, priority, deviceId) {
  const open = async (id) => {
    const device = id ? { deviceId: { exact: id } } : {};
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...cameraConstraints(quality), ...device } });
    } catch (e) {
      // Définition ou images par seconde refusées par la caméra : on prend ce qu'elle donne.
      if (e.name !== "OverconstrainedError" || e.constraint === "deviceId") throw e;
      return navigator.mediaDevices.getUserMedia({ audio: false, video: id ? device : true });
    }
  };
  const obs = async () => (await listCameras()).find(isObsCamera)?.deviceId || null;
  // Essais : la caméra choisie (sinon celle d'OBS si son nom est déjà connu), puis celle d'OBS, puis celle par
  // défaut. Une webcam occupée ou une caméra mémorisée disparue n'empêche donc pas d'ouvrir celle d'OBS, dont le
  // nom n'apparaît qu'une fois la caméra autorisée.
  const tried = new Set();
  let failure = null;
  for (const pick of [async () => deviceId || obs(), obs, async () => null]) {
    const id = await pick();
    if (tried.has(id)) continue;
    tried.add(id);
    try {
      let stream = await open(id);
      const target = deviceId ? null : await obs();
      if (target && stream.getVideoTracks()[0]?.getSettings().deviceId !== target) {
        try {
          const better = await open(target);
          for (const track of stream.getTracks()) track.stop();
          stream = better;
        } catch { /* on garde la caméra déjà ouverte */ }
      }
      const [track] = stream.getVideoTracks();
      if (track) track.contentHint = priority.hint;
      return stream;
    } catch (e) {
      if (e.name === "NotAllowedError") throw e;
      failure ??= e;
    }
  }
  throw failure;
}

const CAMERA_ERRORS = {
  NotAllowedError: "Accès à la caméra refusé : autorisez la caméra pour ce site (icône à gauche de l'adresse), puis réessayez.",
  NotReadableError: "La caméra ne répond pas : elle est peut-être utilisée par une autre application, ou la caméra virtuelle d'OBS est arrêtée.",
};

// Le navigateur ne voit pas la caméra d'OBS : ce qu'il voit, et ce qui l'en empêche le plus souvent.
function CameraHelp({ error, seen }) {
  const names = seen.map((d) => d.label).filter(Boolean);
  return html`<div class="notice error full">
    <strong>Le navigateur ne trouve pas la caméra virtuelle d'OBS.</strong>
    ${" "}${seen.length === 0 ? "Il ne voit aucune caméra."
      : names.length ? `Caméras qu'il voit : ${names.join(", ")}.` : `Il voit ${seen.length} caméra(s), dont il ne donne le nom qu'après autorisation.`}
    <ul>
      <li>Dans OBS, la caméra virtuelle est bien démarrée (le bouton affiche « Arrêter la caméra virtuelle »).</li>
      <li>Fermez complètement le navigateur (toutes ses fenêtres) puis rouvrez-le : s'il était ouvert pendant l'installation
        d'OBS, il ne voit pas encore sa caméra.</li>
      <li>Windows autorise la caméra aux applications de bureau : Paramètres → Confidentialité et sécurité → Caméra.</li>
      <li>Avec un OBS « portable » (sans installation), la caméra virtuelle doit être installée à part : lancez une fois
        OBS en administrateur et démarrez la caméra virtuelle.</li>
      <li>Pour vérifier, dans Chrome ou Edge : Paramètres → Confidentialité et sécurité → Paramètres des sites → Caméra.
        La liste en haut montre les caméras que le navigateur voit ; « OBS Virtual Camera » doit y être.</li>
    </ul>
    ${error?.message && html`<span class="hint">Erreur du navigateur : ${error.name} (${error.message}).</span>`}
  </div>`;
}

const SOURCES = {
  window: { label: "La fenêtre du jeu", text: "Le plus simple : choisissez la fenêtre du jeu ou de l'émulateur." },
  camera: { label: "La caméra virtuelle d'OBS", text: "Si vous streamez déjà avec OBS, ou si le jeu est en plein écran." },
};

const decimal = (n) => n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
const LOSSY = 0.02; // au-delà de 2 % de paquets perdus, la limite vient vraiment du réseau

// Pourquoi l'image est réduite. Le débit « autorisé » est l'estimation du navigateur vers l'overlay, pas la
// capacité de la connexion : il la monte tant que rien ne se perd, et une image immobile la fait peu monter.
function limitText(sent, quality) {
  if (sent.limit === "cpu") {
    return `Image réduite : l'encodage est trop lourd pour l'ordinateur.${sent.hardware === false ? ` Il se fait par le processeur (aucun codec de la carte graphique n'a été trouvé pour cette qualité) :
      vérifiez que « Utiliser l'accélération graphique » est activé dans les paramètres du navigateur (Système).
      Chrome et Edge encodent plus souvent par la carte graphique que Firefox.` : ""}
      Choisissez une qualité plus basse, ou moins d'images par seconde.`;
  }
  if (sent.limit !== "bandwidth") return null;
  if (sent.available && sent.available >= quality.bitrate * 0.95) {
    return `Image réduite pour tenir dans le débit de la qualité choisie (${decimal(quality.bitrate / 1e6)} Mb/s) :
      choisissez une qualité plus haute si votre connexion et celle du streamer le permettent.`;
  }
  const allowed = sent.available ? ` (${decimal(sent.available / 1e6)} Mb/s pour l'instant)` : "";
  return sent.lost != null && sent.lost > LOSSY
    ? `Image réduite au débit que le navigateur s'autorise vers l'overlay${allowed}, et des paquets se perdent :
      la limite vient du réseau entre vous et le streamer. Choisissez une qualité plus basse.`
    : `Image réduite au débit que le navigateur s'autorise vers l'overlay${allowed}. Il l'augmente tant que rien
      ne se perd ; une image presque immobile (menu, pause, autre fenêtre) le fait monter moins vite.`;
}

// Peu d'images envoyées sans que l'encodeur soit en cause : la capture n'en fournit pas plus.
function captureText(sent, quality, camera) {
  if (sent.limit === "cpu" || sent.captured == null || sent.captured >= quality.fps * 0.75) return null;
  const fps = `${Math.round(sent.captured)} images/s`;
  return camera
    ? `La caméra ne fournit que ${fps} : c'est elle qui limite, pas l'encodage. Avec la caméra virtuelle d'OBS,
      vérifiez ses images par seconde (Paramètres → Vidéo) et que l'aperçu d'OBS est fluide.`
    : `La capture de la fenêtre ne fournit que ${fps} : c'est elle qui limite, pas l'encodage. Une image immobile
      en donne moins, c'est normal ; si le jeu bouge, essayez l'écran entier ou la caméra virtuelle d'OBS.`;
}

function SentInfo({ sent, quality, camera }) {
  if (!sent?.width) return null;
  const encoder = sent.codec && `${sent.codec}${sent.hardware === true ? " (carte graphique)" : sent.hardware === false ? " (processeur)" : ""}`;
  const capture = captureText(sent, quality, camera);
  const network = [
    sent.available != null && `le navigateur s'autorise ${decimal(sent.available / 1e6)} Mb/s`,
    sent.rtt != null && `latence ${Math.round(sent.rtt * 1000)} ms`,
    sent.lost != null && `pertes ${decimal(sent.lost * 100)} %`,
  ].filter(Boolean);
  const limit = limitText(sent, quality);
  // Mesures repliées : seule une image réduite mérite d'être signalée d'emblée.
  return html`<div class="stack full">
    ${limit && html`<div class="notice warn full">${limit}</div>`}
    <details class="more">
      <summary>Ce qui part vers l'overlay</summary>
      <p class="hint" role="status">${sent.width} × ${sent.height}${sent.fps ? `, ${Math.round(sent.fps)} images/s` : ""}${sent.captured != null ? ` (${Math.round(sent.captured)} capturées)` : ""}${sent.bitrate != null ? `, ${decimal(sent.bitrate / 1e6)} Mb/s` : ""}${encoder ? `, encodé en ${encoder}` : ""}.</p>
      ${network.length > 0 && html`<p class="hint">Réseau : ${network.join(" · ")}.</p>`}
      ${capture && html`<p class="hint">${capture}</p>`}
    </details>
  </div>`;
}

const audioText = (e) => AUDIO_ERRORS[e?.name] || `Son impossible à capter : ${e?.message || e}`;
const cancelled = (e) => e?.name === "NotAllowedError" || e?.name === "AbortError"; // fenêtre de choix fermée

// Niveau d'un son (`source.level()` : mélangeur du partage ou câble du jeu), pour vérifier que le bon son est capté.
function SoundMeter({ source: mix, label = "Son envoyé" }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let shown = 0;
    const timer = setInterval(() => { shown = Math.max(mix.level(), shown * 0.8); setLevel(shown); }, 100);
    return () => clearInterval(timer);
  }, [mix]);
  const percent = Math.round(Math.sqrt(level) * 100); // échelle proche de l'oreille
  return html`<div class="sound-meter full">
    <span>${label}</span>
    <span class="sound-bar" role="meter" aria-label=${`Niveau : ${label.toLowerCase()}`} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${percent}>
      <span style=${{ width: `${percent}%` }}></span></span>
    <span class="hint">${level < 0.005 ? "silence" : "son capté"}</span>
  </div>`;
}

// Son du jeu envoyé avec l'image.
const GAME_AUDIO = {
  aucun: { label: "Pas de son", text: "Seulement l'image." },
  jeu: { label: "Le son du jeu seul", text: "Sans Discord ni musique. Un câble audio virtuel gratuit, installé une fois : le site vous guide." },
  pc: { label: "Tout le son de l'ordinateur", text: "Sans installation, mais Discord, la musique et les notifications partent aussi." },
};

function useGameSound() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    gameSound.listeners.add(listener);
    return () => gameSound.listeners.delete(listener);
  }, []);
}

const Step = ({ done, title, children }) => html`<li class=${done ? "done" : ""}>
  <strong>${title}</strong>${" "}<span class=${`badge ${done ? "ok" : ""}`}>${done ? "✓ Fait" : "À faire"}</span>
  ${children && html`<div class="stack">${children}</div>`}
</li>`;

// Les trois étapes du son du jeu seul, cochées au fur et à mesure : câble trouvé, son du jeu reçu, écoute réglée.
// `permitted` : le micro est autorisé (sinon le navigateur cache le nom des entrées, et donc le câble).
// Installation du câble : affichée tant qu'il manque, puis repliée (pour la revoir ou l'expliquer à un autre joueur).
const CableInstall = () => html`<ol class="tips hint">
  <li>Téléchargez <a href=${VB_CABLE_URL} target="_blank" rel="noopener">VB-Cable</a> (gratuit, Windows ; sur Mac : BlackHole).</li>
  <li>Décompressez le fichier, clic droit sur <strong>VBCABLE_Setup_x64</strong> → <strong>Exécuter en tant
    qu'administrateur</strong> → <strong>Install Driver</strong>.</li>
  <li>Redémarrez l'ordinateur et revenez ici : le site trouvera le câble tout seul.</li>
</ol>`;

// Choisir les applications entendues dans le stream : le tutoriel reste affiché une fois le câble installé, puisqu'il
// sert à chaque partie (et pour chaque nouvelle application).
const CableRouting = () => html`<div class="stack">
  <span class="hint">Seules les applications envoyées dans le câble s'entendent dans le stream ; les autres restent sur votre
    casque, comme d'habitude.</span>
  <ol class="tips hint">
    <li>Lancez le jeu (ou l'émulateur) et faites-lui jouer du son : Windows ne liste que les applications qui en jouent.</li>
    <li>Ouvrez le <a href=${WINDOWS_MIXER}>mélangeur de volume de Windows</a>. Le navigateur demande s'il peut ouvrir
      Paramètres : acceptez. Sinon : clic droit sur le haut-parleur de la barre des tâches → <strong>Ouvrir le mélangeur
      de volume</strong> (Windows 11) ou <strong>Ouvrir les paramètres de son</strong> → <strong>Volume des applications
      et préférences des périphériques</strong> (Windows 10).</li>
    <li>À la ligne de l'application (Windows 11 : cliquez dessus pour la déplier), réglez <strong>Périphérique de
      sortie</strong> sur <strong>CABLE Input</strong>.</li>
    <li>Recommencez pour chaque application à faire entendre : le jeu et son émulateur, un client Archipelago qui joue des
      sons, la musique si vous voulez la partager…</li>
  </ol>
  <span class="hint">À ne pas mettre dans le câble : Discord (sinon les voix partent dans le stream) et le navigateur où
    cette page est ouverte (le site y renvoie le son du jeu : il tournerait en boucle). Pour un jeu dans le navigateur,
    ouvrez-le dans un autre navigateur (Edge, Firefox…) et mettez celui-là dans le câble.</span>
  <span class="hint">Windows retient le choix pour chaque application. Pour arrêter, remettez-la sur <strong>Par défaut</strong>
    dans le mélangeur (ou <strong>Réinitialiser</strong> en bas de la page, pour toutes).</span>
</div>`;

// Remettre son casque (ou ses haut-parleurs) comme sortie par défaut de Windows.
const DefaultOutputHelp = () => html`<ul class="tips">
  <li><strong>Windows 11</strong> : cliquez sur l'icône du haut-parleur en bas à droite de l'écran, puis sur la flèche${" "}
    <strong>›</strong> à droite de la barre de volume, et choisissez votre casque ou vos haut-parleurs (pas « CABLE Input »).</li>
  <li><strong>Windows 10</strong> : cliquez sur l'icône du haut-parleur en bas à droite, puis sur le nom de l'appareil
    au-dessus du volume, et choisissez votre casque ou vos haut-parleurs.</li>
  <li>Ou : <a href=${WINDOWS_SOUND}>Paramètres de son de Windows</a> → <strong>Sortie</strong>.</li>
</ul>`;

// Windows a pris le câble comme haut-parleur ou micro par défaut (fréquent juste après l'installation de VB-Cable) :
// tout le son de l'ordinateur part dans le stream et le joueur n'entend plus rien, ou ses amis entendent le jeu au
// lieu de sa voix. Affiché quel que soit le son choisi.
function CableDefaults({ devices }) {
  if (!devices.cableOutput && !devices.cableInput) return null;
  return html`<div class="notice warn full stack cable-defaults" role="alert">
    ${devices.cableOutput && html`<div class="stack">
      <strong>Windows a pris le câble comme haut-parleur par défaut.</strong>
      <span>Ça arrive souvent juste après l'installation de VB-Cable. Résultat : vous n'entendez plus rien dans votre casque,
        et tout le son de l'ordinateur (Discord compris) part dans le câble, donc dans le stream. Remettez votre casque :</span>
      <${DefaultOutputHelp} />
    </div>`}
    ${devices.cableInput && html`<div class="stack">
      <strong>Le câble est aussi votre micro par défaut.</strong>
      <span>Discord et les autres applications entendraient le jeu au lieu de votre voix. Dans les${" "}
        <a href=${WINDOWS_SOUND}>paramètres de son de Windows</a> → <strong>Entrée</strong>, choisissez votre vrai micro
        (pas « CABLE Output »).</span>
    </div>`}
    <span class="hint">Ce message disparaît tout seul une fois corrigé.</span>
  </div>`;
}

// Tout remettre comme avant l'installation : affiché en clair dans le guide, et replié quand le joueur n'utilise plus le câble.
const CableUndo = () => html`<ol class="tips">
  <li><strong>Haut-parleur par défaut</strong> : votre casque ou vos haut-parleurs, pas « CABLE Input ».<${DefaultOutputHelp} /></li>
  <li><strong>Micro par défaut</strong> : votre micro, pas « CABLE Output » (<a href=${WINDOWS_SOUND}>paramètres de son</a>${" "}
    → <strong>Entrée</strong>).</li>
  <li><strong>Applications</strong> : dans le <a href=${WINDOWS_MIXER}>mélangeur de volume</a>, bouton${" "}
    <strong>Réinitialiser</strong> en bas de la page (toutes les applications reviennent sur « Par défaut »).</li>
  <li><strong>Désinstaller le câble (facultatif)</strong> : relancez <strong>VBCABLE_Setup_x64</strong> en administrateur
    → <strong>Remove Driver</strong>, puis redémarrez l'ordinateur.</li>
</ol>`;

function CableGuide({ cable, permitted, onReveal, listen, onListen, outputs, sink, onSink }) {
  const running = gameSound.running;
  return html`<ol class="cable-steps">
    <${Step} done=${!!cable} title="Installer le câble audio virtuel (une seule fois)">
      ${cable ? html`<span class="hint">Câble trouvé : ${cable.label}.</span>
          <details class="more"><summary>Revoir l'installation</summary><${CableInstall} /></details>`
        : !permitted ? html`<span class="hint">Le site cherche le câble parmi les entrées audio de l'ordinateur : le navigateur
            demande d'abord l'autorisation du micro (rien n'est enregistré).</span>
          <button type="button" class="small mic-reveal" onClick=${onReveal}>Chercher le câble</button>
          <details class="more"><summary>Comment l'installer</summary><${CableInstall} /></details>`
        : html`<${CableInstall} />`}
    </${Step}>
    <${Step} done=${gameSound.heard} title="Choisir les applications entendues dans le stream">
      <${CableRouting} />
      ${running && !gameSound.heard && html`<span class="hint"><strong>En attente du son :</strong> faites du bruit dans le jeu.
        Toujours rien ? Vérifiez que sa sortie est bien CABLE Input dans le mélangeur.</span>`}
    </${Step}>
    <${Step} done=${running && gameSound.heard} title="Vérifier et entendre le jeu">
      ${running && html`<${SoundMeter} source=${gameSound} label="Son du jeu" />`}
      <label class="check"><input type="checkbox" checked=${listen} onChange=${(e) => onListen(e.target.checked)} />
        Entendre le jeu sur ce PC (le site vous le renvoie tant que cet onglet est ouvert)</label>
      ${listen && outputs.length > 0 && !!window.AudioContext?.prototype.setSinkId && html`<div class="fields"><label><span>Entendre le jeu sur</span>
        <select value=${sink} onChange=${(e) => onSink(e.target.value)}>
          <option value="">La sortie par défaut de Windows</option>
          ${outputs.map((d) => html`<option value=${d.deviceId}>${d.label}</option>`)}
        </select></label></div>`}
      ${listen && gameSound.loop && html`<div class="notice warn full">Le site ne peut pas vous renvoyer le son du jeu : la
        sortie choisie est le câble lui-même, il y reviendrait. Choisissez votre casque ci-dessus, ou remettez-le comme
        sortie par défaut de Windows.</div>`}
    </${Step}>
    <li class="cable-undo">
      <strong>Revenir à un son comme avant</strong>
      <span class="hint">Pour arrêter de partager le son du jeu, ou si quelque chose ne marche plus :</span>
      <${CableUndo} />
    </li>
  </ol>`;
}

const Volume = ({ value, disabled, onChange, label = "Volume" }) => html`<label><span>${label} : ${value} %</span>
  <input type="range" min="0" max="200" step="5" value=${value} disabled=${disabled} onInput=${(e) => onChange(Number(e.target.value))} /></label>`;

// `games` : jeux des YAML du joueur, dont il choisit celui affiché à côté de son nom.
function ShareScreen({ room, games = [] }) {
  useSharing();
  const live = () => (sharing.code === room.code ? sharing.broadcast : null);
  const current = live();
  const view = current && { state: current.state, viewers: current.viewers };
  const [ownError, setError] = useState(null);
  const error = ownError || (sharing.refused?.code === room.code ? sharing.refused.message : null);
  const [busy, setBusy] = useState(false);
  const [qualityName, setQualityName] = useSetting("screenQuality", DEFAULT_QUALITY);
  const [priorityName, setPriorityName] = useSetting("screenPriority", DEFAULT_PRIORITY);
  const [sourceName, setSourceName] = useSetting("screenSource", "window");
  const [cameraId, setCameraId] = useSetting("screenCamera", "");
  const [gameName, setGameName] = useSetting(`screenGame:${room.code}`, "");
  const shownGame = gameName === "aucun" || games.includes(gameName) ? gameName : "";
  const pickGame = (next) => { setGameName(next); live()?.setGame(next); };
  const [cameras, setCameras] = useState([]); // caméras dont le nom est connu (après une première autorisation)
  // Son : celui du jeu (voir GAME_AUDIO) et/ou un micro (ou une entrée audio), chacun avec son volume en %.
  const [gameAudioName, setGameAudio] = useSetting("screenGameAudio", "aucun");
  const gameAudio = gameAudioName in GAME_AUDIO ? gameAudioName : "aucun";
  const pcOn = gameAudio === "pc";
  const cableOn = gameAudio === "jeu";
  const [listen, setListen] = useSetting("screenGameListen", true);
  const [sinkName, setSink] = useSetting("screenGameSink", "");
  const [devices, setDevices] = useState({ outputs: [], cableOutput: false, cableInput: false });
  // Sortie de l'écoute : celle choisie, sinon celle de Windows, sauf si c'est le câble (le premier casque ou
  // haut-parleur trouvé, pour que le joueur entende son jeu en attendant de remettre son casque par défaut).
  const sink = devices.outputs.some((d) => d.deviceId === sinkName) ? sinkName
    : devices.cableOutput ? devices.outputs[0]?.deviceId || "" : "";
  const [gameVolume, setGameVolume] = useSetting("screenVolumeGame", 100);
  const [micOn, setMicOn] = useSetting("screenAudioMic", false);
  const [micId, setMicId] = useSetting("screenAudioDevice", "");
  const [micClean, setMicClean] = useSetting("screenAudioClean", true);
  const [pcVolume, setPcVolume] = useSetting("screenVolumePc", 100);
  const [micVolume, setMicVolume] = useSetting("screenVolumeMic", 100);
  const [mics, setMics] = useState([]);
  const [soundError, setSoundError] = useState(null);
  const mix = current?.mix || null;
  useGameSound();
  const cable = findCable(mics);
  const [sent, setSent] = useState(null);
  const preview = useRef(null);
  const windowSupported = !!navigator.mediaDevices?.getDisplayMedia;
  const cameraSupported = !!navigator.mediaDevices?.getUserMedia;
  // Sur téléphone, pas de partage de fenêtre : seulement une caméra.
  const source = windowSupported && sourceName in SOURCES ? sourceName : cameraSupported ? "camera" : "window";
  const quality = qualityOf(qualityName);
  const priority = priorityOf(priorityName);

  const stop = () => {
    if (live()) stopSharing();
  };
  useEffect(() => {
    const stream = live()?.stream || null;
    if (preview.current && preview.current.srcObject !== stream) preview.current.srcObject = stream;
  });

  // Liste des caméras et des entrées audio, tenue à jour quand on en branche ou qu'OBS démarre sa caméra virtuelle.
  const refreshCameras = () => {
    listCameras().then((list) => setCameras(list.filter((d) => d.label))).catch(() => {});
    listMics().then((list) => setMics(list.filter((d) => d.label && !isAlias(d)))).catch(() => {});
    audioDevices().then(setDevices).catch(() => {});
  };
  useEffect(() => {
    if (!cameraSupported) return undefined;
    refreshCameras();
    navigator.mediaDevices.addEventListener?.("devicechange", refreshCameras);
    // Retour sur la page après un réglage de Windows (sortie ou entrée par défaut changée).
    window.addEventListener("focus", refreshCameras);
    // Micro autorisé depuis l'icône à gauche de l'adresse : les noms des entrées deviennent lisibles.
    let permission = null;
    navigator.permissions?.query({ name: "microphone" }).then((p) => { permission = p; p.onchange = refreshCameras; }).catch(() => {});
    return () => {
      navigator.mediaDevices.removeEventListener?.("devicechange", refreshCameras);
      window.removeEventListener("focus", refreshCameras);
      if (permission) permission.onchange = null;
    };
  }, []);
  // Le navigateur ne donne le nom des entrées audio qu'une fois le micro autorisé : on le demande, sans rien garder.
  const revealMics = async () => {
    setSoundError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      for (const track of stream.getTracks()) track.stop();
      refreshCameras();
    } catch (e) {
      setSoundError(audioText(e));
    }
  };

  // Son du jeu seul : le câble est lu dès qu'il est trouvé (écoute et mesure avant le partage), et sa copie rejoint
  // le partage en cours.
  useEffect(() => {
    if (!cableOn || !cable) return;
    gameSound.start(cable.deviceId, listen, sink).catch((e) => setSoundError(audioText(e)));
  }, [cableOn, cable?.deviceId]);
  useEffect(() => { if (gameSound.running) gameSound.setOutput(listen, sink); }, [listen, sink]);
  useEffect(() => {
    if (cableOn && gameSound.running && mix && !mix.has("jeu")) mix.set("jeu", gameSound.clone(), gameVolume / 100);
  });

  // Mesure de ce qui part, tant qu'un overlay affiche le jeu.
  const watched = !!view?.viewers;
  useEffect(() => {
    if (!watched) { setSent(null); return undefined; }
    let alive = true;
    let previous = null;
    const read = async () => {
      const next = await live()?.sending(previous).catch(() => null);
      if (!alive) return;
      previous = next;
      setSent(next);
    };
    read();
    const timer = setInterval(read, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [watched]);

  const choose = (nextQuality, nextPriority) => {
    setQualityName(nextQuality);
    setPriorityName(nextPriority);
    live()?.configure(qualityOf(nextQuality), priorityOf(nextPriority));
  };

  // Micro ou entrée audio branché sur le mélangeur (remplace le précédent).
  const openMic = async (mixer, id = micId, clean = micClean) => {
    setSoundError(null);
    try {
      mixer.set("micro", await captureMic(id, clean), micVolume / 100);
      refreshCameras();
    } catch (e) {
      setSoundError(audioText(e));
    }
  };
  // Son de l'ordinateur ajouté au partage en cours : sa propre fenêtre de choix, ouverte par ce clic.
  const addPc = async () => {
    setSoundError(null);
    try {
      const track = await capturePcAudio();
      if (live()) live().mix.set("pc", track, pcVolume / 100);
      else track.stop();
    } catch (e) {
      if (!cancelled(e)) setSoundError(audioText(e));
    }
  };
  // Pendant le partage, chaque réglage du son s'applique tout de suite (le son du jeu seul : voir les effets plus haut).
  const pickGameAudio = (next) => {
    setGameAudio(next);
    setSoundError(null);
    if (next !== "jeu") gameSound.stop();
    if (!live()) return;
    if (next !== "pc") live().mix.remove("pc");
    if (next !== "jeu") live().mix.remove("jeu");
    if (next === "pc") addPc();
  };
  const toggleMic = (on) => {
    setMicOn(on);
    if (!live()) return;
    if (on) openMic(live().mix);
    else live().mix.remove("micro");
  };
  const pickMic = (id, clean = micClean) => {
    setMicId(id);
    setMicClean(clean);
    if (live() && micOn) openMic(live().mix, id, clean);
  };
  const changeVolume = (name, value) => {
    ({ pc: setPcVolume, jeu: setGameVolume, micro: setMicVolume })[name](value);
    live()?.mix.volume(name, value / 100);
  };

  // Démarre le partage, ou remplace l'image en cours (autre fenêtre, autre caméra, autre source).
  const share = async (nextSource = source, nextCamera = cameraId) => {
    setError(null);
    setSoundError(null);
    sharing.refused = null;
    setBusy(true);
    let pcTrack = null; // son de l'ordinateur capté par ce clic, pas encore branché
    try {
      // Avec la caméra d'OBS, le son de l'ordinateur a sa propre fenêtre de choix : ouverte d'abord, tant que le
      // clic l'autorise encore. Fermée sans rien choisir, le partage démarre sans ce son.
      if (nextSource === "camera" && pcOn && !live()?.mix.has("pc")) {
        pcTrack = await capturePcAudio().catch((e) => { if (!cancelled(e)) setSoundError(audioText(e)); return null; });
      }
      const stream = nextSource === "camera"
        ? await captureCamera(quality, priority, nextCamera)
        : await captureWindow(quality, priority, pcOn);
      // Le son de la capture va au mélangeur : `stream` ne garde que l'image.
      for (const track of stream.getAudioTracks()) {
        stream.removeTrack(track);
        pcTrack?.stop();
        pcTrack = track;
      }
      if (nextSource === "camera") {
        setCameraId(stream.getVideoTracks()[0]?.getSettings().deviceId || "");
        refreshCameras();
      }
      // Partage arrêté depuis le bandeau du navigateur, ou caméra débranchée.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => { if (sharing.broadcast?.stream === stream) stopSharing(); });
      if (live()) {
        live().replace(stream);
        if (pcTrack) live().mix.set("pc", pcTrack, pcVolume / 100);
      } else {
        stopSharing(); // partage d'une autre room
        const mixer = new AudioMix();
        if (pcTrack) mixer.set("pc", pcTrack, pcVolume / 100);
        if (cableOn && gameSound.running) mixer.set("jeu", gameSound.clone(), gameVolume / 100);
        if (micOn) await openMic(mixer);
        setSharing(new Broadcast(room.code, savedAccess(room.code).player, stream, mixer, quality, priority, onBroadcast, shownGame), room.code);
      }
      pcTrack = null;
    } catch (e) {
      pcTrack?.stop();
      if (nextSource === "camera") {
        setError(CAMERA_ERRORS[e?.name]
          || html`<${CameraHelp} error=${e} seen=${await listCameras().catch(() => [])} />`);
      }
      // Fenêtre de choix fermée sans rien choisir : pas une erreur.
      else if (e?.name !== "NotAllowedError" && e?.name !== "AbortError") setError(`Partage impossible : ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const pickSource = (next) => {
    setSourceName(next);
    if (live()) share(next);
  };
  const pickCamera = (next) => {
    setCameraId(next);
    if (live()) share("camera", next);
  };

  const status = !view ? null
    : view.state === "retrying" ? "Connexion perdue, nouvelle tentative…"
    : view.state === "connecting" ? "Connexion…"
    : view.viewers ? `Votre jeu est affiché dans le stream (${plural(view.viewers, "overlay")}). Gardez cet onglet ouvert.`
    : "Prêt : votre jeu apparaîtra dès qu'un streamer ouvrira son overlay. Gardez cet onglet ouvert.";
  const camera = source === "camera";
  const startLabel = busy ? (camera ? "Ouverture de la caméra…" : "Choix de la fenêtre…")
    : camera ? "Partager la caméra d'OBS" : "Partager la fenêtre de mon jeu";
  const qualityKey = qualityName in QUALITIES ? qualityName : DEFAULT_QUALITY;
  const priorityKey = priorityName in PRIORITIES ? priorityName : DEFAULT_PRIORITY;

  // L'essentiel d'abord (quoi partager, le bouton) ; qualité et dépannage repliés.
  return html`<section class="card stack">
    <div class="row full">
      <h2 class="grow">Montrer mon jeu dans le stream</h2>
      ${view && html`<span class="badge ok">● En partage</span>`}
    </div>
    <p>${gameAudio !== "aucun" || micOn ? "Votre image et le son choisi vont" : "Votre image (sans le son) va"} directement aux overlays des
      streamers de la room. Le site ne les enregistre pas.</p>
    ${!windowSupported && !cameraSupported && html`<div class="notice warn full">Ce navigateur ne peut pas partager d'image :
      ouvrez la room dans Chrome, Edge ou Firefox, sur l'ordinateur où vous jouez.</div>`}
    ${(windowSupported || cameraSupported) && html`
    ${windowSupported && cameraSupported && html`<fieldset class="start-choice full">
      <legend class="sr-only">Image à partager</legend>
      ${Object.entries(SOURCES).map(([name, s]) => html`<label class=${`start-option ${source === name ? "selected" : ""}`}>
        <input type="radio" name="screen-source" value=${name} checked=${source === name} disabled=${busy} onChange=${() => pickSource(name)} />
        <span><strong>${s.label}</strong><span class="hint">${s.text}</span></span>
      </label>`)}
    </fieldset>`}
    ${camera && html`<ol class="steps">
      <li>Dans OBS, mettez votre jeu dans la scène (source <strong>Capture de jeu</strong>).</li>
      <li>Cliquez sur <strong>Démarrer la caméra virtuelle</strong> (en bas à droite d'OBS).</li>
      <li>Ici, cliquez sur « Partager la caméra d'OBS » et autorisez la caméra.</li>
    </ol>`}
    ${camera && cameras.length > 0 && html`<div class="fields full"><label><span>Caméra</span>
      <select value=${cameras.some((c) => c.deviceId === cameraId) ? cameraId : ""} disabled=${busy} onChange=${(e) => pickCamera(e.target.value)}>
        <option value="">Automatique (OBS en priorité)</option>
        ${cameras.map((c) => html`<option value=${c.deviceId}>${c.label}</option>`)}
      </select></label></div>`}
    ${games.length > 0 && html`<div class="fields full"><label><span>Jeu affiché à côté de votre nom</span>
      <select value=${shownGame} onChange=${(e) => pickGame(e.target.value)}>
        ${games.length > 1 && html`<option value="">Tous mes jeux (${games.join(", ")})</option>`}
        ${games.map((g) => html`<option value=${g}>${g}</option>`)}
        <option value="aucun">Aucun (seulement mon nom)</option>
      </select>
      <span class="hint">Se change pendant le partage.</span></label></div>`}
    <fieldset class="plain-fieldset stack full sound-options">
      <legend><strong>Son envoyé avec l'image</strong></legend>
      <${CableDefaults} devices=${devices} />
      <div class="start-choice full">
        ${Object.entries(GAME_AUDIO).map(([name, a]) => html`<label class=${`start-option ${gameAudio === name ? "selected" : ""}`}>
          <input type="radio" name="game-audio" value=${name} checked=${gameAudio === name} disabled=${busy} onChange=${() => pickGameAudio(name)} />
          <span><strong>${a.label}</strong><span class="hint">${a.text}</span></span>
        </label>`)}
      </div>
      ${cableOn && html`<div class="sound-source stack">
        <${CableGuide} cable=${cable} permitted=${mics.length > 0} onReveal=${revealMics} listen=${listen} onListen=${setListen}
          outputs=${devices.outputs} sink=${sink} onSink=${setSink} />
        ${gameSound.running && html`<div class="fields"><${Volume} label="Volume du jeu envoyé" value=${gameVolume} onChange=${(v) => changeVolume("jeu", v)} /></div>`}
      </div>`}
      ${!cableOn && cable && html`<details class="more"><summary>Le câble audio virtuel est installé : revenir à un son comme avant</summary>
        <${CableUndo} /></details>`}
      ${pcOn && html`<div class="sound-source stack">
        <p class="hint">${camera
          ? "Une fenêtre de choix s'ouvre d'abord pour le son : prenez l'écran entier et cochez « Partager aussi l'audio du système »."
          : "Dans la fenêtre de choix, cochez la case du partage de l'audio. Si elle manque pour une fenêtre, le site vous proposera de choisir le son à part."}</p>
        <div class="fields"><${Volume} value=${pcVolume} onChange=${(v) => changeVolume("pc", v)} /></div>
      </div>`}
      <label class="check"><input type="checkbox" checked=${micOn} disabled=${busy} onChange=${(e) => toggleMic(e.target.checked)} />
        <span><strong>Ma voix (micro)</strong> <span class="hint">: en plus du jeu, ou une autre entrée audio</span></span></label>
      ${micOn && html`<div class="sound-source stack">
        <div class="fields">
          <label><span>Entrée</span>
            <select value=${mics.some((m) => m.deviceId === micId) ? micId : ""} onChange=${(e) => pickMic(e.target.value)}>
              <option value="">Celle par défaut de l'ordinateur</option>
              ${mics.map((m) => html`<option value=${m.deviceId}>${m.label}</option>`)}
            </select>
            </label>
          ${!mics.length && html`<div class="stack span-all">
            <span class="hint">Le navigateur ne donne la liste des entrées qu'une fois le micro autorisé pour ce site.</span>
            <button type="button" class="ghost small mic-reveal" onClick=${revealMics}>Autoriser le micro pour voir les entrées</button>
          </div>`}
          <${Volume} value=${micVolume} onChange=${(v) => changeVolume("micro", v)} />
          <label class="check span-all"><input type="checkbox" checked=${micClean} onChange=${(e) => pickMic(micId, e.target.checked)} />
            Réduire le bruit et l'écho (à décocher pour une entrée qui porte de la musique)</label>
        </div>
      </div>`}
    </fieldset>
    <div class="row">
      ${view
        ? html`${!camera && html`<button type="button" class="ghost" disabled=${busy} onClick=${() => share()}>Changer de fenêtre</button>`}
          <button type="button" class="ghost" onClick=${stop}>Arrêter le partage</button>`
        : html`<button type="button" disabled=${busy} onClick=${() => share()}>${startLabel}</button>`}
    </div>`}
    ${status && html`<p role="status"><strong>${status}</strong></p>`}
    ${error && (typeof error === "string" ? html`<div class="notice error full">${error}</div>` : error)}
    ${pcOn && mix && !mix.has("pc") && html`<div class="notice warn row full">
      <span class="grow">Le son de l'ordinateur ne part pas : la fenêtre de choix ne l'a pas partagé.</span>
      <button type="button" class="ghost small" onClick=${addPc}>Choisir le son de l'ordinateur</button>
    </div>`}
    ${soundError && html`<div class="notice error full">${soundError}</div>`}
    ${mix?.active && html`<${SoundMeter} source=${mix} />`}
    ${view && html`<video class="screen-preview" ref=${preview} autoplay muted playsinline aria-label="Aperçu de votre partage"></video>`}
    <${SentInfo} sent=${sent} quality=${quality} camera=${camera} />
    ${(windowSupported || cameraSupported) && html`<details class="more">
      <summary>Qualité de l'image <span class="hint">(${QUALITIES[qualityKey].label}, ${PRIORITIES[priorityKey].label.toLowerCase()})</span></summary>
      <div class="fields full">
        <label><span>Qualité</span>
          <select value=${qualityKey} onChange=${(e) => choose(e.target.value, priorityName)}>
            ${Object.entries(QUALITIES).map(([name, q]) => html`<option value=${name}>${q.label} (${q.detail})</option>`)}
          </select></label>
        <label><span>Si la connexion ne suit pas, garder</span>
          <select value=${priorityKey} onChange=${(e) => choose(qualityName, e.target.value)}>
            ${Object.entries(PRIORITIES).map(([name, p]) => html`<option value=${name}>${p.label}</option>`)}
          </select>
          <span class="hint">${priority.detail}</span></label>
      </div>
      <p class="hint">Se change pendant le partage. Jugez avec le jeu en mouvement : une image immobile n'envoie presque rien.</p>
    </details>
    <details class="more">
      <summary>Image noire, figée ou floue ?</summary>
      <ul class="hint tips">
        ${!camera && html`<li>Choisissez une <strong>fenêtre</strong> plutôt que l'écran entier : seul le jeu sera visible.</li>
          <li>Image noire ou figée : le jeu est en plein écran exclusif. Passez-le en fenêtré, ou partagez la caméra d'OBS.</li>`}
        <li>Image floue : avec plusieurs écrans dans le stream, chacun est petit ; le 1080p ne sert qu'avec peu d'écrans.</li>
        <li>Les autres onglets de la room et les autres pages du site (tracker…) n'arrêtent pas le partage ; fermer l'onglet du navigateur, si.</li>
      </ul>
    </details>`}
  </section>`;
}

// --- Espaces de partage d'écrans ----------------------------------------------------------
// Un espace = un lien d'overlay (`#/overlay/CODE/CLÉ`). L'hôte et chaque joueur en créent ; tous les inscrits voient
// la liste et peuvent copier n'importe quel espace. Seuls son créateur et l'hôte le renomment ou le suppriment.

const formatDay = (ms) => new Date(ms).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

const canManage = (link, me, admin) => admin || (!!me && link.player_id === me.id);

function SpaceRow({ room, link, manage, action, onLinks, onSettings }) {
  const [name, setName] = useState(null); // nom en cours de modification
  // Les réglages de l'overlay sont gardés par le service : le lien est le même pour tous.
  const url = overlayLink(room.code, link.key);
  const rename = (e) => {
    e.preventDefault();
    action.run(async () => {
      onLinks((await api.updateOverlayLink(room.code, link.id, { name })).links);
      setName(null);
    });
  };
  const remove = () => confirm(`Supprimer l'espace « ${link.name} » ? Les overlays ouverts avec lui s'arrêteront.`)
    && action.run(async () => onLinks((await api.deleteOverlayLink(room.code, link.id)).links));

  return html`<li>
    ${name === null
      ? html`<div class="grow"><strong>${link.name}</strong>${" "}<span class="hint">par ${link.by || "l'hôte"} · ${formatDay(link.created_at)}</span></div>
        <${CopyButton} text=${url} label="Copier le lien pour OBS" className="small" />
        <button type="button" class="ghost small" onClick=${() => onSettings(link.id)}>Overlay</button>
        <a class="button ghost small" href=${url} target="_blank" rel="noopener">Ouvrir</a>
        ${manage && html`<button type="button" class="ghost small" disabled=${action.busy} onClick=${() => setName(link.name)}>Renommer</button>
          <button type="button" class="ghost small" disabled=${action.busy} onClick=${remove}>Supprimer</button>`}`
      : html`<form class="row grow" onSubmit=${rename}>
        <input type="text" class="grow" required maxLength="40" value=${name} aria-label="Nouveau nom de l'espace"
          onInput=${(e) => setName(e.target.value)} />
        <button type="submit" class="small" disabled=${action.busy || !name.trim()}>Enregistrer</button>
        <button type="button" class="ghost small" onClick=${() => setName(null)}>Annuler</button>
      </form>`}
  </li>`;
}

// Liste commune des espaces. `onSettings(id)` : ouvre la vue « Overlay » de l'espace (aussi juste après sa création).
function SpacesPanel({ room, data, setData, me, admin, onSettings }) {
  const action = useAction();
  const access = savedAccess(room.code);
  const links = data.overlay_links || [];
  const [name, setName] = useState("");
  const onLinks = (next) => setData((d) => ({ ...d, overlay_links: next, room: { ...d.room, overlay: false } }));

  // Lien unique d'avant la liste, gardé par le navigateur de l'hôte : il rejoint la liste, et les sources qui
  // l'utilisent continuent de marcher.
  useEffect(() => {
    const old = access.overlay;
    if (!admin || !old) return;
    if (links.some((l) => l.key === old)) { saveAccess(room.code, { overlay: null }); return; }
    if (!room.overlay) return;
    api.createOverlayLink(room.code, { name: "Lien d'origine", key: old })
      .then((result) => onLinks(result.links))
      .catch(() => {})
      .finally(() => saveAccess(room.code, { overlay: null }));
  }, [room.overlay]);

  const create = (e) => {
    e.preventDefault();
    action.run(async () => {
      const next = (await api.createOverlayLink(room.code, { name })).links;
      onLinks(next);
      setName("");
      const added = next.find((l) => !links.some((o) => o.id === l.id));
      if (added) onSettings(added.id);
    });
  };

  return html`<section class="card stack">
    <h2>Espaces de partage</h2>
    <p>Un espace réunit les jeux partagés et les infos de la partie, pour un stream. Tous les joueurs voient cette liste
      et peuvent copier n'importe quel espace.</p>
    ${links.length > 0
      ? html`<ul class="link-list full">${links.map((link) => html`<${SpaceRow} key=${link.id} room=${room} link=${link}
          manage=${canManage(link, me, admin)} action=${action} onLinks=${onLinks} onSettings=${onSettings} />`)}</ul>`
      : html`<p class="hint">Aucun espace pour l'instant.</p>`}
    <form class="row full" onSubmit=${create}>
      <input type="text" class="grow" maxLength="40" value=${name} placeholder=${`Nom de l'espace (ex. Stream de ${me?.pseudo || "l'hôte"})`}
        aria-label="Nom du nouvel espace" onInput=${(e) => setName(e.target.value)} />
      <button type="submit" class=${links.length ? "ghost" : ""} disabled=${action.busy}>Créer un espace</button>
    </form>
    <p class="hint">« Copier le lien pour OBS », puis dans OBS : <strong>Sources → + → Navigateur</strong>, collez-le, taille
      1920 × 1080. Marche aussi avec Streamlabs, XSplit… Ne montrez jamais le lien à l'écran.</p>
    ${action.error && html`<div class="notice error full">${action.error}</div>`}
  </section>`;
}

// --- Overlay d'un espace : ce qu'il montre, et l'écran en vedette en direct -------------------------

const select = (value, choices, onChange) => html`<select value=${value} onChange=${(e) => onChange(e.target.value)}>
  ${Object.entries(choices).map(([k, label]) => html`<option value=${k}>${label}</option>`)}
</select>`;

// Écran en vedette, changé en direct par le créateur de l'espace ou l'hôte : les overlays ouverts suivent aussitôt.
function FeaturedControl({ room, link, players, rotation, onLinks }) {
  const action = useAction();
  const pick = (player) => action.run(async () => onLinks((await api.setFeatured(room.code, link.id, player)).links));
  return html`<section class="card stack">
    <h2>En direct : écran en vedette</h2>
    <p class="hint">${rotation
      ? `Roulement ${ROTATIONS[rotation].toLowerCase()} : un clic met ce joueur en vedette tout de suite, puis le roulement repart de lui.`
      : "Un clic met ce joueur en grand sur l'overlay, tout de suite. S'il ne partage pas son jeu, c'est le premier qui partage."}</p>
    <div class="items-players-list">
      <button type="button" class=${`player-check ${!link.featured ? "on" : ""}`} aria-pressed=${!link.featured} disabled=${action.busy}
        onClick=${() => pick(null)}>${!link.featured ? "✓ " : ""}Premier qui partage</button>
      ${players.map((p) => html`<button type="button" class=${`player-check ${link.featured === p.id ? "on" : ""}`}
        aria-pressed=${link.featured === p.id} disabled=${action.busy} onClick=${() => pick(p.id)}>
        ${link.featured === p.id ? "✓ " : ""}<strong>${p.pseudo}</strong></button>`)}
    </div>
    ${action.error && html`<div class="notice error full">${action.error}</div>`}
  </section>`;
}

// Son entendu sur l'overlay, changé en direct comme l'écran en vedette : un seul joueur à la fois, pour ne pas mélanger
// tous les sons. Sur l'overlay, le haut-parleur de chaque écran fait la même chose (OBS : « Interagir »).
function SoundControl({ room, link, players, featured, onLinks }) {
  const action = useAction();
  const pick = (player) => action.run(async () => onLinks((await api.setSound(room.code, link.id, player)).links));
  const choices = [[null, "Aucun son"], ...(featured ? [["vedette", "Celui de l'écran en vedette"]] : []), ...players.map((p) => [p.id, p.pseudo])];
  const current = link.sound || null;
  return html`<section class="card stack">
    <h2>En direct : son de l'overlay</h2>
    <p class="hint">Un seul joueur entendu à la fois, parmi ceux qui envoient leur son. Dans OBS, cochez
      <strong>Contrôler l'audio via OBS</strong> dans les propriétés de la source Navigateur, pour régler son volume dans le mixeur.</p>
    <div class="items-players-list">
      ${choices.map(([id, label]) => html`<button type="button" class=${`player-check ${current === id ? "on" : ""}`}
        aria-pressed=${current === id} disabled=${action.busy} onClick=${() => pick(id)}>
        ${current === id ? "✓ " : ""}${id && id !== "vedette" ? html`<strong>${label}</strong>` : label}</button>`)}
    </div>
    ${action.error && html`<div class="notice error full">${action.error}</div>`}
  </section>`;
}

function OverlayPanel({ room, data, setData, me, admin, linkId, onLink, onBack }) {
  const action = useAction();
  const links = data.overlay_links || [];
  const players = data.players || [];
  const link = links.find((l) => l.id === linkId) || links[0] || null;
  const [draft, setDraft] = useState(null); // réglages modifiés, pas encore enregistrés
  useEffect(() => setDraft(null), [link?.id]);
  if (!link) {
    return html`<section class="card stack"><h2>Overlay</h2>
      <p>Créez d'abord un espace (vue « Espaces de partage »).</p></section>`;
  }
  const manage = canManage(link, me, admin);
  const config = draft || spaceOf(link.config);
  const set = (patch) => setDraft({ ...config, ...patch });
  const onLinks = (next) => setData((d) => ({ ...d, overlay_links: next }));
  const save = () => action.run(async () => { onLinks((await api.saveSpaceConfig(room.code, link.id, config)).links); setDraft(null); });
  const auto = config.mode !== "manuel";

  return html`<section class="card stack">
    <div class="row full">
      <h2 class="grow">Overlay de l'espace</h2>
      ${draft && html`<span class="badge warn">Modifications non enregistrées</span>`}
    </div>
    <div class="fields full">
      <label class="span-all"><span>Espace</span>
        <select value=${link.id} onChange=${(e) => { if (!draft || confirm("Abandonner les modifications non enregistrées ?")) onLink(e.target.value); }}>
          ${links.map((l) => html`<option value=${l.id}>${l.name} (par ${l.by || "l'hôte"})</option>`)}
        </select></label>
    </div>
    ${!manage && html`<p class="hint">Réglé par ${link.by || "l'hôte"} : seuls son créateur et l'hôte peuvent le modifier.</p>`}
    <fieldset class="plain-fieldset stack full" disabled=${!manage}>
      <legend class="sr-only">Réglages de l'overlay</legend>
      <div class="start-choice full">
        ${[["auto", "Automatique", "Le plus simple : écrans et infos se placent tout seuls."],
          ["manuel", "À la main", "Une disposition par nombre d'écrans, qui change quand un joueur arrive ou part."]]
          .map(([value, title, text]) => html`<label class=${`start-option ${config.mode === value ? "selected" : ""}`}>
            <input type="radio" name="space-mode" value=${value} checked=${config.mode === value} onChange=${() => set({ mode: value })} />
            <span><strong>${title}</strong><span class="hint">${text}</span></span>
          </label>`)}
      </div>

      <div class="stack full">
        <strong>Joueurs montrés</strong>
        <label class="check"><input type="radio" name="space-players" checked=${!config.joueurs.length} onChange=${() => set({ joueurs: [] })} />
          Tous ceux qui partagent leur jeu</label>
        <label class="check"><input type="radio" name="space-players" checked=${config.joueurs.length > 0} disabled=${!players.length}
          onChange=${() => set({ joueurs: [players[0].id] })} /> Seulement ceux-ci :</label>
        ${config.joueurs.length > 0 && html`<div class="items-players-list">${players.map((p) => html`<span
          class=${`player-check ${config.joueurs.includes(p.id) ? "on" : ""}`}><input type="checkbox" aria-label=${p.pseudo}
          checked=${config.joueurs.includes(p.id)} onChange=${(e) => set({ joueurs: e.target.checked
            ? [...config.joueurs, p.id] : config.joueurs.filter((id) => id !== p.id) })} /> <strong>${p.pseudo}</strong></span>`)}</div>`}
      </div>

      ${auto && html`<div class="fields full">
        <label class="span-all"><span>Écrans de jeu</span>${select(config.ecrans, SCREEN_MODES, (v) => set({ ecrans: v }))}</label>
        <label><span>Messages de la partie</span>${select(config.messages, CONSOLE_PLACES, (v) => set({ messages: v }))}</label>
        ${config.messages !== "non" && html`<label><span>Objets montrés</span>${select(config.objets, ITEM_FILTERS, (v) => set({ objets: v }))}</label>
          <div class="span-all message-options">${Object.entries(FEED_CHECKS).map(([key, label]) => html`<label class="check">
            <input type="checkbox" checked=${config[key]} onChange=${(e) => set({ [key]: e.target.checked })} /> ${label}</label>`)}</div>`}
        <label class="span-all"><span>Progression des joueurs</span>${select(config.progression, PROGRESS_MODES, (v) => set({ progression: v }))}</label>
      </div>`}
      ${!auto && html`<${SpaceLayouts} variants=${config.variants} players=${players} onChange=${(variants) => set({ variants })} />`}

      ${spaceUses(config, "vedette") && html`<div class="fields full">
        <label class="span-all"><span>Écran en vedette : roulement</span>
          ${select(String(config.rotation), ROTATIONS, (v) => set({ rotation: Number(v) }))}
          <span class="hint">Le roulement passe d'un joueur qui partage au suivant ; à la main, on choisit ci-dessous.</span></label>
      </div>`}
    </fieldset>

    ${action.error && html`<div class="notice error full">${action.error}</div>`}
    <div class="row">
      ${manage && html`<button type="button" disabled=${!draft || action.busy} onClick=${save}>${action.busy ? "Enregistrement…" : "Enregistrer"}</button>
        ${draft && html`<button type="button" class="ghost" onClick=${() => setDraft(null)}>Annuler</button>`}`}
      <${CopyButton} text=${overlayLink(room.code, link.key)} label="Copier le lien pour OBS" className="ghost" />
      <button type="button" class="ghost" onClick=${onBack}>Retour aux espaces</button>
    </div>
    <p class="hint">Les overlays ouverts suivent les réglages dès l'enregistrement : pas besoin de recopier le lien.</p>
    <details class="more">
      <summary>Comment ça marche</summary>
      <ul class="hint tips">
        <li>En automatique, tout se place seul sans qu'un écran en recouvre un autre ; à la main, l'éditeur signale les
          écrans qui se recouvrent.</li>
        <li>Le goal de chaque joueur est lu dans son YAML de la room (absent dans une room de partie déjà hébergée).</li>
        <li>Les messages arrivent une fois la partie en ligne : l'overlay s'y connecte comme client texte du premier joueur.</li>
        <li>Chaque joueur envoie son image à ${MAX_VIEWERS} overlays au plus : après avoir vérifié avec « Ouvrir », fermez l'onglet.</li>
      </ul>
    </details>
  </section>
  ${manage && spaceUses(spaceOf(link.config), "vedette") && html`<${FeaturedControl} room=${room} link=${link} players=${players}
    rotation=${spaceOf(link.config).rotation} onLinks=${onLinks} />`}
  ${manage && html`<${SoundControl} room=${room} link=${link} players=${players}
    featured=${spaceUses(spaceOf(link.config), "vedette")} onLinks=${onLinks} />`}`;
}

// Trois vues : partager son jeu (joueurs), les espaces de partage (liste commune, lien à copier pour OBS), et
// l'overlay d'un espace (ce qu'il montre, écran en vedette en direct). Le partage reste actif quand on change de vue.
export function ScreensTab({ room, me, admin, data, setData }) {
  const views = [...(me ? [["share", "Partager mon jeu"]] : []), ["spaces", "Espaces de partage"], ["overlay", "Overlay"]];
  const [view, setView] = useSetting("screensView", "share");
  const own = (data.overlay_links || []).find((l) => me && l.player_id === me.id);
  const [linkId, setLinkId] = useState(own?.id || null);
  const current = views.some(([id]) => id === view) ? view : views[0][0];
  const openSettings = (id) => { setLinkId(id); setView("overlay"); };
  return html`
    <div class="segmented" role="tablist" aria-label="Écrans">${views.map(([id, label]) => html`<button type="button" role="tab"
      aria-selected=${current === id} class=${current === id ? "active" : ""} onClick=${() => setView(id)}>${label}</button>`)}</div>
    ${me && html`<div class="room-panel" hidden=${current !== "share"}><${ShareScreen} room=${room}
      games=${[...new Set((data.players || []).find((p) => p.id === me.id)?.slots.map((s) => s.game) || [])]} /></div>`}
    ${current === "spaces" && html`<${SpacesPanel} room=${room} data=${data} setData=${setData} me=${me} admin=${admin} onSettings=${openSettings} />`}
    ${current === "overlay" && html`<${OverlayPanel} room=${room} data=${data} setData=${setData} me=${me} admin=${admin}
      linkId=${linkId} onLink=${setLinkId} onBack=${() => setView("spaces")} />`}`;
}
