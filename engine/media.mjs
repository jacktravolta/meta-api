// media.mjs — imagenes que Meta devuelve en la respuesta: extraccion y bajada.
//
// La respuesta trae, en cualquier seccion, un primitive:
//   { "__typename": "GenAIImagePrimitive",
//     "preview_image": { "url": "...fbcdn...", "mime_type": "image/webp" },
//     "full_image":    { "url": "...fbcdn...", "mime_type": "image/webp" } }
// La URL es un enlace CDN ya firmado: se descarga sin cookies y caduca, asi
// que la bajada se guarda en engine/.media/<conversacion>/ (fuera de git).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { evento } from "./eventos.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MEDIA_DIR = path.join(HERE, ".media");

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const EXT = {
	"image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
	"image/avif": "avif", "video/mp4": "mp4",
};

// La extension se saca de los BYTES, no del content-type: meta sirve algunos
// jpeg como application/octet-stream y quedaban como .bin.
function sniffExt(buf, fallback = "bin") {
	if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
	if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
	if (buf.length > 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
	if (buf.length > 3 && buf.subarray(0, 3).toString("latin1") === "GIF") return "gif";
	return fallback;
}

/** Recorre un JSON de respuesta y devuelve las imagenes (deduplicadas). */
export function imagesOfJson(json) {
	const out = [];
	const walk = (o) => {
		if (!o || typeof o !== "object") return;
		if (o.__typename === "GenAIImagePrimitive") {
			// full y preview suelen ser la MISMA imagen con otra URL: se baja
			// solo la full (el preview es un duplicado y gastaba el doble).
			const img = o.full_image ?? o.preview_image ?? null;
			if (img?.url) {
				// la MISMA imagen aparece en sections y embedded_screens y en varios
				// frames: la clave de dedupe es el pathname (la firma cambia).
				let key = img.url;
				try { key = new URL(img.url).pathname; } catch { /* url rara: se usa entera */ }
				out.push({ url: img.url, key, mime: img.mime_type ?? "image/webp", kind: o.full_image ? "full" : "preview" });
			}
		}
		for (const v of Object.values(o)) walk(v);
	};
	walk(json);
	return out;
}

const safe = (s) => String(s ?? "sin-conv").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || "sin-conv";

/** Descarga cada imagen a engine/.media/<conv>/ y devuelve {url, mime, bytes, path}. */
export async function downloadImages(images, { convId = "sin-conv", timeoutMs = 30_000 } = {}) {
	const vistos = new Set();
	const out = [];
	for (const im of images ?? []) {
		const clave = im?.key ?? im?.url;
		if (!im?.url || vistos.has(clave)) continue;
		vistos.add(clave);
		const t0 = Date.now();
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), timeoutMs);
			const r = await fetch(im.url, { headers: { "user-agent": UA }, signal: ctrl.signal });
			clearTimeout(timer);
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const buf = Buffer.from(await r.arrayBuffer());
			const mime = r.headers.get("content-type")?.split(";")[0] || im.mime;
			const dir = path.join(MEDIA_DIR, safe(convId));
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			// dedupe por CONTENIDO: meta sirve la misma imagen con URLs distintas
			const hash = crypto.createHash("sha1").update(buf).digest("hex");
			const indexFile = path.join(dir, ".index.json");
			let index = {};
			try { index = JSON.parse(fs.readFileSync(indexFile, "utf8")); } catch { /* indice nuevo */ }
			if (index[hash]) {
				// ya la teniamos: no se vuelve a guardar
				out.push({ url: im.url, mime, bytes: buf.length, path: path.join(dir, index[hash]), dup: true });
				evento("IMG_DUPLICADA", { conv: safe(convId), bytes: buf.length, archivo: index[hash] });
				continue;
			}
			const ext = sniffExt(buf, EXT[mime] ?? "bin");
			const name = `${hash.slice(0, 8)}.${ext}`;
			const file = path.join(dir, name);
			fs.writeFileSync(file, buf, { mode: 0o600 });
			index[hash] = name;
			try { fs.writeFileSync(indexFile, JSON.stringify(index, null, 1), { mode: 0o600 }); } catch { /* indice opcional */ }
			const ms = Date.now() - t0;
			out.push({ url: im.url, mime, bytes: buf.length, path: file, ms });
			evento("IMG_BAJADA", { conv: safe(convId), mime, bytes: buf.length, ms, archivo: path.relative(path.join(HERE, ".."), file) });
		} catch (err) {
			evento("IMG_ERROR", { conv: safe(convId), error: String(err?.message ?? err).slice(0, 120) });
		}
	}
	return out;
}
