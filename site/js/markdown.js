// Affichage des guides des jeux (Markdown des dossiers docs/ des mondes, écrit par leurs auteurs).
// Le texte devient des nœuds Preact, jamais du HTML brut : les balises HTML du guide sont ignorées
// (sauf <br>), les liens ne gardent que http(s) et mailto, et seules les images d'archipelago.gg et de
// GitHub s'affichent (les autres restent des liens, pour ne rien charger d'un site inconnu).
import { html } from "../vendor/preact-htm.js";

const AP_SITE = "https://archipelago.gg";
const IMAGE_HOSTS = /^(archipelago\.gg|github\.com|raw\.githubusercontent\.com|(user-images|private-user-images)\.githubusercontent\.com)$/;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?: +|$)/;
const TABLE_LINE = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;
const HTML_LINE = /^ *<\/?[a-zA-Z][^>]*> *$/;

// Identifiant d'un titre, pour les liens internes (#titre) du guide.
const anchor = (text) => "guide-" + text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");

// `base` : adresse à laquelle se lisent les liens relatifs (images…) ; sans elle, ils restent du texte.
export function Markdown({ text, base }) {
  const lines = String(text || "").replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return html`<div class="markdown">${blocks(lines, { base })}</div>`;
}

function startsBlock(line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line);
}

function blocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim() || HTML_LINE.test(line)) { i++; continue; }
    if ((m = FENCE.exec(line))) {
      const code = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(m[1]); i++) code.push(lines[i]);
      i++;
      out.push(html`<pre><code>${code.join("\n")}</code></pre>`);
    } else if ((m = HEADING.exec(line))) {
      // Le guide est affiché sous le titre de la page : ses titres descendent d'un niveau.
      const Tag = `h${Math.min(6, m[1].length + 1)}`;
      out.push(html`<${Tag} id=${anchor(m[2] || "")}>${inline(m[2] || "", ctx)}<//>`);
      i++;
    } else if (RULE.test(line)) {
      out.push(html`<hr />`);
      i++;
    } else if (QUOTE.test(line)) {
      const quoted = [];
      for (; i < lines.length && lines[i].trim() && !HTML_LINE.test(lines[i]); i++) quoted.push(lines[i].replace(QUOTE, ""));
      out.push(html`<blockquote>${blocks(quoted, ctx)}</blockquote>`);
    } else if (ITEM.test(line)) {
      i = list(lines, i, ctx, out);
    } else if (line.includes("|") && TABLE_LINE.test(lines[i + 1] || "") && lines[i + 1].includes("-")) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
      out.push(html`<div class="table-wrap"><table>
        <thead><tr>${head.map((c) => html`<th>${inline(c, ctx)}</th>`)}</tr></thead>
        <tbody>${rows.map((r) => html`<tr>${head.map((_, k) => html`<td>${inline(r[k] || "", ctx)}</td>`)}</tr>`)}</tbody>
      </table></div>`);
    } else {
      const para = [line];
      for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !HTML_LINE.test(lines[i]); i++) {
        // Titre souligné (« Titre » puis « ===== ») : rare, mais présent dans quelques guides.
        if (/^ *(=+|-+) *$/.test(lines[i])) break;
        para.push(lines[i]);
      }
      if (i < lines.length && /^ *(=+|-+) *$/.test(lines[i])) {
        const Tag = lines[i].trim()[0] === "=" ? "h2" : "h3";
        out.push(html`<${Tag} id=${anchor(para.join(" "))}>${inline(para.join(" "), ctx)}<//>`);
        i++;
      } else {
        out.push(html`<p>${inline(para.join("\n"), ctx)}</p>`);
      }
    }
  }
  return out;
}

function cells(line) {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

// Liste, avec ses sous-listes : le contenu d'un élément (lignes plus indentées que sa puce) est relu comme un bloc.
function list(lines, i, ctx, out) {
  const first = ITEM.exec(lines[i]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length < indent || m[1].length > indent + 1 || /\d/.test(m[2]) !== ordered) break;
    const width = m[0].length;
    const content = [lines[i].slice(width)];
    for (i++; i < lines.length; i++) {
      const line = lines[i];
      const spaces = line.length - line.trimStart().length;
      if (!line.trim()) {
        // Ligne vide : l'élément continue seulement si la suite est indentée sous lui.
        const next = lines.slice(i + 1).find((l) => l.trim());
        if (next === undefined || next.length - next.trimStart().length < Math.min(width, indent + 2)) break;
        content.push("");
      } else if (spaces >= Math.min(width, indent + 2)) {
        content.push(line.slice(Math.min(spaces, width)));
      } else if (!startsBlock(line) && content[content.length - 1].trim()) {
        content.push(line.trim()); // suite du paragraphe sans indentation
      } else break;
    }
    items.push(content);
    while (i < lines.length && !lines[i].trim()) {
      const next = lines.slice(i).find((l) => l.trim());
      const m2 = next && ITEM.exec(next);
      if (!m2 || m2[1].length !== indent) break;
      i++;
    }
  }
  const body = items.map((content) => html`<li>${blocks(content, ctx)}</li>`);
  out.push(ordered
    ? html`<ol start=${parseInt(first[2], 10) !== 1 ? parseInt(first[2], 10) : undefined}>${body}</ol>`
    : html`<ul>${body}</ul>`);
  return i;
}

// Adresse d'un lien du guide, ou null s'il ne mène nulle part de sûr. Les liens « /… » visent archipelago.gg
// (les guides y sont publiés), les liens relatifs le dossier `base` (celui du guide sur archipelago.gg), s'il existe.
function resolve(href, ctx) {
  // archipelago.gg publie les fichiers du monde « generic » (images communes) sous docs/Archipelago.
  href = href.trim().replace(/^(\.\.\/)+generic\/docs\//, "../Archipelago/");
  if (!href) return null;
  try {
    const url = href.startsWith("/") ? new URL(href, AP_SITE)
      : /^[a-z][a-z0-9+.-]*:/i.test(href) ? new URL(href)
        : ctx.base ? new URL(href, ctx.base) : null;
    return url && ["http:", "https:", "mailto:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

const external = (url, children) => html`<a href=${url.href} target="_blank" rel="noopener noreferrer">${children}</a>`;

function jump(e, id) {
  const target = document.getElementById(id);
  e.preventDefault();
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

const INLINE = [
  // [expression, (correspondance, ctx) => nœud]
  [/^\\([\\`*_{}[\]()#+\-.!|<>~])/, (m) => m[1]],
  [/^(`+)([\s\S]*?[^`])\1(?!`)/, (m) => html`<code>${m[2].trim()}</code>`],
  [/^!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/, (m, ctx) => {
    const url = resolve(m[2], ctx);
    if (!url || ctx.noLinks) return m[1];
    if (url.protocol === "https:" && IMAGE_HOSTS.test(url.hostname)) {
      return html`<img src=${url.href} alt=${m[1]} loading="lazy" referrerpolicy="no-referrer" />`;
    }
    return external(url, `[image${m[1] ? ` : ${m[1]}` : ""}]`);
  }],
  [/^\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/, (m, ctx) => {
    const label = inline(m[1], { ...ctx, noLinks: true });
    if (ctx.noLinks) return label;
    if (m[2].startsWith("#")) {
      const id = anchor(decodeURIComponent(m[2].slice(1)).replace(/-/g, " "));
      return html`<a href="#" onClick=${(e) => jump(e, id)}>${label}</a>`;
    }
    const url = resolve(m[2], ctx);
    return url ? external(url, label) : label;
  }],
  [/^<((?:https?:\/\/|mailto:)[^>\s]+)>/, (m, ctx) => (ctx.noLinks ? m[1] : external(new URL(m[1]), m[1]))],
  [/^<br\s*\/?>/i, () => html`<br />`],
  [/^<\/?[a-zA-Z][^>]*>/, () => ""],
  [/^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_]/, (m, ctx) => {
    if (ctx.noLinks) return m[0];
    const url = resolve(m[0], ctx);
    return url ? external(url, m[0]) : m[0];
  }],
  [/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/, (m, ctx) => html`<strong>${inline(m[2], ctx)}</strong>`],
  [/^~~(?=\S)([\s\S]*?\S)~~/, (m, ctx) => html`<del>${inline(m[1], ctx)}</del>`],
  [/^(\*|_)(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}])/u, (m, ctx) => html`<em>${inline(m[2], ctx)}</em>`],
  [/^(?: {2,}|\\)\n/, () => html`<br />`],
  [/^\n/, () => " "],
// Recherche à une position donnée du texte (drapeau y), sans recopier la suite à chaque caractère.
].map(([pattern, make]) => [new RegExp(pattern.source.slice(1), pattern.flags + "y"), make]);
const PLAIN = /[^\\`![<h*_~\n ]+/y;

function inline(text, ctx) {
  const out = [];
  let plain = "";
  let i = 0;
  while (i < text.length) {
    // « _ » au milieu d'un mot (nom_de_fichier) n'est pas de l'italique.
    const wordBefore = /[\p{L}\p{N}]/u.test(text[i - 1] || "");
    let done = false;
    if (!(text[i] === "_" && wordBefore) && !(text[i] === "h" && wordBefore)) {
      for (const [pattern, make] of INLINE) {
        pattern.lastIndex = i;
        const m = pattern.exec(text);
        if (!m) continue;
        if (plain) { out.push(plain); plain = ""; }
        out.push(make(m, ctx));
        i += m[0].length;
        done = true;
        break;
      }
    }
    if (!done) {
      PLAIN.lastIndex = i;
      const run = PLAIN.exec(text);
      plain += run ? run[0] : text[i];
      i += run ? run[0].length : 1;
    }
  }
  if (plain) out.push(plain);
  return out;
}
