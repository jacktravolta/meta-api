// pb.mjs — codec protobuf zero-deps + codec de frames DGW del gateway de meta.ai.
// Reglas de verificacion: ver PROTOCOL.md y fixtures/capture-ws-20261031.json.
//
// Frame DGW (verificado sobre las 11 frames de la captura):
//   [0]        tipo: 0x0f hs JSON, 0x0d datos, 0x0c ack, 0x09=ping(cli) 0x0a=pong(srv)
//   [1..2]     00 00 reservado
//   [3..4]     len u16 LE — cuenta bytes desde [6] inclusive: len = payload_len + 2
//   [5..6]     00 00 reservado
//   [7]        flag: 0x80 = cliente (JSON con pb b64), 0x00 = servidor (pb crudo)
//   [8..]      payload
//
// Pares keepalive de 1 byte: cliente envia 0x09, servidor responde 0x0a.

const WIRE_VARINT = 0;
const WIRE_LEN = 2;

export function readVarint(buf, i = 0) {
	let v = 0n, s = 0n;
	for (;;) {
		if (i >= buf.length) throw new Error("varint sin terminador");
		const c = buf[i++];
		v |= BigInt(c & 0x7f) << s;
		if (!(c & 0x80)) return { v, i };
		s += 7n;
	}
}

export function encodeVarint(v) {
	let out = "";
	let x = BigInt(v);
	do {
		let b = Number(x & 0x7fn);
		x >>= 7n;
		if (x) b |= 0x80;
		out += String.fromCharCode(b);
	} while (x);
	return Buffer.from(out, "latin1");
}

// Lee TODOS los campos y consume exactamente el buffer (lanza si sobra basura).
// Los wire-2 se clasifican: pb anidado si parsea completo y NO es imprimible;
// str si es utf8 imprimible; len crudo en el resto. La eleccion es perdedora
// entre str y pb-parseable: str gana y re-encode es identico de todos modos.
export function decodePb(buf, depth = 0, out = []) {
	if (depth > 16) throw new Error("pb demasiado anidado");
	let i = 0;
	while (i < buf.length) {
		const { v: tag, i: i0 } = readVarint(buf, i);
		const field = Number(tag >> 3n), wire = Number(tag & 7n);
		i = i0;
		if (field === 0) throw new Error("field 0 invalido");
		if (wire === WIRE_VARINT) {
			const { v, i: i2 } = readVarint(buf, i);
			i = i2;
			out.push({ field, wire, varint: v });
		} else if (wire === WIRE_LEN) {
			const { v, i: i2 } = readVarint(buf, i);
			const l = Number(v); i = i2;
			const bytes = buf.subarray(i, i + l);
			if (l < 0 || i + l > buf.length) throw new Error("len desbordado");
			i += l;
			out.push({ field, wire, ...classifyLen(bytes) });
		} else if (wire === 1 || wire === 5) {
			const n = wire === 1 ? 8 : 4;
			out.push({ field, wire, bytes: buf.subarray(i, i + n) });
			i += n;
		} else {
			throw new Error(`wire type ${wire} no soportado en field ${field}`);
		}
	}
	return out;
}

const isPrintable = (b) =>
	b.length > 0 && [...b].every((c) => (c >= 32 && c < 127) || c === 9 || c === 10 || c === 13);

function classifyLen(bytes) {
	if (isPrintable(bytes)) return { kind: "str", str: bytes.toString("utf8") };
	try {
		return { kind: "pb", pb: decodePb(bytes, 1) };
	} catch {
		return { kind: "len", bytes };
	}
}

export function encodePb(nodes) {
	const parts = [];
	const push = (tag, ...rest) => {
		parts.push(encodeVarint(tag), ...rest);
	};
	for (const n of nodes) {
		const tag = BigInt(n.field) << 3n | BigInt(n.wire);
		if (n.wire === WIRE_VARINT) {
			push(tag, encodeVarint(n.varint));
		} else if (n.wire === 1 || n.wire === 5) {
			// fixed-width: SIN prefijo de largo
			push(tag, Buffer.from(n.bytes));
		} else {
			const body =
				n.kind === "pb" ? encodePb(n.pb) :
				n.kind === "str" ? Buffer.from(n.str, "utf8") :
				Buffer.from(n.bytes);
			push(tag, encodeVarint(BigInt(body.length)), body);
		}
	}
	return Buffer.concat(parts);
}

// ---------- frames DGW ----------

export const FRAME = {
	HANDSHAKE: 0x0f, DATA: 0x0d, ACK: 0x0c,
	PING: 0x09, PONG: 0x0a,
	FLAG_CLIENT: 0x80, FLAG_SERVER: 0x00,
};

// Layout unificado (verificado frame a frame en el fixture):
//   [0]      tipo
//   [1..2]   00 00 reservado
//   [3..4]   len u16 LE = total del frame - 6 (cuenta el body desde [6])
//   [5]      00 reservado
//   [6..]    body
// Para tipo 0x0d el body lleva un prefijo de 2 bytes antes del payload. En la
// captura: cliente = 00 80 + JSON {"req-id","payload":b64}; servidor = 01 00 /
// 00 02 / 03 00 + protobuf. La semantica del par no esta confirmada; se
// PRESERVA verbatim (parseFrame -> prefix -> buildFrame) para no dañar tramas.
// Para 0x0f (handshake) y 0x0c (ack) el body ES el payload directo.

export function buildFrame(type, payload, prefixOrFlag) {
	const p = payload instanceof Buffer ? payload : Buffer.from(payload);
	let body = p;
	if (type === FRAME.DATA) {
		const prefix = Buffer.isBuffer(prefixOrFlag)
			? prefixOrFlag
			: Buffer.from([0x00, prefixOrFlag ?? FRAME.FLAG_SERVER]);
		body = Buffer.concat([prefix, p]);
	}
	const head = Buffer.alloc(6);
	head[0] = type;
	head.writeUInt16LE(body.length, 3);
	return Buffer.concat([head, body]);
}

export function parseFrame(buf) {
	if (buf.length === 1) return { type: buf[0], keepalive: true };
	if (buf.length < 6) throw new Error(`frame corto (${buf.length}b)`);
	const type = buf[0];
	const len = buf.readUInt16LE(3);
	if (len !== buf.length - 6)
		throw new Error(`len incoherente: len=${len} total=${buf.length}`);
	const body = buf.subarray(6);
	if (type === FRAME.DATA) {
		return { type, len, prefix: body.subarray(0, 2), flag: body[1], payload: body.subarray(2) };
	}
	return { type, len, payload: body };
}

// ---------- extraccion de JSON embebido en recv pb ----------

// El servidor manda pb cuyos leaf str contienen JSON …{"seq","type","response"/…}.
// Devuelve los objetos JSON parseables encontrados (recursivo, max ~100 leafs).
export function extractJsons(payload, max = 100) {
	const jss = [];
	const walk = (nodes) => {
		for (const n of nodes) {
			if (jss.length >= max) return;
			if (n.wire !== WIRE_LEN) continue;
			if (n.kind === "str") {
				if (n.str[0] === "{" || n.str[0] === "[") {
					try { jss.push(JSON.parse(n.str)); } catch { /* no es JSON */ }
				}
			} else if (n.kind === "pb") {
				walk(n.pb);
			}
		}
	};
	try { walk(decodePb(payload)); } catch { /* payload irreconocible */ }
	return jss;
}
