#!/usr/bin/env python3
"""transcribir.py — transcribe un audio con faster-whisper (local, CPU).
Uso: python transcribir.py /ruta/audio.ogg
Modelo tiny (int8, CPU): rapido y suficiente para notas de voz. La primera vez
descarga ~75MB. Imprime SOLO el texto transcripto.
"""
import sys
from faster_whisper import WhisperModel

ruta = sys.argv[1]
modelo = WhisperModel("tiny", device="cpu", compute_type="int8")
segmentos, info = modelo.transcribe(ruta, language="es", vad_filter=True)
texto = " ".join(s.text.strip() for s in segmentos).strip()
print(texto)
