#!/bin/bash
# mensaje-meta.sh "texto" — postea en el hilo de META *SIN* el prefijo [DON BOT].
# Regla de Don Jack: los mensajes para Meta NO llevan mi prefijo, porque contamina
# sus respuestas. En WhatsApp, en cambio, SIEMPRE va el prefijo [DONBOT].
BIN="/home/test/test/meta-api/bridge"
NODE="/home/test/.nvm/versions/node/v22.23.3/bin/node"
TXT="$1"
[ -z "$TXT" ] && { echo "uso: mensaje-meta.sh \"texto\""; exit 1; }
echo "[$(date '+%H:%M:%S')] META-SIN-PREFIJO: $TXT" >> "$BIN/agent-log.txt"
TURNO=$("$NODE" "$BIN/turno.mjs" 2>/dev/null || echo 0)
printf '%s|%s\n' "$TURNO" "[DON BOT] $TXT" >> "$BIN/don-bot-enviados.txt"
printf '%s\n' "$TXT" > "$BIN/msg-meta.txt"
SIN_PREFIJO=1 "$NODE" "$BIN/enviar-hilo.mjs" "$BIN/msg-meta.txt"
