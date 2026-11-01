// sweep.mjs — experimento temporal: prueba variantes del envelope para el
// flujo invitado (temp user). NO es parte del motor; sirve para descobrir
// que campos exige el pre-auth del gateway.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { buildFrame, parseFrame, decodePb, encodePb, FRAME } from "./pb.mjs";
import { PROTOCOL } from "./gateway.mjs";
import { getCredentials } from "./auth.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/capture-ws-20261031.json"), "utf8"));
const dataFrame = fixture.frames.map((f) => Buffer.from(f.data, "base64"))
	.find((b) => b[0] === FRAME.DATA && b[7] === FRAME.FLAG_CLIENT);
const sent = JSON.parse(dataFrame.subarray(8).toString("utf8"));
const template = decodePb(Buffer.from(sent.payload, "base64"));

const CAP = {
	conv: "29cb0c02-c081-4f5f-a63d-5637c3ee9225",
	turn: "5d838aa8-7de2-4909-848a-22f39edb479c",
	prompt: "responde solo: hola",
	player: "867051314767696",
	reqId: "5652aa8a-ab17-4477-af92-16c47568e7e5",
	appSession: "5a5b-8d4e-f054-99ef-b2de-db02-0d05-52c7",
	flow1: "e6b67af6-9f4e-4f26-ad1e-84146b684328",
	flow2: "24e944cb-b5d1-43f2-99b5-79cf34e19648",
	tsA: 1793499023080n, tsB: 1793499022423n, tsC: 1793499023090n,
	accountId: 1314690855052451n,
};

const clone = (list) => list.map((n) => {
	const c = { field: n.field, wire: n.wire };
	if (n.wire === 0) c.varint = n.varint;
	else { c.kind = n.kind; if (n.kind === "str") c.str = n.str; else if (n.kind === "pb") c.pb = clone(n.pb); else c.bytes = n.bytes; }
	return c;
});

function build(variant, creds) {
	const nodes = clone(template);
	const conv = randomUUID(), turn = randomUUID(), reqId = randomUUID(), now = Date.now();
	const visit = (list) => {
		for (const n of list) {
			if (n.wire === 0) {
				if (n.varint === CAP.tsA) n.varint = BigInt(now);
				else if (n.varint === CAP.tsB) n.varint = BigInt(now - 600);
				else if (n.varint === CAP.tsC) n.varint = BigInt(now);
				else if (n.varint === CAP.accountId && variant.accountId !== null) n.varint = BigInt(creds.abraUserId);
				continue;
			}
			if (n.kind === "str") {
				if (n.str === CAP.conv) n.str = conv;
				else if (n.str === CAP.turn) n.str = turn;
				else if (n.str === CAP.player) n.str = creds.abraUserId;
				else if (n.str === CAP.reqId) n.str = reqId;
				else if (n.str === CAP.appSession) n.str = Array.from({ length: 8 }, () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")).join("-");
				else if (n.str === CAP.flow1) n.str = randomUUID();
				else if (n.str === CAP.flow2) n.str = randomUUID();
				else if (n.str === "KADABRA__HOME__UNIFIED_INPUT_BAR" && variant.surface) n.str = variant.surface;
			} else if (n.kind === "pb") visit(n.pb);
		}
	};
	visit(nodes);
	// prompt + userType
	const msg = nodes.find((n) => n.field === 2 && n.kind === "pb");
	msg.pb.find((n) => n.field === 2).str = "responde en una sola palabra: ping";
	if (variant.userType !== null) {
		const u = nodes.find((n) => n.field === 2 && n.kind === "pb");
		void u;
		const top2 = nodes.find((n) => n.field === 2);
		void top2;
		// f1.2.f3 = userType
		const f1 = nodes.find((n) => n.field === 1 && n.kind === "pb");
		const f12 = f1.pb.find((n) => n.field === 2 && n.kind === "pb");
		if (f12) {
			const ut = f12.pb.find((n) => n.field === 3);
			if (ut) ut.varint = BigInt(variant.userType);
		}
	}
	return { payload: encodePb(nodes), reqId, conv };
}

async function attempt(variant, creds) {
	const { payload, reqId } = build(variant, creds);
	const url = new URL(PROTOCOL.GATEWAY_URL);
	url.search = new URLSearchParams({
		"x-dgw-appid": PROTOCOL.APP_ID,
		"x-dgw-appversion": PROTOCOL.APP_VERSION,
		"x-dgw-authtype": PROTOCOL.AUTH_TYPE,
		"x-dgw-version": PROTOCOL.DGW_VERSION,
		"x-dgw-uuid": "0",
		"x-dgw-tier": PROTOCOL.TIER,
		"Authorization": creds.accessToken,
		"x-dgw-app-origin": PROTOCOL.ORIGIN,
		"x-dgw-app-clippy-request-id": randomUUID(),
	}).toString();
	const ws = new WebSocket(url);
	ws.binaryType = "arraybuffer";
	const frames = [];
	let closeInfo = null;
	const done = new Promise((res) => {
		ws.onopen = () => {
			ws.send(new Uint8Array(buildFrame(FRAME.HANDSHAKE, JSON.stringify({
				"x-dgw-app-x-ecto-conversation-id": randomUUID(),
				"x-dgw-app-client-payload-type": "PROTO_INSIDE_JSON",
			}))));
		};
		ws.onmessage = (e) => {
			const b = Buffer.from(e.data);
			if (b.length === 1) return;
			try { frames.push(parseFrame(b)); } catch {}
			if (frames.length >= 2) { try { ws.close(); } catch {} }
		};
		ws.onclose = (e) => { closeInfo = { code: e.code, reason: e.reason }; res(); };
		ws.onerror = () => {};
		setTimeout(() => { try { ws.close(); } catch {} }, 12000);
	});
	await done;
	// resumen
	const texts = [];
	for (const f of frames) {
		if (f.type === FRAME.DATA) {
			const s = f.payload.toString("latin1");
			const m = s.match(/"text":"((?:[^"\\]|\\.)*)"/);
			if (m) texts.push(m[1]);
		}
	}
	return { close: closeInfo, frames: frames.map((f) => `0x${f.type.toString(16)}/${f.payload?.length ?? 0}b`), texts };
}

const creds = await getCredentials();
console.log("creds:", creds.abraUserId, "cached:", creds.cached);
const variants = [];
for (const userType of [null, 0, 1, 2, 3]) {
	variants.push({ userType, accountId: "swap", surface: null, label: `userType=${userType} accountId=abra` });
}
variants.push({ userType: null, accountId: null, surface: null, label: "sin swap de accountId" });
variants.push({ userType: null, accountId: "swap", surface: "KADABRA__HOME__CONVO_STARTER", label: "surface=CONVO_STARTER" });

for (const v of variants) {
	try {
		const r = await attempt(v, creds);
		console.log(`[${v.label}] close=${JSON.stringify(r.close)} frames=${r.frames.join(",")} texts=${JSON.stringify(r.texts).slice(0, 120)}`);
	} catch (e) {
		console.log(`[${v.label}] ERROR ${e.message}`);
	}
}
