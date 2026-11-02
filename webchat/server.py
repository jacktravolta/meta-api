#!/usr/bin/env python3
"""
webchat — front web (FastAPI) contra la API OpenAI-compatible de meta-api.

No es un chat de Meta: es un CLIENTE de nuestra API. Todo lo que se ve en el
navegador es exactamente lo que devuelve 127.0.0.1:8055 (mismo prompt, mismo
hilo, mismos tiempos). Sirve para probar la API a mano, sin OpenCode.

Endpoints:
    GET  /              -> el front (index.html)
    GET  /api/estado   -> identidad y salud de la API (el lado sesion conserva
                          su contrato 503) mas los modos que el back soporta
    POST /api/clear     -> proxy a /v1/chat/clear (limpia el canal: conversacion
                           nueva en meta con el mismo id de canal)
    POST /api/chat      -> proxy a /v1/chat/completions (SSE, reenviado tal cual).
                          El body admite un campo opcional "modo":
                            "session" (o ausente/desconocido) -> tu cuenta
                            "guest"                           -> usuario invitado
                          Se reenvia a la API como "engine_mode": el back decide
                          la identidad de ESA peticion. No hay dos APIs: una sola
                          con dos motores (uno por identidad).
    GET  /api/ajustes   -> proxy a /v1/ajustes (modo de archivos y de auth)
    PUT  /api/ajustes   -> proxy a /v1/ajustes (guarda un cambio parcial)
    GET  /api/keys      -> proxy a /v1/keys (lista SIN el secreto)
    POST /api/keys      -> proxy a /v1/keys (crea una clave; el secreto sale
                          SOLO en esta respuesta)
    DELETE /api/keys/<i> -> proxy a /v1/keys/<i> (revoca una clave)
    GET  /v1/media/<f>  -> proxy de las imagenes y archivos generados. El
                          "?modo=" se acepta y se ignora (queda por compatibilidad
                          con URLs ya construidas).

Credencial de servicio: la API guarda en <repo>/engine/.webchat-key (0600, EN
CLARO) la clave interna del webchat. Este proxy la lee del disco y la manda en
X-API-Key en TODAS las llamadas. Si el archivo no existe, no se manda nada (la
API en modo "abierta" no la pide). Se lee en cada peticion para que una clave
generada despues (al cambiar el auth a "api-key") se use sin reiniciar nada.

Arranque:
    python3 webchat/server.py            # http://127.0.0.1:8060
    META_API=http://127.0.0.1:8055 python3 webchat/server.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import quote

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

API = os.environ.get("META_API", "http://127.0.0.1:8055").rstrip("/")
HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("WEBCHAAT_PORT", "8060"))
HOST = os.environ.get("WEBCHAAT_HOST", "127.0.0.1")
# la API puede tardar 3-60 s (meta piensa): el timeout del proxy es holgado.
# Un turno que genera artefactos (una presentacion) puede tardar varios
# minutos: el deadline del motor es de 10 min y su presupuesto total (turno +
# reintento) es de 15 min, asi que el proxy espera 16.
TIMEOUT = httpx.Timeout(960.0, connect=10.0)

# Credencial de servicio del webchat. La API la crea sola (engine/.webchat-key,
# modo 600, EN CLARO) y este proxy la lee del disco para mandarla en X-API-Key.
# No se cachea: si la API la genera despues (al pasar el auth a "api-key"), la
# siguiente peticion ya la usa.
RUTA_CLAVE_SERVICIO = HERE.parent / "engine" / ".webchat-key"

app = FastAPI(title="webchat meta-ai", docs_url="/api/docs")


def claveServicio() -> str:
    """Clave interna del webchat, o "" si todavia no existe en disco."""
    try:
        return RUTA_CLAVE_SERVICIO.read_text(encoding="utf8").strip()
    except OSError:
        return ""


def cabecerasApi(extra: dict | None = None) -> dict:
    """Cabeceras de la llamada a la API, con X-API-Key si hay clave de servicio."""
    cabeceras = dict(extra or {})
    clave = claveServicio()
    if clave:
        cabeceras["X-API-Key"] = clave
    return cabeceras


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(HERE / "index.html")


@app.get("/v1/media/{rel:path}")
async def media(rel: str, modo: str = "session") -> Response:
    """Proxy de las imagenes y archivos generados.

    El front escribe `/v1/media/<archivo>` (el campo `local` de meta_images y
    el campo `url` de meta_files), pero ese endpoint vive en la API (8055) y
    aqui solo estamos en 8060: sin este proxy la miniatura y el enlace darian
    404. Hay una sola API con dos motores, asi que no hay nada que enrutar.

    `?modo=` se acepta y se ignora: queda por compatibilidad con URLs ya
    construidas por el front.
    """
    destino = f"{API}/v1/media/{rel}"
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            r = await client.get(destino, headers=cabecerasApi())
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": {"message": str(exc)}}, status_code=502)
    if r.status_code != 200:
        return JSONResponse({"error": {"message": f"HTTP {r.status_code}"}}, status_code=r.status_code)
    mime = r.headers.get("content-type", "application/octet-stream")
    # Se reenvia Content-Disposition: la API lo arma con el nombre real del
    # archivo (puede traer espacios y tildes). Sin esto el navegador inventa
    # el nombre a partir de la URL.
    headers = {"Cache-Control": "private, max-age=300"}
    disposicion = r.headers.get("content-disposition")
    if disposicion:
        headers["Content-Disposition"] = disposicion
    return Response(content=r.content, media_type=mime, headers=headers)


@app.get("/api/estado")
async def estado() -> JSONResponse:
    """Salud e identidad de la API, y que modos de identidad soporta.

    Conserva su contrato original (503 si la API esta caida) y agrega lo que
    el back expone ahora: el modo por defecto y que motores ya estan creados.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{API}/health", headers=cabecerasApi())
            d = r.json()
        motor = d.get("motor") or {}
        modo = motor.get("modo")
        return JSONResponse({
            "ok": d.get("status") == "ok",
            "api": API,
            "modo": modo,
            # "logueado" = la sesion propia del usuario; "invitado" = sin sesion
            "identidad": "Tu cuenta" if modo == "session" else "Invitado",
            "logueado": modo == "session",
            "user_id": motor.get("userId"),
            "salas": motor.get("salas"),
            # modos que el back acepta por peticion ("engine_mode")
            "modo_por_defecto": motor.get("modo_por_defecto"),
            "modos_disponibles": motor.get("modos_disponibles") or ["session", "guest"],
            "modos_activos": motor.get("modos_activos") or [],
            "raw": d,
        })
    except Exception as exc:  # noqa: BLE001 - el front muestra el error
        return JSONResponse({"ok": False, "api": API, "error": str(exc)}, status_code=503)


@app.post("/api/clear")
async def clear(req: Request) -> JSONResponse:
    """Proxy de /v1/chat/clear: limpia el canal (conversacion nueva en meta).

    El canal conserva su id (user + project): meta abre una conversacion nueva
    para ese canal, asi el hilo se limpia sin duplicarlo en su historial.
    """
    body = await req.json()
    payload = {
        "user": body.get("user") or "webchat",
        "project": body.get("project") or "",
        # identidad de esta peticion: "session" (tu cuenta) o "guest" (invitado)
        "engine_mode": str(body.get("modo") or "session").lower(),
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(f"{API}/v1/chat/clear", json=payload, headers=cabecerasApi())
    except Exception as exc:  # noqa: BLE001 - el front muestra el error
        return JSONResponse({"error": {"message": str(exc)}}, status_code=502)
    try:
        datos = r.json()
    except Exception:  # noqa: BLE001
        datos = {"error": {"message": f"HTTP {r.status_code}"}}
    return JSONResponse(datos, status_code=r.status_code)


@app.get("/api/ajustes")
async def ajustes_get() -> JSONResponse:
    """Ajustes en caliente de la API (modo de archivos y modo de auth).

    El JSON y el status se devuelven tal cual vienen de la API: el front
    muestra el mensaje REAL del back (por ejemplo, el 400 con el valor
    invalido).
    """
    return await _proxyApi("GET", "/v1/ajustes")


@app.put("/api/ajustes")
async def ajustes_put(req: Request) -> JSONResponse:
    """Guarda un cambio PARCIAL de ajustes.

    El body se reenvia tal cual (bytes) para que la API sea quien valida los
    valores y conteste su propio 400 con el mensaje exacto.
    """
    return await _proxyApi("PUT", "/v1/ajustes", contenido=await req.body())


@app.get("/api/keys")
async def keys_get() -> JSONResponse:
    """Lista de API keys. NUNCA trae el secreto (la API solo guarda su hash)."""
    return await _proxyApi("GET", "/v1/keys")


@app.post("/api/keys")
async def keys_post(req: Request) -> JSONResponse:
    """Crea una API key. El secreto sale SOLO en esta respuesta."""
    return await _proxyApi("POST", "/v1/keys", contenido=await req.body())


@app.delete("/api/keys/{clave_id}")
async def keys_delete(clave_id: str) -> JSONResponse:
    """Revoca una API key (queda invalidada de inmediato)."""
    return await _proxyApi("DELETE", f"/v1/keys/{quote(clave_id, safe='')}")


async def _proxyApi(metodo: str, ruta: str, contenido: bytes | None = None) -> JSONResponse:
    """Proxy JSON generico hacia la API.

    Devuelve el JSON y el status de la API tal cual (incluido el 400 con su
    mensaje y el 404 de una clave que no existe). Si la API no responde, un
    502 con { "error": { "message": ... } }: el front siempre tiene algo real
    que mostrar.
    """
    cabeceras = cabecerasApi({"Accept": "application/json"})
    if contenido is not None:
        cabeceras["Content-Type"] = "application/json"
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.request(metodo, f"{API}{ruta}", content=contenido, headers=cabeceras)
    except Exception as exc:  # noqa: BLE001 - el front muestra el error
        return JSONResponse({"error": {"message": str(exc)}}, status_code=502)
    try:
        datos = r.json()
    except Exception:  # noqa: BLE001
        datos = {"error": {"message": f"HTTP {r.status_code}"}}
    return JSONResponse(datos, status_code=r.status_code)


@app.post("/api/chat")
async def chat(req: Request) -> StreamingResponse:
    """Proxy de /v1/chat/completions. Reenvia el SSE tal cual (el front lo parsea).

    El campo opcional "modo" del body ("session" | "guest") se reenvia a la API
    como "engine_mode": el back decide la identidad de ESA peticion. No hay dos
    APIs ni dos upstreams: una sola API con un motor por identidad.
    """
    body = await req.json()
    mensajes = body.get("mensajes") or []
    modo = str(body.get("modo") or "session").lower()
    if modo not in ("session", "guest"):
        modo = "session"
    payload = {
        "model": body.get("model") or "meta-ai",
        "messages": mensajes,
        "stream": True,
        # 'user' fija el hilo de meta de esta conversacion (la API lo usa como
        # clave de chat): cada pestana tiene su propio hilo.
        "user": body.get("user") or "webchat",
        # identidad de esta peticion: "session" (tu cuenta) o "guest" (invitado)
        "engine_mode": modo,
    }

    async def eventos():
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                async with client.stream(
                    "POST", f"{API}/v1/chat/completions", json=payload, headers=cabecerasApi()
                ) as resp:
                    if resp.status_code != 200:
                        detalle = (await resp.aread()).decode("utf8", "replace")[:500]
                        yield _sse({"error": {"message": f"HTTP {resp.status_code}: {detalle}"}})
                        yield "data: [DONE]\n\n"
                        return
                    async for linea in resp.aiter_lines():
                        if linea.startswith("data: "):
                            yield linea + "\n\n"
                        elif linea.startswith(":"):
                            # latido del servidor: se pasa para que el front
                            # pueda mostrar "sigue pensando" sin inventarse nada
                            yield linea + "\n\n"
        except Exception as exc:  # noqa: BLE001
            yield _sse({"error": {"message": str(exc)}})
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        eventos(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


def _sse(obj: dict) -> str:
    return "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"


if __name__ == "__main__":
    print(f"webchat -> http://{HOST}:{PORT}  (api: {API})")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
