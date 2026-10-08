# SPEC — Fani Agenda (MVP)

Fecha: 2026-10-08. Stack base reusado: relay WhatsApp por CDP (`relay/`), agente
CONSOLE/Don Bot (`agent/`, invocación por prefijo o alias según `relay/nombres.mjs`),
doc-gateway (RAG), Node 22 ESM cero dependencias, systemd (`systemd/`,
`relay/operar.sh`).

## 1) Objetivo

Que un negocio chico agende, cancele y recuerde turnos por WhatsApp sin apps ni
paneles: el cliente escribe por WhatsApp y Don Bot gestiona la agenda reusando el
stack existente.

## 2) Alcance del MVP

- Recepción y envío de mensajes WhatsApp vía relay CDP existente.
- Intenciones: agendar, cancelar, consultar estado y consultas frecuentes.
- Agenda de turnos por servicio, profesional y franja horaria.
- Confirmación de turno y recordatorios automáticos configurables (por defecto
  24 h y 2 h antes).
- Persistencia local en archivo JSON, coherente con `pending-jobs.json`/`state.json`.
- Consultas frecuentes (servicios, precios, horarios) vía doc-gateway (RAG).
- Operación por systemd: unidad de servicio más timer para recordatorios.
- Un solo negocio (single-tenant) por instancia.

## 3) Fuera de alcance

Pagos y cobros; sincronización con calendarios externos (Google/Outlook); panel web
o app del negocio; multi-tenant; canales distintos de WhatsApp; generación libre de
turnos con IA (solo intenciones por reglas); reportes y estadísticas;
recordatorios por otro canal.

## 4) Requisitos funcionales

- RF-1: Recibir mensajes entrantes por el relay CDP y normalizarlos (teléfono,
  texto, timestamp).
- RF-2: Reconocer la invocación a Fani Agenda (prefijo o alias) y clasificar la
  intención: agendar, cancelar, estado, consulta.
- RF-3: Agendar preguntando servicio, fecha y hora cuando falten datos, validando
  horario comercial, duración del servicio y solapamientos.
- RF-4: Guardar el turno con estado `confirmado` y responder con resumen
  (servicio, profesional, fecha, hora, id).
- RF-5: Cancelar localizando el turno por id o fecha, pedir confirmación, marcar
  `cancelado` y liberar la franja.
- RF-6: Consultar los próximos turnos del cliente ("mis turnos").
- RF-7: Recordatorios: el timer de systemd escanea turnos próximos y envía el
  recordatorio por el relay a las horas configuradas, marcando `enviado`.
- RF-8: Responder consultas frecuentes vía doc-gateway (RAG) con fuente del
  negocio.
- RF-9: Rechazar franjas ocupadas o fuera de horario proponiendo la siguiente
  libre.
- RF-10: Registrar cada mensaje e intención en journald para auditoría.
- RF-11: Degradación: ante fallo del relay o Chrome, el vigía reintenta y la
  agenda persiste en disco.

## 5) Requisitos no funcionales

- RNF-1: Latencia de respuesta < 2 s p95 en horario comercial (acotada por la
  latencia del navegador).
- RNF-2: Disponibilidad 99 % en horario comercial; reinicio automático por
  systemd.
- RNF-3: Cero dependencias npm: solo módulos nativos de Node 22 (ESM).
- RNF-4: Persistencia ante reinicio (escritura con fsync antes de confirmar).
- RNF-5: Mínimo PII: teléfono, nombre y turnos; sin copias fuera del repo.
- RNF-6: Un proceso por unidad systemd; logs a journald con rotación estándar.
- RNF-7: Reintentos con backoff ante fallo de CDP; cola de pendientes si el
  envío falla.
- RNF-8: Configuración por variables de entorno y JSON, al estilo de
  `relay/nombres.mjs`.

## 6) Modelo de datos mínimo (`fani-agenda.json`)

- business: { nombre, horario { desde, hasta, dias }, recordatoriosHoras [24, 2] }
- servicio: { id, nombre, duracionMin, precio? }
- cliente: { id, telefono, nombre? }
- turno: { id, clienteId, servicioId, profesional, fechaISO, horaInicio, estado
  (confirmado | cancelado), recordatorios [{ a, enviado }], creado, actualizado }
- mensaje: { id, telefono, texto, intencion, ts, turnoId? }

## 7) Flujos

- Agendar: el cliente escribe "agendar turno" → Don Bot pregunta servicio → fecha
  → hora → valida disponibilidad (RF-3) → confirma y guarda (RF-4) → programa
  recordatorios (RF-7) → responde resumen.
- Cancelar: el cliente escribe "cancelar turno del 12/10" → busca el turno
  (RF-5) → pide confirmación → marca cancelado → libera la franja → responde.
- Recordar: el timer de systemd (cada 15 min) escanea turnos con recordatorio
  pendiente dentro de la ventana → envía por el relay → marca enviado; si el
  envío falla, reintenta en el próximo ciclo.

## Notas

Verificación: `node --check` sobre los módulos nuevos y
`node --test 'agent/*.test.js'` con Node 22 desde la raíz del repo, más
`./relay/operar.sh start` para el despliegue systemd.
