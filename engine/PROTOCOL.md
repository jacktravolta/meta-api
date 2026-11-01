// PROTOCOLO.md — contrato reverse-engineered del gateway de Meta AI (clippy/DGW)
// Fri Nov 14 2026 — extraido de capturas reales del front autenticado (Chrome beta 149)
// y de bundles publicos de www.meta.ai. Sin navegador en runtime.

# Gateway wss://gateway.meta.ai/ws/clippy

## Handshake (URL de conexion)
	wss://gateway.meta.ai/ws/clippy
	  ?x-dgw-appid=1522763855472543
	  &x-dgw-appversion=1.0.0
	  &x-dgw-authtype=15%3A0
	  &x-dgw-version=5
	  &x-dgw-uuid=0
	  &x-dgw-tier=prod
	  &Authorization=ecto1%3A<TOKEN>
	  &x-dgw-app-origin=meta.ai
	  &x-dgw-app-clippy-request-id=<uuid4>

El TOKEN (ecto1:...) NO es la cookie ecto_1_sess: la entrega un endpoint de
intercambio. Pista encontrada en el bundle 1hevzi2weu6be.js (~offset 63160):

	- Query Relay persistida "EctoDGWConnectionContextQuery"
	  params.id (doc_id) = 857db061f63750507640786044a4c684
	  campos: viewer.developerOverrides + viewer.clippyIp
	- Fabrica de conexion DGW (modulo 274601) acepta
	  { endpoint: "wss://gateway.meta.ai/ws",
	    appId: "1522763855472543",
	    authType: "15:0" (ABRA),
	    authToken: <externo>, deviceId: randomUUID(), fbId: "0" }
	  => el authToken lo entrega OTRO endpoint (pendiente: grepear "authToken"
	  producers en chunks: buscar "AbraAuth", "AccessToken", "dgw_token").

## Frames DGW (binario)

Estructura verificada FRAME A FRAME con la captura real (2026-10-31).
Regla unica: **len = total_del_frame - 6** (cuenta el body desde [6]).

	[0]     tipo: 0x0f handshake JSON, 0x0d datos, 0x0c ack corto,
	             0x09 ping(cliente) / 0x0a pong(servidor) = 1 byte solo
	[1..2]  reserved (00 00)
	[3..4]  len u16 LITTLE-ENDIAN = total - 6
	[5]     reserved (00)
	[6..]   body (len bytes)

Semantica del body por tipo:

	0x0f  body = JSON directo (handshake cliente y respuesta servidor)
	0x0c  body = 2 bytes (00 00) — ack sin payload
	0x0d  body = prefijo de 2 bytes + payload:
	        cliente  : 00 80 + JSON {"req-id","payload":<b64-pb>}
	        servidor : 01 00 / 00 02 / 03 00 + protobuf crudo
	      (la semantica del prefijo NO esta confirmada — se preserva verbatim;
	       parseFrame -> prefix -> buildFrame round-trip byte a byte)

Keepalive: cliente envia 0x09, servidor responde 0x0a (confirmado en captura).
El codec de referencia es `engine/pb.mjs` (parseFrame/buildFrame/decodePb/
encodePb) con tests golden en `engine/gateway.test.mjs`.

## Gateway handshake (tipo 0x0f, cliente -> srv)
	{
		"x-dgw-app-x-ecto-conversation-id": "<uuid4 del chat>",
		"x-dgw-app-client-payload-type": "PROTO_INSIDE_JSON"
	}
	srv responde { "code": 200 }.

## Request de envio (tipo 0x0d, flag 0x80)
	{
		"req-id": "<uuid4>",
		"payload": "<b64 PB>"
	}

El PB (1030 bytes con prompt "responde solo: hola"), estructura detectada:

	f1 { f1 "KADABRA__HOME__UNIFIED_INPUT_BAR" }        # surface de origen
	f5? <appid 1522763855472543>
	app-session: 5a5b-8d4e-f054-99ef-b2de-db02-0d05-52c7
	conversation: 29cb0c02-c081-4f5f-a63d-5637c3ee9225   # mismo id del hs
	HUMAN_AGENT
	player_id: 867051314767696
	"ECTO1Z" "Abra Web Main Key"                          # version de schema
	MODE_FAST
	os: Linux
	user_input: { field: "user_input", ua completa }
	plataforma: desktop_web
	sha de build: 467ac00fac43b3f1e9b4405009b6a555e912c23d79e8c7f9bf1f2b668bec3fa3
	mensaje utf8: "responde solo: hola" en offset 1006
	cola final: req-id duplicated + idempotencia

## Respuesta (tipo 0x0d srv, protobuf crudo)
	Dentro hay JSON utf8 con:
		{ "seq": 0, "type": "full",
		  "response": { "response_id": "...",
		                "sections": [ { "view_model": {
		                  "__typename": "GenAISingleLayoutViewModel",
		                  "primitive": {
		                    "__typename": "GenAIMarkdownTextUXPrimitive",
		                    "text": "hola"          ### TEXTO FINAL
		                  }}}]}}
	Despues: seq=1 "type":"patch" "operations":[] = limpieza, no datos.
	Otro JSON equivalente sin elapsed: plain {"response_id","sections"}.

	Reconstruccion de texto: concatenar full.text + patch.operations
	(los patch con operaciones no vacias traen slices de texto por delta).
	Stream termina al llegar de nuevo modal con type=full + siguiente patch vacio:
	un ping/pong 0x0b/0x0a sigue tras el final.

## Implementacion existente (2026-11-01)
	- `pb.mjs`        codec frames DGW + protobuf (round-trip byte a byte probado)
	- `gateway.mjs`   cliente MetaGateway: connect/chat/close, slots del envelope,
	                  errores tipados por codigo de cierre, keepalive 0x09
	- `probe.mjs`     prueba en vivo: META_ECTO_TOKEN=... node engine/probe.mjs "hola"
	- `gateway.test.mjs`  9 tests golden (node --test) — TODOS EN VERDE

## Pendientes (para motor HTTP puro)
	1. Token ecto1: procedencia a gemelar en bundles JS de www.meta.ai
	2. Forma de patch.operations NO VACIO (streaming por delta) — sin capturar;
	   gateway.mjs lo loguea y por ahora resuelve con el ultimo `full` al
	   llegar el patch vacio (seq>0)
	3. Verificar semantica del prefijo de 2 bytes de las tramas 0x0d servidor
	4. Datos del envelope sin nombrar (f1.*): app-session, player, pipes,
	   "blocking_confirmation", etc. — hoy pasan por template intactos
