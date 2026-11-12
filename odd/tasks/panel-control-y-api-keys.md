# Feature: Webchat como panel de control + API keys

## Objetivo

Convertir el webchat en un **panel de control** de la API y añadir autenticación por
**API key** para poder usar la API desde otros entornos de forma segura.

## Problema

1. La entrega de archivos tiene hoy una sola vía: la API baja el archivo de Meta a
   `engine/.media/...` y lo sirve en `/v1/media/...`. Eso duplica el archivo y obliga a
   la API a ser el almacén. Con `META_FILE_STORAGE=url` (nuevo) la API traspasa la URL
   de descarga de Meta al cliente y no guarda copia.
2. No hay forma de cambiar ese comportamiento en caliente: la API se lee del entorno al
   arrancar.
3. No hay credenciales para usar la API desde fuera: cualquier cliente que llegue al
   puerto puede gastar turnos de Meta.

## Por qué

- El flujo tiene que ser claro: **Meta genera → Meta da la URL → el cliente descarga**.
  Nuestra copia es una opción, no la regla.
- El panel es el lugar natural para governs ese flujo y las credenciales.
- Una API key con caducidad opcional permite exponer la API sin dejarla abierta.

## Alcance (autorizado)

- Webchat con una sección de **panel** (además del chat).
- Ajustes de la API en caliente, persistidos:
  - `fileStorage`: `url` (por defecto) | `local`.
  - `auth`: `abierta` (por defecto) | `api-key`.
- API keys: crear (con caducidad opcional), listar (sin el secreto), revocar.
- Autenticación por `Authorization: Bearer <clave>` o `X-API-Key: <clave>`.

## Restricciones

- No tocar `engine/broker-engine.mjs`, `engine/gateway.mjs`, `engine/prompt.mjs`,
  `agent/sandbox.js` ni los `.json` de estado del broker.
- No instalar paquetes del sistema. Sin Docker.
- **No commitear** (decisión del dueño en esta sesión).
- Node correcto: `/home/test/.nvm/versions/node/v22.23.3/bin/node` (el `node` del sistema es 18).
- Idioma: la UI y los comentarios van en **español**; los identificadores en inglés.

## Contrato de la API (lo implementan los dos lados)

Base: `http://127.0.0.1:8055`

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| GET | `/v1/ajustes` | — | `{ "fileStorage": "url", "auth": "abierta", "actualizado": "ISO" }` |
| PUT | `/v1/ajustes` | `{ "fileStorage": "url\|local", "auth": "abierta\|api-key" }` | el mismo objeto |
| GET | `/v1/keys` | — | `{ "claves": [{ "id", "nombre", "prefijo", "creado", "expira", "revocado", "ultimoUso" }] }` |
| POST | `/v1/keys` | `{ "nombre": "texto", "dias": 30\|null }` | `{ "id", "clave": "mk_...", "nombre", "expira" }` (el secreto se ve UNA vez) |
| DELETE | `/v1/keys/:id` | — | `{ "ok": true }` |

- `dias: null` → la clave **no caduca**.
- Valores inválidos → `400` con `{ "error": { "message": "..." } }`.
- `GET /health` nunca pide clave.

## Autenticación

- La clave viaja en `Authorization: Bearer <clave>` o `X-API-Key: <clave>`.
- Se guarda **solo el hash** (sha256) en `engine/.api-keys.json` (modo 600). El secreto
  se devuelve al crearla y no se vuelve a mostrar.
- Cuando `auth = "api-key"`:
  - `/v1/chat/*`, `/v1/media/*` y el resto de la API exigen una clave válida → `401` si no.
  - `/v1/ajustes` y `/v1/keys*` se permiten **con clave válida** o **desde loopback**
    (el panel es local).
  - `/health` queda abierto.
- El webchat (proxy local) usa una **clave interna de servicio** que la API genera sola
  en `engine/.webchat-key` (modo 600). El proxy la lee y la manda. Así el panel sigue
  funcionando con `auth = "api-key"`.

## Persistencia

- `engine/.ajustes.json` → `{ "fileStorage", "auth", "actualizado" }` (modo 600).
- `engine/.api-keys.json` → `{ "claves": [{ "id", "nombre", "hash", "prefijo", "creado", "expira", "revocado", "ultimoUso" }] }` (modo 600).
- Al arrancar, la API lee ambos; si no existen, usa los valores por defecto
  (`fileStorage=url`, `auth=abierta`).

## Tareas

- [x] **T1 — API: ajustes en caliente.** `engine/ajustes.mjs` (nuevo) + `GET/PUT
      /v1/ajustes`. `PUT` valida y persiste en `engine/.ajustes.json` (600); el cambio
      aplica a los turnos siguientes.
- [x] **T2 — API: API keys.** `engine/apikeys.mjs` (nuevo) + `GET/POST /v1/keys`,
      `DELETE /v1/keys/:id`. Solo se guarda el hash sha256; `prefijo` visible; el secreto
      se devuelve una sola vez.
- [x] **T3 — API: autenticación.** `Authorization: Bearer` y `X-API-Key`; 401 con mensaje
      claro; `/health` abierto; `/v1/ajustes` y `/v1/keys*` permitidas desde loopback;
      clave de servicio del webchat en `engine/.webchat-key` (600).
- [x] **T4 — API: el modo de archivos usa el ajuste.** `materializar` acepta
      `modoAlmacen` y las dos llamadas desde `server.mjs` pasan el ajuste vigente.
- [x] **T5 — Panel: sección de ajustes.** Selector de modo de archivos y de
      autenticación, con guardado y lectura del estado real.
- [x] **T6 — Panel: sección de API keys.** Crear (nombre + caducidad), listar, revocar;
      el secreto se muestra una vez, con aviso de copiarlo.
- [x] **T7 — Proxy: la clave interna.** `webchat/server.py` lee `engine/.webchat-key` y
      manda `X-API-Key` en todas las llamadas; proxya los endpoints nuevos.
- [x] **T8 — Verificación.** 75 tests de node en verde; E2E del panel (crear clave →
      usarla → revocar → 401) y E2E de archivos en modo `url` (con enlace de Meta: URL
      directa y **sin copia** en `engine/.media/`).

## Evidencia observada (2026-11-02)

| Prueba | Resultado |
|---|---|
| `node --test engine/*.test.mjs` | 75 pass / 0 fail |
| `GET /api/ajustes` (por el proxy) | `{"fileStorage":"url","auth":"abierta",...}` |
| `PUT /api/ajustes {"fileStorage":"x"}` | 400 con mensaje real de la API |
| `POST /api/keys` → `GET /api/keys` | el secreto sale una vez; el listado no lo trae |
| `DELETE /api/keys/<id>` | revoca; la clave da 401 después |
| `auth=api-key` + llamada sin clave | 401; con `X-API-Key` → 200 |
| PDF con enlace de Meta (modo `url`) | se entrega `https://…metaaiusercontent.com/…&download=1` y **no queda copia** en `engine/.media/` (verificado con un dump real y con caso sintético) |
| PDF sin enlace (Meta da el código) | el espejo lo genera: 3 022 B, `application/pdf` |
| PPT (Meta da el código) | `web-final-7.pptx` 35 923 B, MIME de presentación correcto |

## Notas de diseño

- **El espejo es fallback, no copia**: si Meta entrega el archivo con enlace, en modo
  `url` no se ejecuta nada (cero copias). Si Meta solo entrega el código, el archivo se
  genera aquí y se sirve en `/v1/media` — no hay otra vía, porque no existe URL de Meta.
- Meta alterna entre "te doy el enlace" y "te doy el código": ambas rutas están
  soportadas y verificadas.
- La clave de servicio del webchat es una credencial **de servicio** (en claro en
  `engine/.webchat-key`, 600), distinta de las claves de usuario (solo hash).

## Criterios de aceptación

- El panel muestra el modo vigente y permite cambiarlo; tras un `PUT`, un turno nuevo
  usa el modo nuevo.
- Crear una clave devuelve un secreto usable; con `auth=api-key`, una llamada sin clave
  recibe `401` y con clave válida responde `200`.
- Una clave con caducidad deja de servir al expirar; sin caducidad sirve siempre.
- Revocar una clave la invalida de inmediato.
- En modo `url`, un archivo de Meta llega al cliente con la URL de Meta y **no** queda
  copia en `engine/.media/`.
- El webchat sigue funcionando con `auth=api-key`.

## Verificación

- `node --test engine/*.test.mjs` (tests existentes + los nuevos).
- E2E manual por HTTP contra `127.0.0.1:8055` y `127.0.0.1:8060`.

## Modo TDD

No hay evidencia de `strict_tdd` activo en la memoria del proyecto (búsqueda vacía) y no
hay `package.json`: se trabaja en modo estándar (tests de `node --test`), sin exigir RED
previo.

## Progreso

- 2026-11-02 — documento creado; `META_FILE_STORAGE=url|local` ya implementado en
  `engine/artifacts.mjs` (pendiente: que lo gobierne el ajuste del panel, T4).
- 2026-11-02 — T1-T8 completadas y verificadas. API (ajustes + claves + auth) y panel
  (UI + proxy) implementados por dos agentes; verificación del orquestador: 75 tests en
  verde, E2E del panel por HTTP, E2E de archivos por el webchat (PDF con URL directa de
  Meta y sin copia; PPT generado por el espejo con MIME correcto).
- 2026-11-02 — sin commits (decisión del dueño en esta sesión).

## Archivos tocados

- `server.mjs` — reglas de entrega en el prompt, timeouts, `REGLAS_ARCHIVOS`, endpoints
  de ajustes y claves, gate de autenticación, `materializar` con el modo vigente.
- `engine/artifacts.mjs` — modo `url|local`, materialización de archivos con contenido
  en línea, código de la respuesta (bloque python), detección de scripts cortos,
  anuncios sin bytes, espejo como fallback.
- `engine/ajustes.mjs`, `engine/apikeys.mjs` (nuevos) + sus tests.
- `webchat/index.html` — vista "Panel" (ajustes + API keys) junto al chat.
- `webchat/server.py` — proxy de los endpoints nuevos + `X-API-Key` de servicio.
- `.gitignore` — ignora `engine/.ajustes.json`, `engine/.api-keys.json`, `engine/.webchat-key`.
