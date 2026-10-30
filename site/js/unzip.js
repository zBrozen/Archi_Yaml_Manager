// Lecture d'une archive .zip (packs PopTracker) : fichiers stockés ou compressés (deflate),
// décompressés par le navigateur (DecompressionStream) à la demande.

const decoder = new TextDecoder();

// Renvoie Map(chemin → { size, bytes() }) ; `bytes()` renvoie une promesse de Uint8Array.
export function readZip(buffer) {
  const data = new Uint8Array(buffer);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Fin du répertoire central : cherchée depuis la fin (un commentaire peut la suivre).
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("Ce fichier n'est pas une archive .zip.");
  const count = view.getUint16(end + 10, true);
  let pos = view.getUint32(end + 16, true);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error("Archive .zip abîmée.");
    const method = view.getUint16(pos + 10, true);
    const compressed = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    const name = decoder.decode(data.subarray(pos + 46, pos + 46 + nameLength)).replace(/\\/g, "/");
    pos += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = data.subarray(start, start + compressed);
    files.set(name, {
      size,
      bytes: async () => {
        if (method === 0) return raw;
        if (method !== 8) throw new Error(`Compression non prise en charge dans ${name}.`);
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      },
    });
  }
  return files;
}

export const bytesToText = (bytes) => decoder.decode(bytes).replace(/^﻿/, "");
