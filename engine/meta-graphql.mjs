// meta-graphql.mjs — capa graphql de meta.ai para el ciclo de vida de las
// conversaciones (crear/reanudar un chat, ponerlo en modo, renombrarlo).
//
// Descubierto en las capturas del navegador (2026-11-01):
//   - useConversationWarmupMutation (e7f80258...) { conversationId }
//       -> "warmupConversation": true. ES lo que hace que un conversation_id
//          generado por el cliente quede atado a un chat real del usuario.
//   - useUpdateConversationModeMutation (c32bbe99...) { input:{conversationId, mode} }
//   - usePendingConversationReconcileQuery (cbdb4f17...) {}
//       -> lista los chats del usuario (id, titulo, ultimo mensaje).
//   - useEctoRenameConversationMutation (2775bdbd...) { input:{id, title} }
//   - useMarkConversationLastSeenMessageMutation (0b2cb3a4...) { input:{...} }
//   - useSaveMessageLatencyMutation (26999e5d...) { input:{messageId, conversationId, ...} }
//
// Requiere la sesion propia (cookie + token). Con usuario invitado la API
// acepta el token pero el chat no queda registrado en la cuenta.

const ORIGIN = "https://www.meta.ai";

export const DOC = {
	warmup: "e7f802582dbfed8e181b012e010993eb",
	updateMode: "c32bbe999c48e64e855dc63177d5153f",
	reconcile: "cbdb4f17ee16ba3117147e9619026b8c",
	reconcileViewerActions: "526f609db8dcba75dabaaeb170268907",
	rename: "2775bdbd0886fb2056fae9c68d323368",
	markLastSeen: "0b2cb3a499606dfe326807a2b8b7ee20",
	saveMessageLatency: "26999e5d1366c257595b7fafa7822c31",
	deleteConversation: "ad35bda8475e29ba4264ef0d6cc0958a",
};

const FRIENDLY = {
	warmup: "useConversationWarmupMutation",
	updateMode: "useUpdateConversationModeMutation",
	reconcile: "usePendingConversationReconcileQuery",
	reconcileViewerActions: "usePendingConversationReconcileViewerActionsQuery",
	rename: "useEctoRenameConversationMutation",
	markLastSeen: "useMarkConversationLastSeenMessageMutation",
	saveMessageLatency: "useSaveMessageLatencyMutation",
	deleteConversation: "useEctoDeleteConversationMutation",
};

export class MetaGraphQL {
	constructor({ token, cookies, abraUserId, userAgent } = {}) {
		this.token = token ?? null;
		this.cookies = cookies ?? null;
		this.abraUserId = abraUserId ?? null;
		this.userAgent = userAgent
			?? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
	}

	async call(docId, variables, friendlyName) {
		const headers = {
			"content-type": "application/json",
			accept: "multipart/mixed, application/json",
			origin: ORIGIN,
			referer: `${ORIGIN}/`,
			"user-agent": this.userAgent,
		};
		if (this.token) headers.authorization = `Bearer ${this.token}`;
		if (this.cookies) headers.cookie = this.cookies;
		if (this.abraUserId) headers["x-abra-user-id"] = this.abraUserId;
		if (friendlyName) headers["x-fb-friendly-name"] = friendlyName;

		const res = await fetch(`${ORIGIN}/api/graphql`, {
			method: "POST",
			headers,
			body: JSON.stringify({ doc_id: docId, variables }),
		});
		const text = await res.text();
		let body;
		try { body = JSON.parse(text); }
		catch {
			const m = text.match(/\{"data":[\s\S]*?\n--/);
			body = m ? JSON.parse(m[0].replace(/\n--$/, "")) : { raw: text.slice(0, 300) };
		}
		if (!res.ok) throw new Error(`graphql ${docId}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
		if (body?.errors?.length) {
			const msg = body.errors.map((e) => e?.message).filter(Boolean).join("; ");
			throw new Error(`graphql ${docId}: ${msg || "error"}`);
		}
		return body?.data ?? {};
	}

	/** Atada el conversation_id al chat del usuario (clave para que el hilo persista). */
	async warmup(conversationId) {
		const d = await this.call(DOC.warmup, { conversationId }, FRIENDLY.warmup);
		return d?.warmupConversation === true;
	}

	async setMode(conversationId, mode = "think_fast") {
		const d = await this.call(DOC.updateMode, { input: { conversationId, mode } }, FRIENDLY.updateMode);
		return d?.updateConversationMode ?? null;
	}

	/** Chats del usuario: [{ conversationId, title, lastSendMessageTimestampMs }] */
	async conversations() {
		const d = await this.call(DOC.reconcile, {}, FRIENDLY.reconcile);
		const edges = d?.conversations?.edges ?? [];
		return edges.map((e) => ({
			conversationId: e?.node?.conversationId ?? e?.node?.id ?? null,
			title: e?.node?.title ?? e?.node?.displayTitle ?? null,
			lastSendMessageTimestampMs: e?.node?.lastSendMessageTimestampMs ?? null,
		})).filter((c) => c.conversationId);
	}

	async rename(conversationId, title) {
		const d = await this.call(DOC.rename, { input: { id: conversationId, title } }, FRIENDLY.rename);
		return d?.renameConversation ?? null;
	}

	async markLastSeen(conversationId, lastSeenMessageId) {
		const d = await this.call(DOC.markLastSeen, { input: { conversationId, lastSeenMessageId } }, FRIENDLY.markLastSeen);
		return d?.markConversationLastSeenMessage ?? null;
	}

	async saveMessageLatency(input) {
		const d = await this.call(DOC.saveMessageLatency, { input }, FRIENDLY.saveMessageLatency);
		return d?.message ?? null;
	}

	/** Borra un chat de la cuenta. variables { input: { id: conversationId } } */
	async deleteConversation(conversationId) {
		const d = await this.call(DOC.deleteConversation, { input: { id: conversationId } }, FRIENDLY.deleteConversation);
		return d?.deleteConversation ?? null;
	}
}
