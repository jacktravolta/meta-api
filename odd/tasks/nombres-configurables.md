# Nombres configurables (agente y cerebro)

## Objetivo
Que los nombres con los que se invoca a cada interlocutor sean DATOS, no codigo.
Hoy "Don Bot" esta hardcodeado en la deteccion, en el filtro de respuestas
propias y en las etiquetas de los mensajes; mañana puede llamarse "BOT". Lo
mismo con "Meta".

## Fuente unica
`relay/state/nombres.json` (opcional; si no esta, se usan los defaults):

```json
{
  "agente": "Don Bot",
  "cerebro": "Meta",
  "aliasAgente": ["don bot", "dón bot", "don bosco", "son bot", "dom bot", "dum bot", "dun bot"],
  "aliasCerebro": ["meta"]
}
```

Precedencia: `nombres.json` > variable de entorno > default.
Python (`relay/pendientes.py`) lee el MISMO JSON: las dos puntas no se pueden
desincronizar.

## Regla de matching
Cada alias se convierte en un patron propio con bordes Unicode
(`(?<![\p{L}\p{N}_])` ... `(?![\p{L}\p{N}])`), porque el `\b` de JS es ASCII puro
y con el "bot" invocaba dentro de "botó" y "meta" dentro de "metálico".
Los espacios entre palabras del alias son `[\s-]*`, asi "don bot" cubre
"donbot", "don bot", "don-bot" y "don  bot".

## Alcance
- [ ] T1 — `relay/nombres.mjs`: fuente unica + constructor de regex + etiquetas.
- [ ] T2 — `es-donbot.mjs` y `es-meta.mjs` derivan de ahi.
- [ ] T3 — `wsp.mjs`: filtro de respuestas propias y etiquetas de los mensajes.
- [ ] T4 — `pendientes.py` lee el mismo JSON.
- [ ] T5 — pruebas de paridad con los casos documentados de es-donbot.

## Fuera de alcance (se reporta, no se toca ahora)
`responder-donbot.mjs`, `vigia-v7.mjs`, `bridge/espejo-meta-wsp.mjs`,
`bridge/vigia.mjs`, `bridge/ultimas3.mjs`, `bridge/leer-todo.mjs`.
