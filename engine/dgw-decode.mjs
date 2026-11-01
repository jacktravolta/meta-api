// dgw-decode.mjs — decodificador del protocolo DGW/clippy del gateway de meta.ai.
// estructura de frame (inferida de la captura):
//   [tipo:1][reservado:2][largo:u16 LE][flag:1][cuerpo]
//   tipo 0x0F = handshake JSON   (flag ignorado, cuerpo = JSON utf8)
//   tipo 0x0D = datos            (flag 0x80 = JSON con protobuf b64; 0x00 = protobuf crudo)
//   tipo 0x09/0x0A = ping/pong (1 byte)

export function decodeFrame(b64) {
	const b = Buffer.from(b64, "base64");
	if (b.length < 6) return { type: b[0], raw: b, len: b.length };
	const type = b[0];
	const len = b.readUInt16LE(3);
	const flag = b[6];
	const body = b.subarray(7);
	return { type, len, flag, body };
}

// lector protobuf generico (wire types 0..2)
export function* readFields(buf) {
	let i = 0;
	while (i < buf.length) {
		let tag = 0, shift = 0;
		for (;;) {
			if (i >= buf.length) return;
			const c = buf[i++];
			tag |= (c & 0x7f) << shift;
			if (!(c & 0x80)) break;
			shift += 7;
		}
		const field = tag >> 3, wire = tag & 7;
		if (wire === 0) {
			let v = 0n, s = 0n;
			for (;;) {
				const c = buf[i++];
				v |= BigInt(c & 0x7f) << s;
				if (!(c & 0x80)) break;
				s += 7n;
			}
			yield { field, wire, varint: v };
		} else if (wire === 2) {
			let l = 0, s = 0;
			for (;;) {
				const c = buf[i++];
				l |= (c & 0x7f) << s;
				if (!(c & 0x80)) break;
				s += 7;
			}
			const chunk = buf.subarray(i, i + l);
			i += l;
			yield { field, wire, bytes: chunk };
		} else {
			// wire types 1 (64-bit) y 5 (32-bit)
			const n = wire === 1 ? 8 : 4;
			const chunk = buf.subarray(i, i + n);
			i += n;
			yield { field, wire, bytes: chunk };
		}
	}
}

// imprime campos pb, intentando utf8 y recursion
export function dumpPb(buf, depth = 0, seen = new Set()) {
	const pad = "  ".repeat(depth);
	if (seen.has(buf)) return pad + "(recursivo)\n";
	if (buf.length > 4000) seen.add(buf);
	let out = "";
	for (const f of readFields(buf)) {
		if (f.wire === 0) {
			out += `${pad}f${f.field} varint=${f.varint}\n`;
		} else {
			const t = f.bytes;
			const printable = t.length && [...t].every((c) => (c >= 9 && c <= 126) || c >= 170);
			if (printable) {
				const s = t.toString("utf8").slice(0, 400);
				out += `${pad}f${f.field} str=${JSON.stringify(s)}\n`;
			} else {
				out += `${pad}f${f.field} bytes(len=${t.length}) {\n${dumpPb(t, depth + 1, seen)}${pad}}\n`;
			}
		}
	}
	return out;
}

// si un campo pb contiene JSON utf8, extraelo
export function jsonIn(buf) {
	for (const f of readFields(buf)) {
		if (f.wire === 2) {
			const s = f.bytes.toString("utf8");
			if (s.startsWith("{") || s.startsWith("[")) {
				try { return JSON.parse(s); } catch {}
			}
			const inner = jsonIn(f.bytes);
			if (inner) return inner;
		}
	}
	return null;
}

// CLI: node dgw-decode.mjs <captura.json>
if (import.meta.url === `file://${process.argv[1]}`) {
	const fs = await import("node:fs");
	const log = JSON.parse(fs.readFileSync(process.argv[2] ?? "/tmp/opencode/capture-ws.json", "utf8"));
	for (const fr of log.frames ?? log) {
		const d = decodeFrame(fr.data);
		let info = `tipo=${d.type}`;
		if (d.type === 15) info += ` json=${d.body?.toString("utf8").slice(0, 150)}`;
		else if (d.type === 13) {
			const flag = d.flag;
			if (flag === 0x80) {
				const j = JSON.parse(d.body.toString("utf8"));
				info += ` req-id=${j["req-id"]}`;
				if (j.payload) {
					const inner = Buffer.from(j.payload, "base64");
					info += `\n  payload pb (${inner.length} bytes):\n${dumpPb(inner, 1)}`;
				}
			} else {
				info += ` pb:\n${dumpPb(d.body, 1)}`;
				const j = jsonIn(d.body);
				if (j) info += `  JSON embebido: ${JSON.stringify(j).slice(0, 500)}\n`;
			}
		}
		console.log(`[${fr.dir}] ${fr.data.length}b ${info}`);
	}
}
