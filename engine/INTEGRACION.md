# Integración de la API de Meta AI (OpenAI-compatible)

Documento de implementación: qué expone la API, cómo se usa y qué se discovered
del protocolo de Meta AI funcionando en vivo.

- **Base**: `http://127.0.0.1:8055` (variable `META_API_PORT`)
- **Motor**: `META_ENGINE=graphql` (gateway DGW de Meta, sin navegador en runtime)
- **Identidad**: `META_ENGINE_MODE=session` (tu cuenta) o `guest` (invitado)
- **Auth**: no hay; la API es local. El token de Meta **nunca** se expone.

---

## 1. Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/health` | Estado del broker + **identidad en uso** (`motor.modo`: `session` \| `guest`) + motivo del cambio. |
| `GET` | `/v1/models` | Modelos: `meta-ai`, `meta-ai-chat`. |
| `POST` | `/v1/chat/completions` | OpenAI-compatible. `stream: true` → SSE. |
| `POST` | `/v1/chat/completions/async` | Devuelve `job_id` para consultar `/v1/jobs/{id}`. |
| `POST` | `/v1/attachments` | Sube un adjunto a Meta y devuelve el `media_id`. |
| `GET` | `/v1/media/<conv>/<archivo>` | Sirve lo descargado: imágenes de Meta y archivos del sandbox. |
| `GET` | `/v1/rooms` | Registro de salas: `id corto (≤6 dígitos)` → usuario/canal. |
| `POST` | `/v1/agent` | Loop de agente propio (Meta pide comando, el broker lo ejecuta en sandbox). |
| `GET` | `/v1/jobs/{id}` | Estado/resultado de un job. |

---

## 2. Herramientas (function calling emulado)

Meta AI es un modelo de chat: **no tiene function calling nativo**. El protocolo
es el prompt (mismo patrón que ya usa `agent/tools.js` en el repo).

### 2.1 Cómo funciona

1. El cliente manda `tools: [{type:"function", function:{name, description, parameters}}]`.
2. La API renderiza esas tools como un **contrato de prompt** y se lo manda a Meta.
3. Meta responde con un **bloque de código con tag `tool_call`** y JSON crudo:

   ````text
   ```tool_call
   {"tool": "read", "arguments": {"path": "server.mjs"}}
   ```
   ````

4. La API lo convierte a `tool_calls` de OpenAI (`finish_reason: "tool_calls"`).
5. **El cliente ejecuta la tool** y devuelve el resultado con `role: "tool"`.
6. La API reenvía el resultado a Meta (`result` blocks) y el hilo sigue.

### 2.2 Formato de la respuesta con tool

```json
{
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": { "name": "read", "arguments": "{\"path\":\"server.mjs\"}" }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

En SSE, la tool llega como `delta.tool_calls` (con `index`, `id`, `type`,
`function.name`, `function.arguments`) y el chunk final lleva
`finish_reason: "tool_calls"`.

### 2.3 Reglas del parser (`engine/toolcall.mjs`)

- Se mira **el último** bloque con fence (anti-inyección: un bloque citado dentro
  de la prosa no puede adelantar la llamada real).
- Tags aceptados: `tool_call`, `json`, `tool`, `function` o fence sin tag.
- Se acepta un objeto o un array de objetos.
- `arguments` puede venir como objeto o como string JSON.
- **Solo se aceptan llamadas a tools que el cliente ofreció** (filtra llamadas
  ajenas o inventadas).
- La respuesta de Meta puede venir en el texto o en un bloque de código
  (primitiva `GenAICodeUXPrimitive`); se leen las dos.

### 2.4 Límite honesto

Meta puede no obedecer y responder con texto: en ese caso la API devuelve una
respuesta normal (`finish_reason: "stop"`), no una tool call. No hay reintentos
automáticos de tool call (sí los hay de *turno vacío*, ver §5).

---

## 3. Adjuntos (recibir y enviar)

### 3.1 Recibir

Dos formas, ambas en `messages[].content`:

```jsonc
// a) multimodal OpenAI (content como array de partes)
{ "role": "user", "content": [
  { "type": "text", "text": "qué dice este PDF?" },
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } },
  { "type": "input_file", "file_url": "https://ejemplo.com/doc.pdf" }
]}

// b) content plano
{ "role": "user", "content": "mira esto" }
```

Tipos de parte aceptados: `text`, `input_text`, `image_url`, `input_image`,
`image`, `image_file`, `video_url`, `input_video`, `video`, `document_url`,
`input_file`, `document`, `file`.

Cada adjunto se sube a `rupload.meta.ai` y en el envelope solo viaja el
`media_id` (f2.3). Tope: `META_MAX_IMAGE_BYTES` (20 MB por defecto).

### 3.2 Subir un adjunto suelto (`POST /v1/attachments`)

```bash
curl -X POST http://127.0.0.1:8055/v1/attachments \
  -H 'content-type: application/json' \
  -d '{"path":"/home/test/imagen.png","filename":"imagen.png"}'
# -> {"media_id":"...","filename":"imagen.png","mime":"image/png","listo":true}
```

Acepta `data` (data URL), `path` (ruta local) o `url` (remota: se descarga
primero). El `media_id` se usa después como adjunto del mensaje.

### 3.3 Enviar (lo que devuelve Meta)

- **Imágenes generadas**: vienen como `GenAIImagePrimitive` con URL CDN firmada.
  La API las baja (la URL caduca) y responde con:
  - `meta_images: [{url, mime, bytes, path, local}]` → `local` es la ruta servible
  - y un markdown `![imagen](url)` en el texto, para clientes que solo leen texto.
- **Archivos del sandbox** (zip, scripts, documentos): `meta_files` y `meta_zip`
  (ver §4), servibles en `/v1/media/...`.

---

## 4. El sandbox de archivos de Meta (lo importante)

### 4.1 Qué se discovered

- Meta tiene un **sandbox de archivos**: cuando usa su herramienta de python, los
  archivos quedan en `/mnt/data/...` y la respuesta lo menciona
  (`/mnt/data/sistema-agendamiento.zip 21031 bytes`).
- **No hay URL pública de descarga**: el archivo vive dentro del sandbox de Meta.
- El **código que Meta ejecutó** sí viaja por el stream, pero en
  `frames[].code` (la primitiva de la herramienta), no como bloque de código del
  mensaje.
- Por eso "bajar" un archivo = **reproducir ese script aquí**: se ejecuta el
  mismo código con `/mnt/data/` redirigido a una carpeta local y el archivo
  aparece igual (verificado: 21.031 bytes en el sandbox de Meta y 21.031 bytes
  reproducidos localmente).

### 4.2 Implementación

`engine/artifacts.mjs`:

| Función | Qué hace |
|---|---|
| `detectarArchivos(respuesta)` | Extrae rutas `/mnt/data/...` y snapshots. |
| `codigoDeHerramienta(frames)` | Saca el código de la herramienta (`frames[].code`). |
| `materializar({frames, respuesta, dir})` | Reproduce el script y devuelve `{archivos, zip}`. |

**Seguridad**: el código lo escribió un modelo. **Nunca** se ejecuta en el host:
se ejecuta con `agent/sandbox.js` (bwrap + scope de systemd, sin red, con
memoria/CPU/PIDs limitados y timeout). Es el mismo límite que usa `/v1/agent`.

### 4.3 Salida

```json
{
  "meta_files": [
    { "nombre": "sistema-agendamiento.zip", "ruta": "sistema-agendamiento.zip",
      "bytes": 21031, "url": "/v1/media/<conv>/sistema-agendamiento.zip" }
  ],
  "meta_zip": { "nombre": "sistema-agendamiento.zip", "bytes": 21031, "url": "/v1/media/..." }
}
```

`GET /v1/media/<conv>/<archivo>` sirve el archivo (desde `engine/.media/`).

---

## 5. Turnos vacíos, "continua" y timers

Meta a veces cierra el turno con solo el estado "pensando" (sin texto ni
código): el contenido llega en el turno siguiente. La API lo resuelve sola:

- `MetaEngine.askConContenido()` reintenta con **`continua`** en el **mismo
  hilo** (es el workaround que usa el usuario en la web) hasta 2 veces.
- Sin esto la API respondía `200` con `content: ""` y el cliente creía que Meta
  no había respondido.

### 5.1 Temporizadores (meta tarda, pero no indefinidamente)

Meta responde en **3-6 s** normalmente. Los topes evitan que un turno mudo
deje al cliente colgado "pensando" para siempre:

| Tope | Por defecto | Variable |
|---|---|---|
| Espera del primer frame | 45 s | `META_IDLE_MS` |
| Turno completo (tope duro) | 75 s | `META_TURN_DEADLINE_MS` |
| Petición completa (turno + reintentos) | 120 s | `META_ASK_TIMEOUT_MS` |
| Prompt de sistema (se recorta) | 8000 chars | `META_MAX_SYSTEM_CHARS` |

Si se agota el presupuesto, la API responde **504** con un mensaje claro
(`meta no respondio a tiempo (Xs)`) en vez de dejar la conexión abierta.

En streaming (SSE) se manda un **latido cada 10 s** (`: latido 30s`) para que
el cliente no corte la conexión por inactividad mientras Meta piensa.

Todas las respuestas incluyen **`meta_elapsed_ms`** (milisegundos que tardó
Meta) para que el cliente pueda mostrar un timer.

### 5.2 El frame DGW tiene un tope de 64 KB

El header del frame DGW lleva el largo del cuerpo en un **u16**: 65535 bytes
como máximo. El envelope mete el protobuf en **base64** (×1.33), así que un
prompt de ~48 KB ya desborda (error de Node: `The value of "value" is out of
range`). OpenCode manda el prompt de sistema + los schemas de sus tools + el
historial en **cada** turno, así que esto es la norma, no la excepción.

Lo que hace la API:

1. **Contrato de tools compacto**: firma de argumentos (`path:string`) en vez
   del JSON Schema completo.
2. **Prompt de sistema recortado** a `META_MAX_SYSTEM_CHARS`.
3. **Si aun así no entra**, el prompt se **parte en trozos** y cada trozo
   viaja como un turno seguido en el **mismo hilo** de Meta (que conserva el
   contexto en su lado). Solo se usa la respuesta del último trozo.

### 5.3 Un canal = un turno a la vez (y el hilo se rehace solo)

- **Serializacion**: opencode manda la peticion del **titulo** en paralelo con
  el turno principal. Si los dos turnos se cruzan en el mismo socket, las
  respuestas se mezclan (los dos turnos quedan con el mismo `response_id` y no
  hay respuesta). Por eso el motor **encola los turnos de un canal**: el
  segundo espera al primero. Efecto medido: el turno completo paso de 76 s a
  21 s.
- **Turno vacio = hilo muerto**: medido el 2026-11-01, un turno que vuelve
  sin texto **y** sin bloque de codigo deja el hilo sin responder para
  siempre (todas las peticiones siguientes, aun con prompts chicos, se quedan
  sin respuesta). Por eso:
  1. el puntero de hilo (`reply_to`) **no avanza** con un turno vacio;
  2. el motor **rehace el chat** (conversation_id nuevo) y vuelve a mandar el
     prompt completo;
  3. si un turno se queda mudo hasta el tope, tambien se rehace el hilo y se
     reintenta una vez.
- Ojo: un turno con **tool call** tiene el texto vacio, pero **no** es un turno
  vacio (la llamada va en un bloque de codigo). `tieneCodigo()` lo distingue.

---

## 6. Identidad: cuenta vs invitado

| Situación | Comportamiento |
|---|---|
| `META_ENGINE_MODE=session` y hay sesión (`engine/.session.json`) | Se usa **tu cuenta**. |
| `META_ENGINE_MODE=session` y **no** hay sesión | Se intenta capturar el acceso desde el navegador (`engine/capture-session.mjs`: abre `meta.ai` en el Chrome de depuración y copia **solo** el acceso a Meta: token + cookies de `meta.ai`). Si eso falla, se **cae a invitado** y el motivo queda visible en `/health`. |
| La sesión caduca en caliente | Se recaptura; si no se puede, se cae a invitado. |
| `META_ENGINE_MODE=guest` | Siempre invitado (`createTempUser` + TOS). Sin imágenes ni zip: **el invitado no tiene herramienta de python**, pero sí entrega código en bloques. |

`GET /health` → `motor`:

```json
{ "motor": {
  "modo": "guest",
  "modo_configurado": "session",
  "motivo": "la sesion propia caduco y no se pudo recapturar",
  "caida_a_invitado": true,
  "tiene_sesion": false,
  "salas": 3
} }
```

Al cambiar de identidad, los chats de la cuenta **no** sirven para el invitado:
el motor crea un `conversation_id` nuevo para ese usuario/canal (las carpetas y
el registro de salas se mantienen).

---

## 7. Salas: identificar a qué usuario pertenece cada canal

Cada usuario/canal tiene su propio chat de Meta. El **título del chat** lleva un
**id corto de hasta 6 dígitos** + el texto real del primer mensaje:

```
[482913] Necesito un SISTEMA DE AGENDAMIENTO DE TAREAS completo...
```

El registro completo está en `GET /v1/rooms`:

```json
{ "object": "list", "data": [
  { "id": 482913, "usuario": "sdd", "canal": "dev", "clave": "sdd:dev", "creada": "2026-11-01T..." }
] }
```

Persistencia: `engine/.rooms.json` (0600, fuera de git).

---

## 8. Configurar OpenCode (V2)

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "model": "meta/meta-ai",
  "providers": {
    "meta": {
      "name": "Meta AI (meta-api)",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:8055/v1",
        "headerTimeout": 300000,
        "chunkTimeout": 900000
      },
      "headers": {
        "x-meta-conversation": "opencode-prueba"
      },
      "models": {
        "meta-ai": {
          "name": "Meta AI",
          "capabilities": {
            "tools": true,
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": { "context": 32768, "output": 8192 }
        }
      }
    }
  }
}
```

- `x-meta-conversation` fija el chat de Meta para esas peticiones (si no, el
  motor usa `payload.user` o el hash del primer mensaje).
- `capabilities.tools: true` es **obligatorio**: sin él OpenCode no envía las
  tools y Meta nunca puede pedir una.
- `headerTimeout` alto: un turno de Meta puede tardar 90 s (o más, si hay que
  reintentar con `continua`).

---

## 9. Tokens: calculo, registro y entrega

Meta **no expone contador de tokens**. La API los estima a partir del texto de
entrada y de salida (`engine/usage.mjs`):

- **Prompt**: texto de `messages[]` + los schemas de `tools`.
- **Completion**: texto de la respuesta + el contenido de los bloques de codigo.
- Heuristica: ~3,6 caracteres/token, promediada con palabras (~1,3 tokens por
  palabra). En texto chico (codigo, espanol) queda dentro de +-15% de un BPE
  real. **Es una estimacion y se presenta como tal.**
- Lo exacto son los **caracteres y bytes**, que se registran aparte.

**Registro**: `engine/.usage.json` (0600, fuera de git), una fila por sala:

```json
{ "sala": "1", "conversation_id": "a7d0...", "turnos": 3,
  "prompt_tokens": 120, "completion_tokens": 480, "total_tokens": 600,
  "chars_in": 512, "chars_out": 1904,
  "ultimo": { "at": "2026-11-01T16:34:08.840Z", "total_tokens": 118 } }
```

**Entrega**:
- `chat.completion` (sync): siempre en `usage`.
- SSE: en el chunk final (`usage`) y, si el cliente lo pide con
  `stream_options: {include_usage: true}`, ademas en un chunk dedicado con
  `choices: []` (como en OpenAI).
- Consulta acumulada: `GET /v1/usage` -> `{global, salas[]}`.

```bash
curl http://127.0.0.1:8055/v1/usage | jq '.global'
```

---

## 10. Verificado en vivo (2026-11-01)

| Prueba | Resultado |
|---|---|
| Chat simple (sync) | respuesta + `usage` + `meta_conversation_id` |
| Chat con `tools` | `tool_calls[{id,type,function{name,arguments}}]`, `finish_reason:"tool_calls"`, `content:null` |
| Chat con `tools` (SSE) | `delta.tool_calls` -> `finish_reason:"tool_calls"` -> `[DONE]` |
| Round-trip de tool | Meta pidio `read` -> el cliente devolvio `role:"tool"` -> Meta respondio *"El archivo `engine/prompts.mjs` tiene 41 lineas en total"* |
| Turno vacio | se reintenta con `continua` en el mismo hilo |
| Salas | `GET /v1/rooms` -> `{id:1, usuario:"demo", canal:"main"}`; titulo del chat `[1] ...` |
| Tokens | `usage` con estimacion + registro por sala |
| Request estilo OpenCode (system 20 KB + 20 tools, 92 KB) | `200` en 2,7 s, respuesta real, `meta_elapsed_ms` |
| Lo mismo en SSE | `role` -> `content` -> `finish_reason:"stop"` -> `usage` -> `[DONE]` en 3 s |
| Compactacion (transcripto de 650 KB) | partido en 17 turnos del mismo hilo -> **resumen correcto** en 65 s |
| Turno mudo | cortado por el tope (45-75 s) y la peticion entera por el presupuesto (120 s): nunca queda colgada |

---

## 11. Limites conocidos

- Meta no expone contador de tokens: `usage` va **estimado** (chars ÷ 3,6) y
  registrado por sala en `engine/.usage.json`.
- Sin function calling nativo: la calidad de la tool call depende de que Meta
  obedezca el contrato del prompt. Cuando Meta cierra el turno vacío (a
  veces lo hace), la API reintenta con `continua` y, si tampoco hay respuesta,
  devuelve `content: ""` con `finish_reason: "stop"` (no hay error: el turno
  sí terminó).
- El hilo de Meta es la memoria: si el cliente cambia de `x-meta-conversation`,
  Meta arranca un hilo nuevo. Sin ese header, cada sesión de OpenCode tiene el
  suyo (hash del primer mensaje del usuario).
- El invitado no tiene herramienta de python: no hay imágenes ni zip, solo código
  en bloques.
- Un prompt que no entra en un frame (64 KB) se parte en varios turnos: la
  respuesta tarda más (≈4 s por trozo) y Meta ve el contexto como "partes".
- `meta_elapsed_ms` es el tiempo real de Meta; con tools la respuesta completa
  llega de golpe (no hay streaming de texto mientras Meta decide la tool call).
