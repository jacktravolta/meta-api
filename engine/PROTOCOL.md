// PROTOCOLO.md — contrato reverse-engineered del gateway de Meta AI (clippy/DGW)
// Actualizado 2026-11-01 — verificado contra el front real (Chrome beta 149) y
// los bundles publicos de www.meta.ai. Sin navegador en runtime.
// ESTADO: motor funcionando end-to-end (invitado autonomo y cuenta propia).

# Gateway wss://gateway.meta.ai/ws/clippy

## REQUISITO CRITICO (el que costo horas)
	El upgrade HTTP DEBE enviar:
		Origin: https://www.meta.ai        (URL COMPLETA — "meta.ai" a secas -> 4005)
		User-Agent: <chrome UA>
		Cookie: <cookies meta.ai>            (solo si hay sesion; no hace falta para invitado)
	Si el Origin falta o va mal, el gateway cierra 4005 "Pre-Auth Validation Failed"
	ANTES de responder el handshake. No es un error de payload: es del upgrade.

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

El TOKEN (ecto1:...) NO es la cookie ecto_1_sess. Hay DOS formas de obtenerlo:

### A) Invitado (autonomo, sin cuenta, sin cookies) — RECOMENDADO
	POST https://www.meta.ai/api/graphql
	  doc_id 128302cfa314f375be53f53a266699fd  (useCreateTempUserMutation)
	  body {"doc_id":"128302cfa314f375be53f53a266699fd","variables":{}}
	  => {"data":{"createTempUser":{"success":true,
	       "accessToken":"ecto1:...","abraUserId":"1443246682202986"}}}
	El accessToken devuelto YA viene con el prefijo "ecto1:" y es el mismo
	Authorization del WS. Requiere resolver antes el challenge x-fb-rd del GET /
	(implementado en engine/auth.mjs).
	El TOS de invitado NO se puede aceptar (useAcceptTOSMutation responde
	"Unauthorized - logged-in account required"), pero el chat funciona igual.

### B) Sesion propia (cuenta logueada)
	El token se lee de la URL del WebSocket que abre el front (Network -> WS ->
	Messages -> Headers). Se recicla con engine/session.mjs a engine/.session.json
	(0600, fuera de git). Requiere ademas las cookies meta.ai en el upgrade.

### doc_ids utiles (extraidos de los bundles publicos)
	128302cfa314f375be53f53a266699fd  useCreateTempUserMutation
	2943394199ee6545d1f0c69d5b6e577f  useFetchTempUserCredentialsMutation
	d23d76b0aabd36269d370dacabccd810  useAcceptTOSMutation (solo cuenta logueada)
	857db061f63750507640786044a4c684  EctoDGWConnectionContextQuery
	cae7446d91dcfbdf972acc233e0aca0a  EctoLoggedOutTOSDialogContextQuery

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
	El servidor puede mandar un keepalive 0x0a ANTES del handshake: hay que
	saltar los keepalives hasta ver el frame 0x0f.

## Request de envio (tipo 0x0d, flag 0x80)
	{
		"req-id": "<uuid4>",
		"payload": "<b64 PB>"
	}

## Estructura del PB de envio (paths verificados en capturas reales)

	f1.1.1   surface "KADABRA__HOME__UNIFIED_INPUT_BAR"
	f1.1.2   appId "1522763855472543"
	f1.1.4   app-session (constante de build)
	f1.1.5   conversation id
	f1.1.6   5
	f1.1.7   "HUMAN_AGENT"
	f1.1.8   player id (x2)  -> id del usuario (invitado: abraUserId)
	f1.1.10  "ECTO1"            # version de schema
	f1.1.11  "Abra Web Main Key"
	f1.1.12  { 1000, "MODE_FAST" }
	f1.1.13  "Linux"            # os
	f1.1.14  "user_input"       # categoria
	f1.1.15  user-agent
	f1.1.16  "desktop_web"
	f1.1.19  { sha de build, ... }
	f1.2.1/2 accountId bigint (x2) -> id del usuario
	f1.2.3   userType
	f1.5.1/3 timestamps epoch ms
	f1.6     request id (DEBE coincidir con el "req-id" del JSON wrapper)
	f1.9.2   locale ("es-LA" / "es-ES")
	f1.10.1/3 flow ids por request (se rotan)
	f1.10.4  conversation id
	f1.18    pipes de herramientas (stocks, weather, media_gallery, ...)
	f2.1.1   turn id
	f2.1.2.1 conversation id
	f2.1.2.2 timestamp epoch ms
	f2.1.2.3 varint grande (origen desconocido)
	f2.2     EL PROMPT (este es el slot que se reemplaza)
	f2.4.1   "0"

Slots que el motor reemplaza en cada envio (por RUTA, no por valor):
	prompt, turn id, conversation id, request id, timestamps, flow ids,
	player id + accountId (cuando se conoce el usuario).

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
	Despues: seq=1 "type":"patch" "operations":[] = fin de stream.

	Reconstruccion de texto: concatenar full.text + patch.operations
	(los patch con operaciones no vacias traen slices de texto por delta).

## Implementacion existente (2026-11-01)
	- `pb.mjs`          codec frames DGW + protobuf (round-trip byte a byte)
	- `gateway.mjs`     cliente MetaGateway: connect/chat/close, slots por ruta,
	                    errores tipados por codigo de cierre, keepalive 0x09
	- `auth.mjs`        alta de invitado por HTTP (createTempUser) + cache 0600
	- `session.mjs`     token+cookies de sesion propia, desde una captura
	- `mirror-chat.mjs` envia un prompt con el navegador y REFLEJA la conversacion
	- `capture-guest.mjs` captura el flujo invitado (sin login)
	- `replay.mjs`      reproduce una captura desde Node (diagnostico)
	- `probe.mjs`       CLI: `node engine/probe.mjs "hola" [--session]`
	- `gateway.test.mjs` 14 tests golden (node --test) — EN VERDE

## Pendientes
	1. Forma de patch.operations NO VACIO (streaming por delta) — sin capturar;
	   gateway.mjs lo loguea y resuelve con el ultimo `full` al llegar el patch vacio
	2. Semantica del prefijo de 2 bytes de las tramas 0x0d servidor
	3. Envelope: campos aun sin nombre (app-session, pipes, blocking_confirmation)
	4. Tokens de invitado: ¿caducan? ¿cuanto vive una sesion?
	5. Integrar el motor como engine del server.mjs (META_ENGINE=graphql|browser)
