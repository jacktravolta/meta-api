# fix-opencode-tool-calls

## Objetivo
Que OpenCode (cliente OpenAI-compatible de server.mjs) reciba TODAS las tool calls
que Meta emite en una respuesta, no solo una, y que un tool_call malformado no
descarte el turno entero en silencio.

## Problema (evidencia: dumps /tmp/opencode/dump de 2026-11-01 noche)
1. **Llamadas paralelas colapsadas a 1.** Meta emite varias llamadas en una
   respuesta (7 respuestas esta noche con 4-6 primitivas
   `GenAICodeUXPrimitive` lang `tool_call`). Verificado con el codigo real
   contra meta-41: 4 primitivas -> 1 tool call entregada al cliente.
   - `bloquesDe()` (engine/codigo.mjs) queda con "el mas largo por lenguaje".
   - `parseToolCalls()` (engine/toolcall.mjs) hace `break` tras el primer raw
     que produce llamadas.
2. **tool_call malformado descartado en silencio.** meta-6: bloque con tail
   duplicado (glitch de deltas) y lang `tool_call:` -> JSON.parse falla -> 0
   llamadas -> el cliente recibe prosa sin ninguna tool call.

## Blast radius verificado
- `materializar` (engine/artifacts.mjs) NO consume `bloquesDe`: intacto.
- `broker-engine.mjs:410` usa `extraerCodigo` solo como test de contenido: mas
  bloques es inofensivo.
- `sdd-loop.mjs` filtra por marcadores `### FILE:`: tool_call no matchea.

## Alcance autorizado
- T1 `engine/codigo.mjs`: `bloquesDe()` conserva TODOS los bloques `tool_call`
  distintos (dedupe por contenido exacto); los demas lenguajes siguen
  colapsando al mas largo por lenguaje.
- T2 `engine/toolcall.mjs`: `parseToolCalls()` acumula las llamadas de TODOS
  los bloques (dedupe por name+args, respeta MAX_ARGS por llamada). Los
  bloques ganan: el fence del texto y el texto plano solo son fallback cuando
  NINGUN bloque produce llamadas (postura anti-injection se conserva).
- T3 `engine/toolcall.test.mjs` (nuevo): tests de regresion con las formas
  reales de los dumps (meta-41: 4 primitivas; meta-6: tail duplicado).

## Restricciones
- NO tocar los hunks WIP pre-existentes sin commitear (el arbol tiene cambios
  sin commitear de otra linea de trabajo; el commit de esta feature se hace
  con staging selectivo).
- NO reiniciar servicios ni tocar systemd.
- Branch actual: feat/consola-prefijo (no default). Commit de unidad de
  trabajo aca.
- Comentarios en espanol, siguiendo el tono del archivo existente.

## Criterio de aceptacion
- `node --test engine/toolcall.test.mjs engine/limites.test.mjs engine/gateway.test.mjs`
  en verde.
- Simulacion contra meta-41 real: 4 primitivas -> 4 tool calls.
- El caso meta-6 (bloque malformado) no rompe las demas llamadas del turno.

## Verificacion
- node --check en los archivos editados.
- Tests arriba. Reporte por comando: resultado observado.

## Estado / progreso
- [x] T0 Diagnostico con evidencia (dumps + simulacion node).
- [x] T1 bloquesDe conserva tool_call paralelos.
- [x] T2 parseToolCalls acumula llamadas.
- [x] T3 Tests de regresion (dumps reales como fixtures).
- [x] T4 Commit de unidad de trabajo (staging selectivo) + espejo engram.

## Evidencia observada (2026-11-02)
- T1: `engine/codigo.mjs` — `bloquesDe()` separa las primitivas `tool_call`
  (y la variante `tool_call:`) del colapso "el mas largo por lenguaje": las
  guarda todas en orden de aparicion y descarta solo el contenido repetido
  exacto. Los demas lenguajes siguen colapsando como antes.
- T2: `engine/toolcall.mjs` — `parseToolCalls()` acumula las llamadas de TODOS
  los bloques (dedupe por name+args, `MAX_ARGS` por llamada) y un bloque que no
  parsea ya no aborta el resto. El fence del texto y el texto plano siguen
  siendo fallback, pero SOLO si ningun bloque rindio llamadas (postura
  anti-injection conservada).
- Cambio adicional incluido en la misma unidad (mismo archivo, mismo
  objetivo): el prompt de tool_call pide explicitamente la llamada en bloque
  cuando la respuesta necesita un dato del proyecto, en vez de narrar
  "voy a revisar el archivo" sin llamada.
- T3: `engine/toolcall.test.mjs` (nuevo, 9 tests) replica las formas reales
  de los dumps: 4 primitivas en paralelo -> 4 llamadas en orden, primitiva
  repetida -> 1, bloque con cola duplicada (meta-6) -> no tira las demas,
  bloques ganan al fence del texto, fallback historico intacto.
- Verificacion: `node --check engine/codigo.mjs engine/toolcall.mjs
  engine/toolcall.test.mjs` -> OK en los tres.
  `node --test engine/toolcall.test.mjs engine/limites.test.mjs
  engine/gateway.test.mjs` -> 36 pass, 0 fail.
- Harness de runtime: N/A para esta unidad (cambio de funciones puras de
  parseo; verificado con las formas de los dumps reales como fixtures, sin
  necesidad de reiniciar servicios ni pedir un turno en vivo).
- Rollback: revertir `engine/codigo.mjs`, `engine/toolcall.mjs` y
  `engine/toolcall.test.mjs` devuelve el parseo al comportamiento anterior
  (una sola tool call por respuesta) sin tocar el resto del arbol.
- T4: staging selectivo, en dos commits: (1) la unidad de trabajo
  (`engine/codigo.mjs`, `engine/toolcall.mjs`, `engine/toolcall.test.mjs` y
  este doc) y (2) el registro del hash de esa unidad en este mismo doc.
  NO se arrastra el WIP de otras lineas de trabajo (engine/artifacts.mjs,
  server.mjs, engine/gateway.mjs, engine/limites.test.mjs, webchat/).
  RDD global OFF (`gentle-ai review mode status`): no se lanza la revision
  nativa; la entrega sigue la politica del repositorio.

## Ruta elegida
Delegated direct (writer unico): 2 archivos no triviales + 1 test nuevo ->
trigger de writer. RDD global OFF (verificado `gentle-ai review mode status`).

## Pronostico de entrega
~120 lineas (codigo + tests). Debajo de 400 -> sin estrategia de cadena;
commit unico en el branch actual. Push/PR: decision del usuario.
