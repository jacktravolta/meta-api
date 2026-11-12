# Feature: Login de Meta en modal (botón "Iniciar sesión")

## Objetivo

Que el sistema **detecte que no hay sesión de Meta** (o que caducó) y ofrezca un
**botón "Iniciar sesión"** en el webchat que abre un **modal**, lleva al usuario a
Meta.ai para que inicie sesión, **clona/guarda esa sesión** y la usa a partir de
entonces.

## Por qué (diagnóstico medido)

- El motor GraphQL usa `session.load()` → `engine/.session.json` (0600). Si no hay
  archivo, intenta `#capturarSesion()` → `engine/capture-session.mjs <cdpPort>`.
- El motor se crea con `cdpPort: SESSION_CDP_PORT` (**9298**, `server.mjs:169`): el
  navegador "de sesión" es el que debe tener la cuenta iniciada.
- **Ese Chrome 9298 no lo lanza nadie**: el repo solo lanza el Chrome del broker
  (9233, headless). Por eso la captura falla y el motor cae a **invitado**
  (`caidaAInvitado: true`), en silencio para el usuario.
- `capture-session.mjs` abre meta.ai en el Chrome del puerto CDP, espera el WS del
  gateway, saca el token `Authorization` + las cookies y guarda `engine/.session.json`.
  Funciona: lo único que falta es **tener el navegador con la sesión iniciada**.
- El servidor tiene **escritorio real** (`DISPLAY=:0.0`, XFCE con GDM): una ventana
  de Chrome es visible para el usuario ✓.

## Alcance (autorizado)

- Botón "Iniciar sesión" en el webchat + modal con el flujo de login.
- API: estado de la sesión, abrir la ventana de Meta, capturar/guardar la sesión.
- El motor debe **usar** la sesión recién capturada (hoy cachea las credenciales).

## Contrato de la API

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| GET | `/v1/sesion` | — | `{ "haySesion": bool, "capturadoEn": ISO\|null, "cdpPuerto": 9298, "cdpActivo": bool, "display": ":0.0"\|null, "puedeAbrirVentana": bool, "modo": "session"\|"guest", "caidaAInvitado": bool, "motivo": str\|null }` |
| POST | `/v1/sesion/abrir` | — | `{ "ok": bool, "puerto": 9298, "display": str\|null, "mensaje": str }` |
| POST | `/v1/sesion/capturar` | — | `{ "ok": bool, "capturadoEn": ISO\|null, "señal": str, "mensaje": str }` |

- `haySesion` = existe `engine/.session.json` con token.
- `caidaAInvitado` = el motor está hablando como invitado porque la sesión falló
  (viene de `authInfo()` del motor: `auth.caidaAInvitado`).
- Los errores: `{ "error": { "message": "..." } }` (mismo formato que el resto).
- **Clasificación de auth**: estos tres endpoints son de gestión (abren una ventana
  y escriben credenciales): se permiten **con clave válida** o **desde loopback**,
  igual que `/v1/ajustes` y `/v1/keys*`. No se exponen al exterior sin clave.

## Diseño (decisiones tomadas)

1. **Navegador de login = el Chrome de sesión (9298)**, con perfil **propio**:
   `META_SESSION_PROFILE` (por defecto `/home/test/.config/google-chrome-meta-login`).
   - Perfil aparte del del broker (`google-chrome-beta-debug`): `killStrays()` mata
     por `--user-data-dir=<PROFILE>` y si compartieran perfil el login se moriría.
   - Visible (con `DISPLAY`), perfil persistente: el login se conserva para siempre.
2. **La API lo lanza bajo demanda** (`POST /v1/sesion/abrir`): si el puerto 9298 no
   responde, lanza Chrome con `--remote-debugging-port=9298` + perfil propio y
   espera a que el CDP responda; luego abre `https://www.meta.ai/` con
   `PUT /json/new?https://www.meta.ai/`.
3. **Captura**: `POST /v1/sesion/capturar` ejecuta `engine/capture-session.mjs 9298`
   (el script que ya existe) y **verifica** que `engine/.session.json` quedó con
   token. Nunca se loguea el token ni el valor de las cookies: solo nombres.
4. **El motor debe usar la sesión nueva**: hoy cachea `this.creds`, así que tras
   capturar hay que **invalidar el motor cacheado** (`motores.delete(modo)` en
   `server.mjs`) para que el siguiente turno cree un motor nuevo que lea el
   archivo. Las salas están persistidas (`engine/.rooms.json`), no se pierden.
5. **La captura no distingue invitado de cuenta**: `capture-session.mjs` guarda el
   token del WS, y un invitado también tiene WS. Por eso el estado expone
   `caidaAInvitado` (la señal honesta del motor) y la UI no promete más de lo que
   se sabe: el botón sigue visible mientras no haya sesión válida.
6. **Proxy**: los tres endpoints se proxian en `webchat/server.py` con prefijo
   `/api`. `POST /api/sesion/capturar` necesita **timeout amplio** (la captura
   espera hasta 20 s al WS y el login puede tardar): 180 s, no los 20 s del proxy
   genérico.

## Tareas

- [x] **T1 — API: módulo de login.** `engine/login-meta.mjs` completo:
      `estadoLogin()`, `abrirVentanaLogin()`, `capturarSesionAhora()`; errores
      honestos, nunca loguea token ni cookies.
- [x] **T2 — API: endpoints.** `GET /v1/sesion` (`server.mjs:2288`),
      `POST /v1/sesion/abrir` (2304), `POST /v1/sesion/capturar` (2313), con la
      clasificación de auth de gestión (:2220-2221) y reset del motor cacheado
      (:2342).
- [x] **T3 — Webchat: estado honesto.** `webchat/server.py`: `logueado` real
      (`sesion_en_uso`, :178-185), `caidaAInvitado`/`motivo` expuestos, y los
      tres proxies `/api/sesion*` (:286-315, capturar con 180 s).
- [x] **T4 — Webchat: botón + modal.** `webchat/index.html`: `#btn-login` en el
      header (solo cuando hace falta), `#modal-sesion` de 3 pasos (Abrir Meta →
      iniciar sesión → Guardar sesión), estados y errores REALES de la API.
- [x] **T5 — Verificación.** `engine/login-meta.test.mjs` +
      `engine/prompt-ajustes.test.mjs`: suite completa **95/95 pass**
      (`node --test engine/*.test.mjs`, verificado 2026-11-03). El E2E manual
      del login (teclear correo/contraseña en la ventana de Chrome) queda para
      el dueño: la prueba automática cubre estado, apertura y captura.
- [x] **T6 — Reemplazar la sesión sin borrarla a mano.** (pedido del dueño,
      2026-11-02; hecho 2026-11-03) La captura **sobrescribe** `engine/.session.json`
      (no exige borrarlo antes) y el motor cacheado se invalida igual, así que el
      siguiente turno usa la sesión nueva. La opción de login está **siempre
      alcanzable**: `#btn-sesion` en el header (`webchat/index.html:237`) y la
      tarjeta "Sesión de Meta" del Panel (`:309-319`) con `#abrir-modal-sesion`;
      ambos abren el modal (`:1381-1382`) y el aviso de reemplazo está en la
      tarjeta. El botón automático `#btn-login` conserva su visibilidad por
      necesidad (no cambió).
- [x] **T7 — Webchat integrado en el puerto de la API.** (pedido del dueño,
      2026-11-02; cerrado 2026-11-11) **Un solo servicio y un solo puerto: 8055.**
      La API (Node) sirve el front y sus rutas `/api/*`.
      - `GET /` → `webchat/index.html` (con el content-type correcto).
      - `GET /api/estado` → lo mismo que hoy devuelve el proxy (mismos campos +
        `caidaAInvitado`/`motivo`/`tiene_sesion`).
      - `POST /api/chat` → SSE reenviado tal cual desde `/v1/chat/completions`.
      - `POST /api/clear` → `/v1/chat/clear`.
      - `GET/PUT /api/ajustes` → `/v1/ajustes`.
      - `GET/POST /api/keys`, `DELETE /api/keys/:id` → `/v1/keys*`.
      - `GET/POST /api/sesion*` → `/v1/sesion*`.
      - El front ya habla con URLs relativas (`/api/...`, `/v1/media/...`): con la
        integración **no cambia ni una línea del front** y desaparecen el proxy y
        el salto de puerto.
      - Auth: las rutas `/api/*` son de clase "panel" (clave válida **o**
        loopback), igual que `/v1/ajustes` y `/v1/keys*`. Con `auth=abierta`
        (por defecto) todo funciona; con `auth=api-key` el panel sigue operable
        desde loopback/túnel.
      - **Desviacion respecto del plan original**: `webchat/server.py` no se
        conserva como legado. Sus rutas quedaron implementadas de forma nativa en
        `server.mjs` (traduccion `/api/*` → `/v1/*` reutilizando los mismos
        manejadores, sin duplicar logica) y el servicio `meta-webchat.service`
        (8060) se elimino por completo del host. Un proxy muerto de 440 lineas
        es basura, no legado.
      - Evidencia: `engine/un-puerto.test.mjs` (7 tests, incluido uno real que
        levanta el broker y prueba `/`, `/api/estado` y la traduccion de
        `/api/chat`); suite completa `node --test engine/*.test.mjs` = 117 pass,
        0 fail; `curl http://127.0.0.1:8055/` → 200 `text/html`;
        `/api/estado` → 200 con la identidad real ("Tu cuenta"); nada escucha en
        8060.

- [x] **T8 — Editor del system prompt desde el webchat.** (pedido del dueño,
      2026-11-03) `engine/prompt-ajustes.mjs` (nuevo: `getPrompt()`/`savePrompt()`,
      tope `PROMPT_MAX_CHARS` = 20000, `""` = prompt base, escritura atómica 0600
      con cache por mtime, archivo `engine/.prompt-ajustes.json`);
      `GET/PUT /v1/prompt` en `server.mjs:2272-2283` (clase de auth de gestión:
      clave válida o loopback, error 400 con el mensaje real); inyección en el
      turno como bloque `[INSTRUCCIONES DEL PROPIETARIO]` ANTES del historial
      (`server.mjs:2709-2725`), leído del disco en cada turno → aplica desde el
      próximo mensaje sin reiniciar ni invalidar el motor (el motor cachea
      credenciales, no el prompt); proxy `/api/prompt` GET/PUT
      (`webchat/server.py:318-332`, timeout normal); panel "Prompt del agente" en
      `webchat/index.html:323-340` (textarea + contador, badge personalizado/base,
      Guardar, Restablecer con confirmación, toasts y errores reales de la API).

## Criterios de aceptación

- Con `engine/.session.json` ausente o con el motor en `caidaAInvitado`, el webchat
  muestra el botón "Iniciar sesión".
- El modal abre una ventana de Chrome en el escritorio con meta.ai.
- Tras iniciar sesión y pulsar "Guardar sesión", `engine/.session.json` queda
  actualizado (0600) y el siguiente turno usa la cuenta (no invitado).
- El botón desaparece cuando la sesión está bien.
- Ningún token ni valor de cookie aparece en los logs ni en las respuestas.

## Verificación

- `node --test engine/*.test.mjs` (los 75 existentes + los nuevos).
- E2E por HTTP contra 8055 y 8060; el login manual (ventana de Chrome) lo hace el
  usuario: la prueba automatizada comprueba estado, apertura y captura, no el
  tecleo de la contraseña.

## Restricciones

- **No tocar** `engine/broker-engine.mjs`, `engine/gateway.mjs`, `engine/prompt.mjs`,
  `agent/sandbox.js` ni los `.json` de estado del broker (`engine/.rooms.json`,
  `engine/.conversations.json`).
- **No commitear** (decisión del dueño en esta sesión).
- Node correcto: `/home/test/.nvm/versions/node/v22.23.3/bin/node` (el del sistema
  es v18).
- La API necesita `DISPLAY` para poder abrir la ventana: se arranca con
  `DISPLAY=:0.0`.
- UI y comentarios en **español**; identificadores en inglés.

## Modo TDD

Sin evidencia de `strict_tdd` en la memoria del proyecto (búsqueda vacía) y sin
`package.json`: modo estándar (`node --test`), sin exigir RED previo.

## Progreso

- 2026-11-02 — documento creado tras mapear `engine/session.mjs`,
  `engine/capture-session.mjs`, `engine/broker-engine.mjs` (solo lectura) y
  `server.mjs`. Diagnóstico: falta lanzar el Chrome de sesión (9298) y conectar el
  botón con la captura.
- 2026-11-03 — verificación completa contra el código: T1, T2, T3, T4, T6 y T8
  implementados en el worktree (sin commit, por decisión del dueño). Suite
  `node --test engine/*.test.mjs` con `/home/test/.nvm/versions/node/v22.23.3/bin/node`:
  **95 tests, 95 pass, 0 fail**. `node --check server.mjs`: OK.
  Pendiente: T7 (webchat integrado en el puerto 8055, proxy 8060 como legado) y el
  E2E manual del login (lo hace el dueño en la ventana de Chrome).
