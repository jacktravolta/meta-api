#!/bin/bash
# progreso.sh "texto" — publica progreso del agente en el canal Don Bot.
#   - lo agrega al log local (con hora)
#   - lo registra en don-bot-enviados.txt (anti-suplantacion)
#   - lo publica en el hilo con la firma [DON BOT]
BIN="/home/test/test/meta-api/bridge"
NODE="/home/test/.nvm/versions/node/v22.23.3/bin/node"
TXT="$1"
[ -z "$TXT" ] && { echo "uso: progreso.sh \"texto\""; exit 1; }
echo "[$(date '+%H:%M:%S')] PROGRESO: $TXT" >> "$BIN/agent-log.txt"
# Registro con TURNO (turno|texto): el detector coteja por posicion.
TURNO=$("$NODE" "$BIN/turno.mjs" 2>/dev/null || echo 0)
printf '%s|%s\n' "$TURNO" "$TXT" >> "$BIN/don-bot-enviados.txt"
printf '[DON BOT] %s\n' "$TXT" > "$BIN/msg-meta.txt"
"$NODE" "$BIN/enviar-hilo.mjs" "$BIN/msg-meta.txt"
