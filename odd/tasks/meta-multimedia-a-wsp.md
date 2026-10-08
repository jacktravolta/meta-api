# Meta multimedia -> WSP

## Objetivo
Cuando Meta AI responde en su hilo con multimedia (imagenes generadas), rescatarla
y enviarla al canal de WhatsApp, ademas del texto. Y al reves: cuando por WhatsApp
llega CUALQUIER adjunto (imagen, audio, video, documento, texto), que llegue a Meta
y Meta lo procese. Si el tipo NO es procesable por Meta, responder
"ese archivo no es procesable".

## Hallazgos (analisis CDP, 2026-10-08)
- Meta **no** usa Cache Storage (vacio). Guarda en IndexedDB.
- `ecto-recent-attachments` / store `files`: adjuntos subidos (Blob directo).
- Las imagenes **generadas** por Meta se renderizan como
  `<img src="https://scontent*.fbcdn.net/...">` (naturalWidth>200).
- Extraccion de esas imagenes: `fetch(url, {credentials:"include"})` -> FALLA (CORS);
  `canvas.toDataURL()` -> FALLA (canvas contaminado); `fetch(url)` plano -> **OK**.
- WhatsApp Web: el envio de media por `DOM.setFileInputFiles` CRASHEA el renderer
  (`RESULT_CODE_KILLED_BAD_MESSAGE`, Chrome Beta 149). Se usa **inyeccion JS**
  (base64 -> `DataTransfer` -> evento `change`). Ver `bridge/enviar-media-wsp.mjs`.
- Cache de WhatsApp: IDB `lru-media-storage-idb`/store `lru-media-meta-info` +
  Cache `lru-media-array-buffer-cache` + URL
  `https://_media_cache_v2_.whatsapp.com/lru-media-array-buffer-cache_<id>`.
  Se clasifica por magic bytes (`%PDF`->documento, `RIFF..WEBP`->imagen, `OggS`->audio,
  `ftyp`->video). El `timestamp` de la IDB es la hora de la fila.
- Los DOCUMENTOS no estan en el cache hasta que se abren/descargan: hay que clickear
  la burbuja (`document-thumb`) y recien ahi aparece el PDF en el cache.

## Arquitectura (relay/wsp.mjs, rama por tipo)
- **imagen**: `bajarDelCache(..., "imagen")`; si no hay, respaldo por click + canvas.
- **audio / video**: cache o extraccion propia.
- **documento**: click en la burbuja -> cache-first (15 s); si NO aparece en el cache,
  **DESCARGA** via `Browser.setDownloadBehavior({behavior:"allow", downloadPath:MEDIA})`
  + click en el boton `aria-label="Descargar"` -> archivo nuevo en MEDIA.
  Autodeteccion: no se hardcodea `.doc/.xls`; lo decide el browser (cacheable o no).
- **GUARD DE TIPO**: `extDeArchivo` + `EXT_META_ACEPTA` (lista del `accept` real del
  composer de Meta). Si la extension no esta, se responde "no procesable" y NO se manda.
- **baseline**: por chat, marca todo MENOS el ultimo mensaje, para no perder uno que
  llegue durante un reinicio. (Bug corregido: `primerCiclo` se comia ese ultimo.)

## Tasks
- [x] T1: `bridge/enviar-media-wsp.mjs` (enviar archivo a WhatsApp) + probarlo.
- [x] T2: extraccion de imagenes en el espejo (fetch plano en la pagina).
- [x] T3: integracion espejo -> enviar-media-wsp + prueba en vivo en BOTEST.
- [x] T4: rama de documento en el relay (cache-first + descarga + guard de tipo).
- [x] T5: fix del baseline (`primerCiclo`) que anulaba el "ultimo pendiente".
- [ ] T6: probar la via de DESCARGA con un documento NO cacheable (.doc/.xlsx).
- [x] T7: fix del envio de imagenes a WhatsApp (salian como STICKER 512x512).
- [x] T8: duplicacion resuelta: el espejo relaya solo multimedia; el texto lo da el relay.

## Decisiones (2026-10-08 noche)
- **Envio de imagenes a WhatsApp**: el PRIMER `input[type=file]` del DOM de WhatsApp
  Web es el de **stickers** (`accept="image/*"`, sin video). El de **fotos** lleva
  video en el accept (`image/*,video/mp4,...`). `enviar-media-wsp.mjs` tomaba el
  primero -> todo salia como sticker 512x512 (la "miniatura"). Ahora elige el input
  con `accept*="video"`.
- **Duplicacion**: cada respuesta de Meta llegaba dos veces (espejo `✨` + relay `🧠`).
  Regla del usuario: el espejo relaya **solo multimedia** (imagenes/archivos); el
  texto de Meta lo entrega el relay. No se apaga el espejo porque es el que relaya
  las imagenes.
- **canal.json**: puede quedar viejo si el hilo de Meta cambia de id. El espejo ahora
  cae a la primera pestaña `meta.ai/prompt/` abierta en vez de morir en bucle.

## Verificado en vivo (2026-10-08 00:35)
- Imagen enviada con el fix: mensaje `image-thumb` / "Abrir foto", 800x600 (foto real),
  ya NO sticker (`sticker-container` 512x512 era el bug).

## Verificado en vivo (2026-10-08 00:13)
- PDF "Explicame este pdf" (AC0E1F45A75A64B7694ACECEE4EF8481):
  `entrante` -> `Procesando documento...` -> `cache documento ...: 2864401 bytes .pdf`
  -> `documento guardado ... 2797 KB` -> Meta lo lee -> respuesta en WhatsApp.
- El PDF extraido es valido: `PDF document, version 1.4, 4 page(s)`.

## Pendiente / riesgo
- **Artefacto PDF de Meta**: cuando Meta "genera un PDF", lo publica como artefacto
  descargable (ej. `Analisis_Cerebro_Virtual_de_Obra.pdf`) ademas de la imagen. El
  espejo hoy solo rescata `<img>`, NO el documento/artefacto. Falta relayarlo.
- Falta validar la descarga con `.doc`/`.xlsx` (requiere que el usuario mande uno).
- Quedaron 4 mensajes de prueba (3 stickers + 1 foto) en BOTEST; no se pudieron borrar
  por UI.
- Los cambios NO estan commiteados; la rama actual es `feat/bwrap-sandbox` (revisar
  antes de commitear este trabajo).
- Editar `relay/state/wsp-vistos.json` con el relay corriendo es inutil: la instancia
  viva lo reescribe cada 2 s. Hay que parar el servicio primero.
