# PLAN — Motor protocol-first para Meta AI (handoff de agente)

> Ticket ejecutable para la próxima sesión que tome esto. El protocolo ya está
> descifrado y documentado en **PROTOCOL.md** (leer PRIMERO, junto con el fixture
> `fixtures/capture-ws-20261031.json`). Este doc cubre QUÉ falta, en QUÉ orden y
> CÓMO saber si quedó bien.

## Estado del arte (resumen 2 líneas)

- El envío autenticado del meta.ai actual NO es HTTP scraping: es WebSocket
  `wss://gateway.meta.ai/ws/clippy` con frames DGW binarios (JSON-with-protobuf
  del cliente, protobuf-with-JSON embebido del servidor).
- El decodificador genérico existe (`dgw-decode.mjs`) y la extracción de texto
  final está probada contra fixtures reales: `sections[].view_model.primitive`
  (`GenAIMarkdownTextUXPrimitive.text`) — ver `dgw-keys.mjs`.

## Inventario engine/

| archivo | rol |
|---|---|
| `PROTOCOL.md` | Spec del protocolo DGW/clippy (contract). Actualizar al cambiar cualquier constante. |
| `dgw-decode.mjs` | Decodificador genérico de frames + protobuf. CLI: `node dgw-decode.mjs <captura.json>`. |
| `dgw-keys.mjs` | Análisis dirigido: extrae JSON embebidos y ubica el prompt en el payload. |
| `capture-sess.mjs` | Captura de requests HTTP al boot de meta.ai (usa CDP sobre Chrome en puerto 9298). |
| `capture-ws.mjs` | Captura de WebSocket + frames DGW (CDP, puerto 9298). Generó capture-ws.json. |
| `capture-boot.mjs`, `capture-auth.mjs`, `capture.mjs`, `debug.mjs` | Iteraciones anteriores de captura. |
| `abra.mjs` | Cliente del flujo VIEJO (temp-user GraphQL, doc_id 7604648749596940). **MUERTO**: meta.ai hoy devuelve 403 x-fb-rd al scraping SSR. No usar; reemplazar. |
| `probe.mjs` | CLI de prueba de engine (targetea el flujo viejo — reescribir). |
| `fixtures/capture-ws-20261031.json` | Captura real sanitizada (token Authorization REDACTADO). Fixture golden de regresión. |

## Pasos pendientes (en orden)

### 1. Origen del token `ecto1:` (bloquea todo lo demás)
Lead probado: query Relay persistida **EctoDGWConnectionContextQuery**,
`params.id (doc_id) = 857db061f63750507640786044a4c684`, campos
`viewer.developerOverrides` + `viewer.clippyIp` — en el bundle público
`/_next/static/immutable/chunks/1hevzi2weu6be.js` (~offset 63160).
La fábrica DGW (módulo 274601 del mismo chunk) toma `authToken: <externo>`,
o sea lo produce OTRO endpoint. Cómo cerrarlo:
1. Bajar los bundles de nuevo (corre el procedimiento de abajo, es HTTP público).
2. Grep en chunk completo por `authToken` producers: `AbraAuth`, `AccessToken`,
   `dgw_token`, `getAuthorization`, `fetchQuery(EctoDGWConnectionContext`.
3. Hipótesis principal: POST `https://www.meta.ai/api/graphql` con ese doc_id
   (u otro mutation tipo EctoDGWAuthToken) y cookie `ecto_1_sess` devuelve el
   token. Verificar contra red real.
   * Si demanda flow avanzado hacé una captura de boot (capture-boot.mjs) con
     sesión viva y diff del body de `/api/graphql`.

### 2. Encoder protobuf del request
El decodificador ya mapea los campos (ver sección "Request de envio" en
PROTOCOL.md). Faltan: serializador inverso con los NÚMEROS de field definitivos
(reconstruir con `node dgw-decode.mjs` sobre el fixture y nombrar f1+f5...).
Tip: el PB lleva `req-id` duplicado al final (idempotencia) y UA copiada del
navegador — decidir qué se hardcodea vs se parametriza.
**Criterio de aceptación:** el encoder genera bytes idénticos al fixture
(colors fixos a parte: timestamps/ids). Test `node --test`.

### 3. Cliente gateway `engine/gateway.mjs` (zero-deps)
- Conectar WSS con los parámetros de URL de PROTOCOL.md (Node 22
  `globalThis.WebSocket` disponible; Node 18 NO — ver env).
- Handshake tipo 0x0f ({ecto-conversation-id, PROTO_INSIDE_JSON}) → esperar
  `{"code":200}`.
- Enviar tipo 0x0d flag 0x80: JSON `{"req-id","payload":b64}`.
- Keepalive: frames de 1 byte 0x09 (cli→srv) / 0x0a (srv→cli); replicar el
  ritmo de la captura (sent cada ~?s — re-verificar live).
- Reconstrucción de texto: `full.text` + `patch.operations` hasta patch vacío
  (`{"seq":N,"type":"patch","operations":[]}` = fin de stream).
- Códigos de cierre documentados (NORMAL_CLOSURE 1000, UNAUTHORIZED 4003,
  REJECTED 4004, BAD_REQUEST 4005, KEEPALIVE_TIMEOUT 4001) — mapear a errores
  tipados del engine.
**Criterio de aceptación:** `probe.mjs "hola"` devuelve "hola" con token real.

### 4. Integración en `server.mjs`
Doble engine detrás de `META_ENGINE=graphql|browser` (env, default browser):
- `graphql`: engine nuevo (gateway.mjs). Sin tabs, concurrency por connection.
- `browser`: flow CDP actual (línea ~1178, askMeta) intacto — QUIEDA COMO MOTOR
  DE RESPALDO para cuando el protocolo cambie.
- Fallback automático: si graphql falla 3x con 4003/4004/4005 → log warn y
  degradar a browser en caliente.
- `/v1/agent` (si existe con browser) NO migrar hasta validar transcript.

### 5. Tests golden + runbook de cambio de protocolo
- Fixture: `fixtures/capture-ws-20261031.json` (sanitizado). Script de test:
  decodificar → parsear req json + extraer texto de recv → assert "hola".
- Al romperse: RE-correr capture-ws.mjs → `node dgw-decode.mjs <nueva>` →
  diff contra PROTOCOL.md → actualizar SOLO constantes (appid, doc_id, surface,
  schema key "ECTO1Z", framing offsets). Nunca rehacer inventario desde cero.

### 6. Seguridad — NO NEGOCIABLE (incidente real 2026-10-31)
- **NUNCA** abrir Chrome con el perfil REAL del usuario ni copias de su perfil
  sin aprobación explícita y en el momento. Copiar el perfil + lanzar segunda
  instancia dispara anti-fraude de proveedores y REVOKA la sesión del usuario
  (Gmail quedó deslogueado por eso).
- Todo test autenticado: (a) token pasado por el usuario en ENV puntual, o
  (b) cuenta dedicada para el API con perfil throwaway en `/tmp/opencode`.
- Capturas a `/tmp/opencode/`; antes de commitear cualquier fixture, REDACTAR
  `Authorization=ecto1%3A...` y cookies (ver fixture sanitizado como ejemplo).
- Node: usar `~/.nvm/versions/node/v22.23.3/bin/node` (Node 18 no trae
  WebSocket global — el error "TypeError: WebSocket is not a constructor").

## Procedimiento para bajar bundles público (sin sesión, sin riesgo)

```sh
cd /tmp/opencode/mb
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
curl -s -c jar.txt -A "$UA" https://www.meta.ai/ -o c.html                # 403 challenge
CH=$(grep -o "/__rd_verify_[^\"']*challenge=[0-9]*" c.html | head -1)
curl -s -b jar.txt -c jar.txt -X POST "https://www.meta.ai${CH}" -o /dev/null
curl -s -b jar.txt -c jar.txt -A "$UA" https://www.meta.ai/ -o home.html  # 181KB real
grep -o '/_next/static/immutable/chunks/[a-zA-Z0-9_-]*\.js' home.html | sort -u > chunks.txt
mkdir -p js
while read c; do curl -s -b jar.txt -A "$UA" "https://www.meta.ai${c}" -o "js/$(basename $c)"; done < chunks.txt
```

## Decisiones de diseño pendientes de cerrar con el owner
1. Cuenta dedicada para el API vs token del usuario pasado a mano.
2. ¿Stream parcial al cliente (SSE) o respuesta completa como hoy? El protocolo
   entrega deltas — natural para streaming si el caller lo pide.

---
*Fecha de última captura real: 2026-10-31. Chrome beta 149 / Linux x86_64.*
*Cualquier diff de protocolo += fecha nueva + fixture nuevo en fixtures/.*
