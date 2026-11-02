// Page d'accueil (#/) : ce qu'est Archipelago, le déroulé d'une partie et les mots à connaître, pour qui n'y a
// jamais joué. Les outils du site (éditeur, rooms, installation) sont sur leurs propres pages.
import { html } from "../vendor/preact-htm.js";
import { roomsEnabled } from "./rooms-api.js";
import { Compass } from "./art.js";
import { ChestDemo } from "./demo.js";

const AP_SITE = "https://archipelago.gg";

const STEPS = [
  ["Choisir son jeu et l'installer",
    html`Chaque joueur choisit un jeu pris en charge et l'installe avec ce qu'il faut pour le relier à Archipelago (mod ou
      client). La page <a href="#/installer">Installer un jeu</a> donne les liens et les guides de chaque jeu.`],
  ["Créer son YAML",
    html`Un petit fichier de réglages : votre nom de joueur, votre jeu, et vos options (difficulté, objectif…).${" "}
      <a href="#/editeur">L'éditeur</a> explique chaque option et propose un réglage simple.`],
  ["Réunir les YAML et générer la partie",
    html`L'hôte rassemble les fichiers de tout le monde, et Archipelago mélange les objets de tous les jeux ensemble.${" "}
      ${roomsEnabled() ? html`Une <a href="#/rooms">room</a> le fait pour vous, puis héberge la partie sur archipelago.gg.` : ""}`],
  ["Se connecter et jouer",
    html`Chacun relie son jeu au serveur avec l'adresse de la partie et son nom de joueur. Les objets arrivent en direct :
      quand un ami trouve quelque chose pour vous, vous le recevez tout de suite.`],
  ["Atteindre son objectif",
    html`Chacun termine l'objectif de son propre jeu (battre le boss final, par exemple). La partie est finie quand tout le
      monde a atteint le sien.`],
];

const WORDS = [
  ["Multiworld", "La partie entière : tous les jeux des joueurs, reliés entre eux."],
  ["YAML", "Le fichier de réglages d'un joueur (extension .yaml)."],
  ["Apworld", "Le fichier qui apprend un jeu à Archipelago. Les jeux officiels sont déjà inclus ; un jeu non officiel s'ajoute avec son .apworld."],
  ["Check", "Un endroit où se cache un objet : un coffre, un boss, un PNJ… Le « faire », c'est récupérer ce qu'il contient."],
  ["Objet de progression", "Un objet qui débloque la suite (un grappin, une clé, une capacité). C'est souvent celui qu'un ami attend."],
  ["Sync / Async", "Sync : tout le monde joue en même temps, en une session. Async : chacun à son rythme, sur plusieurs jours."],
];

const NOTES = [
  ["Il faut posséder son jeu", "Le site ne fournit aucun jeu ni aucune ROM : chaque joueur utilise son propre exemplaire."],
  ["Pas besoin de jouer ensemble", "En async, chacun joue quand il veut ; les objets attendent sur le serveur."],
  ["Jeux officiels et non officiels", "Les jeux non officiels sont faits par la communauté : leur stabilité est indiquée dans la liste."],
  ["Vos fichiers restent chez vous", "L'éditeur lit et modifie vos YAML dans le navigateur, sans les envoyer nulle part."],
];

export function Welcome({ index }) {
  const custom = index.games.filter((g) => g.source !== "core").length;
  return html`<main class="welcome">
    <section class="welcome-hero">
      <${Compass} class="welcome-compass" />
      <h1>Archipelago, c'est quoi ?</h1>
      <p class="lead">Un randomizer à plusieurs : chacun joue à <strong>son propre jeu</strong>, mais les objets de tous les jeux
        sont <strong>mélangés entre les joueurs</strong>. L'objet qui vous manque se trouve peut-être dans le jeu d'un ami, et ce
        que vous trouvez peut le débloquer.</p>
      <div class="row">
        <a class="button" href="#/editeur">Préparer mon YAML</a>
        ${roomsEnabled() && html`<a class="button ghost" href="#/rooms">Jouer avec des amis</a>`}
        <a class="button ghost" href="#/installer">Installer un jeu</a>
      </div>
    </section>

    <${ChestDemo} />

    <section aria-labelledby="deroule">
      <h2 id="deroule">Comment se déroule une partie</h2>
      <ol class="welcome-steps">${STEPS.map(([title, text]) => html`<li class="card">
        <strong>${title}</strong>
        <p>${text}</p>
      </li>`)}</ol>
    </section>

    <section aria-labelledby="mots">
      <h2 id="mots">Les mots à connaître</h2>
      <dl class="welcome-words">${WORDS.map(([word, text]) => html`<div class="card"><dt>${word}</dt><dd>${text}</dd></div>`)}</dl>
    </section>

    <section aria-labelledby="savoir">
      <h2 id="savoir">Bon à savoir</h2>
      <ul class="welcome-notes">${NOTES.map(([title, text]) => html`<li><strong>${title}</strong><span>${text}</span></li>`)}</ul>
    </section>

    <p class="hint center">${index.games.length} jeux disponibles, dont ${custom} non officiels · Archipelago ${index.ap_version} ·
      ${" "}<a href=${AP_SITE}>Site officiel d'Archipelago</a></p>
  </main>`;
}
