# webchat-un-puerto

## Objetivo

El front (webchat) y la API deben vivir en el **mismo puerto**: `127.0.0.1:8055`
sirve la API OpenAI-compatible **y** el front. Hoy son dos servicios y dos URLs
(broker Node en 8055, panel FastAPI en 8060) para un solo producto.

## Problema

El front solo habla rutas relativas `/api/*` (`webchat/index.html`), pero el
servidor que las implementa es un proceso Python aparte (`webchat/server.py`,
`meta-webchat.service`) que hace de proxy hacia 8055. Resultado: dos procesos,
dos puertos, un salto de red extra en cada peticion y dos contratos que pueden
divergir (el front depende de `/api/*`, la API expone `/v1/*`).

## Por qué

El usuario pidió explicitamente "la API + el front, no los quiero separados".
Ademas el servicio Python ya no aporta logica propia: todas sus rutas son
proxy o agregado sobre endpoints `/v1/*` que el broker Node ya implementa.

## Alcance autorizado

- Servir `GET /` (el front `webchat/index.html`) desde `server.mjs`.
- Implementar `/api/*` de forma nativa en `server.mjs`, **reutilizando los
  manejadores `/v1/*` ya existentes** (traduccion de ruta y de cuerpo), sin
  duplicar logica de negocio.
- Eximir de la puerta de autenticacion las rutas del front (`/` y `/api/*`)
  **solo en loopback**, igual que hoy hace el panel (`rutaDelPanel`).
- Retirar el servicio `meta-webchat.service` (8060) y `webchat/server.py`.
- Test de regresion + README al dia.

## Restricciones

- `127.0.0.1:8055` es loopback puro: `api.djlabs.cl` (el tunel) sirve otro
  proyecto (doc-gateway), NO meta-api. Unir los puertos **no** expone `/v1/*`.
- El front es un HTML autocontenido (sin assets externos): se sirve tal cual.
- En modo `auth=api-key`, `/v1/*` sigue exigiendo clave. Solo el front en
  loopback queda exento (mismo contrato que el panel actual).
- El motor protocol-first (sin navegador) no se toca.
- No se toca el contrato SSE de `/v1/chat/completions`.

## Checklist

- [ ] **T1** `server.mjs`: servir el front en `GET /` (+ `/index.html`).
- [ ] **T2** `server.mjs`: capa de traduccion `/api/*` -> `/v1/*` (reutiliza los
      manejadores existentes) con traduccion de cuerpo en `/api/chat` y
      `/api/clear`, y agregado propio en `/api/estado`.
- [ ] **T3** `server.mjs`: excepcion de auth loopback para `/` y `/api/*`.
- [ ] **T4** Test de regresion (`engine/un-puerto.test.mjs`).
- [ ] **T5** Retirar `meta-webchat.service` (host) y `webchat/server.py` (repo).
- [ ] **T6** README: documentar el front en 8055 y la retirada del 8060.

## Criterios de aceptacion

1. `GET http://127.0.0.1:8055/` devuelve el front (HTML del webchat).
2. `GET http://127.0.0.1:8055/api/estado` devuelve el JSON agregado que el front
   ya consume (mismas claves que hoy devuelve el panel).
3. `POST http://127.0.0.1:8055/api/chat` entrega SSE con el mismo formato que
   antes y `POST /api/clear` limpia el canal.
4. `/v1/chat/completions` sigue intacto para clientes OpenAI (OpenCode).
5. En `auth=api-key`, `/v1/*` sin clave sigue respondiendo 401.
6. Nada escucha en 8060 y `meta-webchat.service` no esta activo.
7. `node --test engine/*.test.mjs` en verde (mismo numero de pass o mas).

## Checks aplicables

- `node --test engine/*.test.mjs`
- `node --test agent/*.test.js`
- Humo HTTP: `curl` a `/`, `/api/estado`, `/health` en 8055.
- `systemctl --user status meta-api` (activo) y `meta-webchat` (inactivo).

## Progreso

_(pendiente)_

## Evidencia

_(se completa por tarea con el commit de la unidad de trabajo)_

## Ruta por tarea

| Tarea | Ruta | Motivo |
| --- | --- | --- |
| T1-T6 | delegada (1 writer) | toca `server.mjs` (3029 lineas), test, README y borra un servicio: 2+ archivos no triviales |

## Estrategia de entrega

`ask-on-risk` (default). Forecast bajo 400 lineas: un solo PR.

## Modo TDD

Estandar (no hay `strict_tdd: true` en engram). Runner: `node --test engine/*.test.mjs`.

## Siguiente paso

T1-T4 en el writer delegado; T5-T6 tras verificar el humo en 8055.
