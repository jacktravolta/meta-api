# Adjuntos por Cache Storage (sin reproducir en el browser)

## Objetivo
Bajar CUALQUIER adjunto de WhatsApp (imagen, audio, video) a un archivo temporal
leyendolo del cache del navegador, sin reproducir audio, sin abrir el visor de
video, sin clickear la burbuja y sin tocar la cache de la pestana. Despues, si
corresponde, adjuntarlo a Meta.

## Problema
Lo que dejaba inestable al relay no era procesar archivos, era la INTERACCION
con el browser para conseguir los bytes:
- audio: CLICK_PLAY + `Network.setCacheDisabled(true)` en TODA la pestana + sniff.
- video: abrir `media-viewer-modal` solo para sacar la URL del stream.
- imagen: click en la burbuja + cierre del visor (y el Escape a ciegas que
  cerraba el chat, corregido en 9cbda2f).

## Por que se puede
WhatsApp guarda cada media recibido YA DESCIFRADO en Cache Storage:
- IDB `lru-media-storage-idb` -> store `lru-media-meta-info`: `{id, timestamp, size}`.
  El `timestamp` ES la hora del mensaje (verificado contra el DOM).
- Cache `lru-media-array-buffer-cache`, URL
  `https://_media_cache_v2_.whatsapp.com/lru-media-array-buffer-cache_<encodeURIComponent(id)>`.
- `caches.match(url).arrayBuffer()` devuelve el archivo COMPLETO.

Evidencia (2026-10-07): 69 entradas, 48 OGG + 19 JPEG + 2 MP4, 4.3 MB,
`discrepanciasSize = 0`. El video de las 3:26 se cacheo solo al recibirse, sin
que nadie lo tocara.

## Alcance
- `relay/wsp.mjs`: leer del cache como camino PRINCIPAL de las tres ramas.
- Los caminos viejos quedan como RESPALDO (no se borran todavia).
- Fuera de alcance: cambiar el ruteo a Meta o la transcripcion.

## Restricciones
- El cache es LRU (69 entradas, 4.3 MB): hay que leer pronto tras la llegada.
- `indexedDB.open` SIN version, para no disparar un upgrade.
- Un audio NUEVO sin reproducir todavia no esta verificado: por eso el respaldo.

## Checks
- `node --check relay/wsp.mjs`
- `node --test 'relay/*.test.mjs'` y `node --test 'agent/*.test.js'`
- En vivo contra Chrome 9233 (visible): extraer imagen, video y audio de mensajes
  reales del hilo y comprobar bytes magicos.

## Tareas
- [x] T1 — `LEER` expone `hora` de cada fila (fuente del emparejamiento).
- [x] T2 — `bajarDelCache(call, m, tipo)`: candidatos por hora + clasificacion por
      bytes magicos (JPEG/OGG/MP4/WEBM/PNG) + bytes del elegido.
- [x] T3 — registro persistente de medios ya consumidos (`state/wsp-medios-vistos.json`).
- [x] T4 — rama de imagen: cache primero, canvas de respaldo.
- [x] T5 — rama de audio: cache primero, play de respaldo.
- [x] T6 — rama de video: cache primero, visor de respaldo.
- [x] T7 — pruebas, guardas y verificacion en vivo.

## Progreso
- Commit 1: `feat(relay): los adjuntos se leen del cache de WhatsApp sin reproducir`.

### Verificacion en vivo (2026-10-07, Chrome 9233 visible)
Se extrajo la funcion REAL del fuente (no una copia) y se corrio contra el cache:

| tipo | resultado | verificado con |
|---|---|---|
| imagen | 252244 B `.jpg`, cabecera JFIF, tamaño COINCIDE | PIL: JPEG 800x1600 RGB, decodifica |
| audio | 16974 B `.ogg`, cabecera OggS, tamaño COINCIDE | ffprobe: opus 48 kHz mono, 8.59 s |
| video | 131072 B `.mp4`, cabecera `ftypiso4`, tamaño COINCIDE | ffprobe: hevc 832x1120, 5.04 s |

Estado del chat tras las pruebas: `titulo BOTEST, visor false` — **no se abrio
ningun visor, no se reprodujo nada, no se clickeo nada**.

Cada bajada reporto su distancia a la hora de la fila: 50 s, 31 s y 38 s
respectivamente (dentro del margen de 180 s).

### Pendiente
- Verificar con una nota de voz NUEVA (sin reproducir) que WhatsApp la cachea al
  recibirla y no solo al reproducirla. Hasta entonces el camino viejo queda como
  respaldo y no se borra.
- Los caminos viejos (canvas, play+sniff, visor+fetch) siguen ahi como respaldo.
