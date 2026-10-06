# Bridge — canal de voz Don Bot

Puente bidireccional entre un chat de Meta AI (transcripción de voz) y el agente
de consola. **Ubicación persistente** (antes vivía en `/tmp` y se borró con un
reinicio).

## Protocolo

| Decís… | Responde | Firma |
|---|---|---|
| **"Don Bot"** (donbot, Don Bot, DON BOT, [don bot]) | **El agente** | `[DON BOT]` |
| **"meta"** | Meta / Doña Meta | `[META]` / `[DOÑA META]` |
| Nada | Meta solo transcribe | — |

- **Canal válido** = el chat de transcripción **más reciente** (se descubre solo).
- **Bootstrap**: al entrar a un canal nuevo, el vigía publica `reglas.txt` una vez.

## Uso

```bash
cd /home/test/test/meta-api/bridge
NODE=/home/test/.nvm/versions/node/v22.23.3/bin/node

# 1) El broker debe estar arriba
systemctl --user start meta-api.service
curl -s http://127.0.0.1:8055/warmup

# 2) Descubrir el canal (escribe canal.json)
$NODE canal.mjs

# 3) Vigía: detecta dictados nuevos y sale con el texto (una notificación por dictado)
$NODE vigia.mjs

# 4) Publicar una respuesta firmada [DON BOT]
bash progreso.sh "texto de la respuesta"

# 5) Verificar autenticidad de las firmas [DON BOT] del hilo
$NODE leer-todo.mjs
```

## Piezas

| Archivo | Rol |
|---|---|
| `canal.mjs` | Descubre el chat de transcripción más reciente → `canal.json` |
| `vigia.mjs` | Detecta dictados; bootstrap; anti-duplicados; detector de suplantación |
| `enviar-hilo.mjs` | Publica texto firmado `[DON BOT]` (composer + send, con reintentos) |
| `es-donbot.mjs` | Detección robusta de la invocación (mayús/minús, junto/separado) |
| `progreso.sh` | Publica progreso + registra el envío (anti-suplantación) |
| `leer-todo.mjs` | Verifica cuántas firmas `[DON BOT]` son reales y cuántas no |
| `reglas.txt` | Reglas que se publican en el bootstrap |
| `ignorar-meta.flag` | Si existe: el vigía ignora las filas de Meta ("Meta callada") |

## Estado y datos

- `canal.json` — canal actual + `bootstrapped`
- `don-bot-enviados.txt` — registro real de envíos del agente (base del detector)
- `dictado-log.txt` — dictados detectados (con hora)
- `vistos.json` — textos ya procesados (anti-repetición)
- `suplantacion.log` — firmas `[DON BOT]` no emitidas por el agente

## Limitación conocida (importante)

El agente **publica escribiendo en el composer del usuario**, así que Meta ve
**un solo autor** y no puede distinguir al agente del usuario. Para "silos
reales" haría falta que el agente publique desde **su propia cuenta/canal**
(ver la conversación con Meta en el historial).
