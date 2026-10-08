# Prefijo XXX -> ejecutor temporal (parche)

## Objetivo
Mientras el cerebro de Don Bot esta sin credito: cualquier mensaje de WhatsApp que
EMPIEZE con el prefijo `XXX` lo toma un ejecutor propio, ejecuta la instruccion y
responde al WSP con el prefijo `XXX`. Meta NO participa (ni la pregunta ni la
respuesta). Don Bot y su responder quedan intactos.

## Diseno
1. `relay/wsp.mjs`: detecta `XXX` al inicio -> encola en `relay/state/wsp-xxx.txt`
   y `continue` (NO va a Meta, NO va a Don Bot). El prefijo se quita del texto.
2. `relay/responder-xxx.mjs` (nuevo): consume `wsp-xxx.txt`, compone con
   `opencode run --auto --agent xxx --model <modelo> --format json`, y responde
   con prefijo `XXX ` via `relay/wsp.mjs --enviar`. Guard de canal fail-closed.
3. `.opencode/agents/xxx.md` (nuevo): ejecutor con shell+edit, mismos deny que
   donbot (push/ssh/scp/rsync/sudo/git destructivo/secretos/subagentes).
4. `relay/state/xxx.json` (config editable en caliente): `{modelo, agente}`.
5. Servicio systemd `responder-xxx.service`.

## Config
- `relay/state/xxx.json` -> `{"modelo": "opencode-go/longcat-2.5-preview-free", "agente": "xxx"}`
- El prefijo se cambia en `relay/state/xxx.json` -> `{"prefijo": "XXX"}`.

## Tasks
- [ ] T1: agente `.opencode/agents/xxx.md`.
- [ ] T2: `relay/wsp.mjs` (deteccion + encolado + skip Meta/Don Bot).
- [ ] T3: `relay/responder-xxx.mjs`.
- [ ] T4: servicio `responder-xxx.service`.
- [ ] T5: prueba en vivo (mandar "XXX ..." al WSP y ver la respuesta).

## Verificacion
- `node --check` en los archivos tocados.
- Prueba manual: `node relay/responder-xxx.mjs --prueba "hola"` (compone sin enviar).
