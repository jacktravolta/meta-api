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
	f1.5.1/3 timestamps de INICIO de sesion/stream (CONSTANTES por conexion)
	f1.6     request id (DEBE coincidir con el "req-id" del JSON wrapper)
	f1.9.2   locale ("es-LA" / "es-ES")
	f1.10.1/3 flow ids por request (se rotan)
	f1.10.4  conversation id
	f1.18    pipes de herramientas (stocks, weather, media_gallery, ...)
	f2.1.1   turn id
	f2.1.2.1 conversation id
	f2.1.2.2 timestamp epoch ms del MENSAJE
	f2.1.2.3 uniqueMessageId (snowflake) — NUEVO en cada mensaje
	f2.1.5   PROFUNDIDAD del hilo (mensajes llevados) — 1, 2, 3...
	f2.2     EL PROMPT (este es el slot que se reemplaza)
	f2.3     ADJUNTOS (repetido): f1.1=media_id, f2=1, f5=0, f6=mime, f7=nombre
	f2.4.1   "0"

Slots que el motor reemplaza en cada envio (por RUTA, no por valor):
	prompt, turn id, conversation id, request id, timestamps del mensaje,
	uniqueMessageId, profundidad del hilo, flow ids, player id + accountId
	(cuando se conoce el usuario) y los adjuntos.

### Los 4 campos que gobiernan la memoria del hilo (los que mas costaron)

	1. f2.1.2.3 uniqueMessageId — NUEVO en cada mensaje. Es un snowflake:
	   (Date.now() en ms << 22) | random(22 bits). Si se repite, el gateway
	   responde con la RESPUESTA DEL MENSAJE ANTERIOR (no genera nada nuevo).
	2. f2.1.5 profundidad del hilo — cuantos mensajes lleva la conversacion.
	   Si queda en 1, el gateway trata el mensaje como el primero de una
	   conversacion nueva: responde, pero SIN memoria de lo anterior.
	3. f1.5.1 / f1.5.3 — timestamps de inicio de sesion/stream. Deben quedar
	   CONSTANTES durante el hilo. Si se refrescan en cada mensaje, el gateway
	   queda esperando el stream anterior: el WS se queda mudo (timeout).
	4. f1.6 request id = "req-id" del JSON wrapper = messageId.

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

## Runbook de drift (cuando Meta muta el protocolo)

	Señales de drift, en orden de probabilidad:
	  1. `template: N slots — drift de protocolo probable` → el motor no
	     encontró las rutas que sustituye (cambió el schema del envelope).
	  2. El handshake responde code != 200 o el WS cierra 4005 → cambió la
	     validación del upgrade (Origin/UA/cabeceras).
	  3. Responde pero sin texto → cambió la forma de la respuesta (secciones).
	  4. Devuelve SIEMPRE la respuesta anterior → el uniqueMessageId (f2.1.2.3)
	     dejo de ser único por mensaje.
	  5. Responde pero sin memoria → la profundidad del hilo (f2.1.5) cambio de
	     ruta o de semantica.

	Procedimiento:
	  1) Capturar de nuevo (perfil dedicado, CDP 9298):
	       node engine/capture-full.mjs 9298        # mensaje + imagen + cabeceras
	       node engine/capture-pair.mjs 9298        # dos mensajes del mismo chat
	  2) Comparar el envelope nuevo contra el contrato, sin adivinar:
	       node engine/check-slots.mjs               # fixture mas reciente
	       node engine/check-slots.mjs <captura.json>   # captura nueva
	     El script lista las rutas, dice cuales slots faltan y hace el diff
	     contra el fixture anterior (rutas nuevas/eliminadas y valores).
	  3) Si las rutas cambiaron: actualizar las rutas en `insertSlots`
	     (engine/gateway.mjs) y guardar la captura nueva en
	     `engine/fixtures/capture-ws-<fecha>.json` (token REDACTED).
	  4) Regenerar los tests golden: `node --test engine/gateway.test.mjs`.
	  5) Verificar en vivo, en este orden:
	       a) texto simple      → responde
	       b) memoria           → turno 1 guarda un dato, turno 2 lo recalls
	       c) imagen            → PNG verde → "Verde"
	       d) reconexion        → cerrar la WS y volver a preguntar
	     Para (b) y (d) esperar >120 s entre turnos: es lo que delata los
	     errores de profundidad y de timestamps.

	Nota: los ids, timestamps y flow ids cambian en CADA envio. El diff solo es
	alarmante si cambian las RUTAS o los TIPOS de los valores.

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
	- `meta-graphql.mjs`  ciclo de vida de la conversacion (warmup, modo, rename)
	- `upload.mjs`        subida de adjuntos a rupload.meta.ai -> media_id
	- `broker-engine.mjs` pool de canales (user+channel) con memoria y renovacion
	- `multichannel.mjs`  emulacion multicanal con prueba de memoria
	- `check-slots.mjs`   verificador de drift: rutas, slots faltantes y diff

## Ciclo de vida de la conversacion (graphql)

	El front NO usa el WS para todo: el WS genera la respuesta, pero el chat se
	crea/actualiza por graphql. Para que un conversation_id generado por el
	cliente quede atado a un chat real (y conserve memoria), hay que llamar:

		useConversationWarmupMutation      e7f802582dbfed8e181b012e010993eb
		    variables { conversationId }           -> { warmupConversation: true }
		useUpdateConversationModeMutation  c32bbe999c48e64e855dc63177d5153f
		    variables { input:{conversationId, mode:"think_fast"} }
		usePendingConversationReconcileQuery cbdb4f17ee16ba3117147e9619026b8c
		    variables {}                            -> lista los chats del usuario
		useEctoRenameConversationMutation  2775bdbd0886fb2056fae9c68d323368
		    variables { input:{id, title} }
		useMarkConversationLastSeenMessageMutation 0b2cb3a499606dfe326807a2b8b7ee20
		    variables { input:{conversationId, lastSeenMessageId} }
		useSaveMessageLatencyMutation      26999e5d1366c257595b7fafa7822c31
		    variables { input:{messageId, conversationId, uniqueMessageId, requestId} }

	Con warmup + el MISMO conversation_id, el hilo conserva memoria incluso
	tras cerrar y reabrir el WS (verificado: el bot recuerda un codigo).

## Adjuntos: como viajan las imagenes (mapeado completo)

	1) SUBIDA (fuera del WS):
	   POST https://rupload.meta.ai/gen_ai_document_gen_ai_tenant/<uuid>
	     Authorization: OAuth ecto1:<token>     (OJO: "OAuth", NO "Bearer")
	     ecto_auth_token: true
	     is_abra_user: true
	     desired_upload_handler: genai_document
	     Offset: 0
	     x-entity-length: <bytes>
	     x-entity-digest: sha256 <base64 del contenido>
	     x-entity-type: image/png
	     x-entity-name: <nombre del archivo>
	     body: binario crudo
	   -> { "media_id": "1431172098550174" }
	   (el front hace antes un GET de sondeo con las mismas cabeceras)

	2) ENVELOPE: f2.3 (mensaje repetido) con
	     f2.3.1.1 = media_id (varint)
	     f2.3.2  = 1
	     f2.3.5  = 0
	     f2.3.6  = mime
	     f2.3.7  = nombre
	   y el prompt lleva el marcador delante del texto:
	     "<|attachment:0|> <texto>"

	VERIFICADO end-to-end: PNG verde enviado por la API -> meta responde "Verde".

## Cierre de turno (reglas verificadas en vivo)

	El stream de una respuesta llega en 3 formas distintas segun la longitud y
	el estado de la sesion. Las tres se resuelven en gateway.mjs:

	1. `full` (seq=0) con `GenAIMarkdownTextUXPrimitive.text` = texto base.
	2. `patch` (seq=1) con `operations:[{op:"delta", path:"/sections/N/view_model/primitive/text", value:"..."}]`
	   = deltas que se aplican sobre el acumulado (JSON pointer).
	   Tambien aparece `op:"add"` con `path:"/sections/1"` y el valor completo de la
	   seccion (la respuesta entra asi cuando el front ya la compuso).
	3. Cierre: un `patch` con `operations:[]` DESPUES de haber texto.
	   En la sesion con cuenta, el cierre es ademas un frame "final": JSON con
	   `response_id` + `sections` y SIN campo `type` (estado completo de la respuesta).

	Trampa: los parches vacios tambien llegan durante la fase de "pensando"
	(heartbeats), ANTES del texto. Si se cierra el turno ahi, se devuelve la
	respuesta del turno anterior o null.

	Trampa 2: el frame "final" de la respuesta anterior llega DESPUES del patch
	vacio de cierre y queda encolado: si el turno siguiente lo consume, cree que
	es su propia respuesta. Se descarta por `response_id` (el gateway recuerda el
	del turno anterior) y se vacia la cola al empezar un turno.

	Trampa 3: los frames DGW llegan troceados entre mensajes WS y/o varios
	concatenados en uno: el len del header solo cubre el primer frame. Hay que
	acumular bytes en un buffer y extraer frame a frame (engine/gateway.mjs).

## Vida util de las credenciales (medido 2026-11-01)

	- Token de invitado (`ecto1:` de createTempUser): caduca ~30-60 min.
	  Al expirar, el gateway cierra 4003 "Unauthorized 401" ANTES del handshake.
	  Se crea otro invitado (nueva identidad) y la conversacion se retoma
	  pasando el resumen del hilo como contexto.
	- Token de sesion propia: mismo tipo de credencial; si caduca, hay que
	  recapturarlo del navegador (engine/capture-session.mjs, sin enviar mensajes).

## Pendientes
	1. Semantica del prefijo de 2 bytes de las tramas 0x0d servidor
	2. Envelope: campos aun sin nombre (app-session, pipes, blocking_confirmation)
	3. Continuar una conversacion con una identidad nueva: hoy se pasa el
	   resumen como contexto, no el historial completo del hilo
	4. Imagenes: el envelope del protocolo no las transporta (queda en browser)
