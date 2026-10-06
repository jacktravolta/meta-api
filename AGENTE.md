# Agente de tools — qué es, cómo funciona y cómo usarlo

Guía para futuros desarrollos sobre **meta-api**: el broker que expone Meta AI
detrás de una API compatible con OpenAI y el **agente** que le da manos
(ejecuta comandos en un sandbox y trabaja en loop hasta terminar una tarea).

> Ejemplo real de punta a punta: la landing `panaderia-la-espiga` del repo
> `~/Proyectos/demo-landin` fue **generada, corregida y verificada por el
> agente** en corridas multi-paso con capturas visuales.

## Arquitectura

```
POST /v1/agent {task, ...}          ← le das una tarea en lenguaje natural
        │
        ▼
loop.js (agent/)                     Meta "piensa" y emite comandos shell
  ask() ──► Meta AI (Chrome/CDP)     └─ protocolo: bloques ```sh (el protocolo ES el schema)
  parse() ─► tools.js                └─ fences sin tag también valen
  exec() ──► sandbox.js              └─ docker run efímero: sin red, root read-only,
  feedback ─► siguiente turno           workspace montado, timeout doble freno
        │
        ▼
{content, agent:{ok, steps, transcript}}   ← resultado final + transcript completo
```

- `agent/tools.js` — protocolo y parser (tags ```sh, last-block-wins, JSON legacy).
- `agent/sandbox.js` — ejecutor Docker: clasificador deny-by-default en read-only,
  whitelist de inspección, `allowWrite` con confirmación, selfCheck de seguridad.
- `agent/loop.js` — loop ask→parse→exec→feedback con budget de pasos/tiempo.
- `server.mjs` — broker, ruta `/v1/agent`, pool/cola de jobs, multimodal.

## Uso

```bash
curl -X POST http://127.0.0.1:8055/v1/agent -H 'content-type: application/json' -d '{
  "task": "Creá una app X en el directorio actual y probala",
  "workdir": "/home/test/test/meta-apps/mi-app",
  "allowWrite": true, "allowWriteAck": true,
  "maxSteps": 14, "budgetMs": 1800000, "sandboxTimeoutMs": 120000
}'
# → 202 {job_id} → GET /v1/jobs/<id> → {content, agent:{ok, steps, transcript}}
```

Campos: `task` (obligatorio) · `workdir` (realpath validado contra
`META_SANDBOX_WORKDIR_ROOTS`) · `allowWrite` + `allowWriteAck` (escritura) ·
`allowNetwork` (bridge) · `maxSteps` 1..32 · `budgetMs` (default 15 min) ·
`sandboxTimeoutMs` 5 s..10 min · `images[]` (dataURLs, hasta 4, van al primer turno).

## Flujo recomendado para trabajos visuales (webs, UI)

1. **Capturas** del estado actual y adjuntarlas al task (`images`). Capturar con:
   `google-chrome --headless=new --screenshot=out.png --window-size=1280,900 URL`.
   Para estados no capturables (menú móvil abierto) forzarlos por CDP
   (`Emulation.setDeviceMetricsOverride` + `Runtime.evaluate` + `Page.captureScreenshot`).
2. Pedirle que **escriba el archivo completo en UN comando**:
   `echo '<BASE64>' | base64 -d > archivo`. (Reescribir por partes corrompe.)
3. Iterar: captura → feedback → corrección → captura. Es lento pero converge.
4. **Post-proceso obligatorio** del output (la IA no ve el resultado):
   balance de tags, URLs de imágenes (deben dar 200), acentos, y render real.

## Límites y trampas (aprendidas en producción)

- **Cap por comando: 50000 chars** (env `META_TOOL_MAX_COMMAND`). Un HTML de
  ~15 KB son ~20 KB de base64: si no entra en un comando, el modelo troza y
  **corrompe** el archivo (mojibake). Subir el cap o pedir archivos más chicos.
- **Contenedor efímero por comando**: nada persiste en `/tmp`; solo el workspace
  montado persiste. Decirle eso en el task.
- **Root read-only**: `apt-get install` en runtime es imposible aunque haya red;
  las herramientas se hornean en `agent/Dockerfile.sandbox` (imagen `meta-sandbox`).
- **La IA reescribe de memoria**: en cada rewrite completo re-introduce bugs ya
  corregidos (divs sin cerrar, `$` corruptos, acentos perdidos). Tras cada
  rewrite: validar con script y limpiar determinísticamente.
- **Respuestas multi-mensaje**: Meta contesta en varios mensajes; el semáforo de
  fin es la **barra de acciones** (`button[aria-label="Copiar respuesta"]`) con
  ventana de gracia. Nunca finalizar por inactividad mientras genera.
- **Hilos agotados**: un mismo hilo de Meta se degrada tras decenas de turnos
  (envíos fallidos, "hilo degenerado"). Renovar: `printf '{}' > state.json` +
  `systemctl --user restart meta-api`.
- **Composer atascado**: si un envío falla, el borrador queda en el composer
  (persistido en localStorage). Limpiar: `localStorage.clear()` + reload por CDP.
- **`$font-family` y similares**: ediciones con shell pueden dejar `$` literales
  en CSS; validar con `grep '\$[a-zA-Z]'`.

## Verificación

- Tests: `node --test 'agent/*.test.js'` (parser, classifier, loop mockeado, selfCheck).
- `node --check server.mjs` tras cada edición.
- Smoke real: `POST /v1/agent` con una tarea de 1 comando y revisar
  `agent:{ok, steps, transcript}` + el journal (`agent {"type":"tool",...}`).
- Para UI: medir el DOM renderizado por CDP (no confiar en el archivo): el
  render puede diferir por cache — comparar `md5sum` archivo == lo servido.

## Servicio

- Unit: `systemctl --user restart|status meta-api` (Node 22 de nvm; el node 18
  del sistema no sirve). Drop-ins en `systemd/meta-api.service.d/`.
- Modo visible para supervisar: drop-in `visible.conf` con `META_VISIBLE=1`.
- Logs: `journalctl --user -u meta-api -f`.

## Ejemplo de uso completo

Ver `~/Proyectos/demo-landin/propuestas/panaderia-la-espiga/`: landing con
formulario real (`contact.php` + `contacts.log`), menú mobile, grilla de
productos y capturas iteradas — todo producido por este agente.
