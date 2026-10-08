// resolver.mjs — resuelve cada PASO por un SPEC semántico, con DOS métodos de cura:
//   1) LOCAL: anclas estables → heurística por texto → fallback geométrico.
//   2) REMOTA: baja un "mapa de selectores" versionado del server de cdpAutoCura.
// Y registra TELEMETRÍA de cada resolución.
//
// HOMOLOGADO del proyecto cdpAutoCura (ver /home/test/cdpAutoCura/lib/resolver.mjs).
// En el donbot se usa SOLO como capa de respaldo: el selector principal se evalúa
// primero; el Resolutor entra únicamente cuando el principal devuelve null.
//
// Uso:
//   import { Resolutor, Telemetria } from "./lib/resolver.mjs";
//   const tele = new Telemetria("donbot-wsp", rutaTelemetria);
//   const resol = new Resolutor(call, { app: "donbot-wsp", version: "1", mapaUrl: "http://127.0.0.1:8799/donbot-selectors.json", telemetria: tele });
//   const r = await resol.resolver("composer-wsp", SPEC_COMPOSER_WSP);
//   if (r) { /* usar r.selector */ }
import { appendFileSync } from "node:fs";
import { ev } from "./cdp.mjs";

export class Telemetria {
  constructor(app, ruta) { this.app = app; this.ruta = ruta; this.n = 0; this.ultimo = []; }
  registrar(e) {
    this.n++;
    const evt = { ts: new Date().toISOString(), app: this.app, ...e };
    this.ultimo.push(evt);
    if (this.ultimo.length > 50) this.ultimo.shift();
    try { appendFileSync(this.ruta, JSON.stringify(evt) + "\n"); } catch { /* no rompe */ }
    return evt;
  }
}

// Helpers que corren DENTRO de la página (cssPath + match por texto).
const EN_PAGINA = `
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const cssPath = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 6) {
      let p = el.tagName.toLowerCase();
      if (el.parentElement) {
        const sibs = [...el.parentElement.children].filter((c) => c.tagName === el.tagName);
        if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
      }
      parts.unshift(p); el = el.parentElement;
    }
    return parts.join(' > ');
  };`;

export class Resolutor {
  constructor(call, { app, version, mapaUrl, telemetria }) {
    this.call = call;
    this.app = app;
    this.version = String(version);
    this.mapaUrl = mapaUrl;
    this.tele = telemetria;
    this.mapa = null;
    this.aprendidos = {}; // rol -> selector que funcionó (memoria de la corrida)
  }

  /** MÉTODO 2 (remoto): baja el mapa versionado del server. */
  async bajarMapa() {
    try {
      const r = await fetch(this.mapaUrl);
      this.mapa = await r.json();
      this.tele.registrar({ tipo: "mapa-bajado", versionMapa: this.mapa.version, fecha: this.mapa.fecha });
      return this.mapa;
    } catch (e) {
      this.tele.registrar({ tipo: "mapa-fallo", error: String(e && e.message || e) });
      return null;
    }
  }

  /** Resuelve un rol por capas. Devuelve { selector, via } o null. */
  async resolver(rol, spec = {}) {
    const sel = spec.sel || "input,button,output,p,textarea,select";
    const rx = spec.rx || /.*/i;
    // CAPA 1 — mapa remoto (bajado del server de cdpAutoCura).
    if (this.mapaUrl && !this.mapa) await this.bajarMapa();
    const delMapa = this.aprendidos[rol] ||
      (this.mapa && this.mapa.selectores && this.mapa.selectores[this.version] && this.mapa.selectores[this.version][rol]);
    if (delMapa && await ev(this.call, `!!document.querySelector(${JSON.stringify(delMapa)})`)) {
      this.tele.registrar({ tipo: "resolver", rol, via: "mapa", selector: delMapa });
      return { selector: delMapa, via: "mapa" };
    }
    // CAPA 2 — data-rol estable.
    const dsel = `[data-rol="${rol}"]`;
    if (await ev(this.call, `!!document.querySelector(${JSON.stringify(dsel)})`)) {
      this.aprendidos[rol] = dsel;
      this.tele.registrar({ tipo: "resolver", rol, via: "data-rol", selector: dsel });
      return { selector: dsel, via: "data-rol" };
    }
    // CAPA 3 — ANCLAS estables declaradas en el spec (NO dependen del label).
    for (const a of (spec.anclas || [])) {
      if (await ev(this.call, `!!document.querySelector(${JSON.stringify(a)})`)) {
        this.aprendidos[rol] = a;
        this.tele.registrar({ tipo: "resolver", rol, via: "ancla", selector: a });
        return { selector: a, via: "ancla" };
      }
    }
    // CAPA 4 — heurística por aria + texto + placeholder.
    const h = await ev(this.call, `(() => { ${EN_PAGINA}
      const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
      const b = els.find((x) => ${rx}.test(norm(x.getAttribute('aria-label') || '') + ' ' + norm(x.textContent || '') + ' ' + norm(x.getAttribute('placeholder') || '')) && x.getBoundingClientRect().width > 0);
      if (!b) return null;
      return JSON.stringify({ selector: cssPath(b), txt: norm(b.getAttribute('aria-label') || b.textContent || '').slice(0, 30) });
    })()`);
    if (h) {
      const { selector, txt } = JSON.parse(h);
      this.aprendidos[rol] = selector;
      this.tele.registrar({ tipo: "resolver", rol, via: "heuristica", selector, txt });
      return { selector, via: "heuristica" };
    }
    // CAPA 5 — FALLBACK geométrico: el input/textarea de texto MÁS GRANDE visible.
    if (spec.masGrande) {
      const g = await ev(this.call, `(() => { ${EN_PAGINA}
        const els = [...document.querySelectorAll('input:not([type=hidden]),textarea,[contenteditable=true]')].filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        if (!els.length) return null;
        els.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return (rb.width * rb.height) - (ra.width * ra.height); });
        return JSON.stringify({ selector: cssPath(els[0]) });
      })()`);
      if (g) {
        const { selector } = JSON.parse(g);
        this.aprendidos[rol] = selector;
        this.tele.registrar({ tipo: "resolver", rol, via: "mas-grande", selector });
        return { selector, via: "mas-grande" };
      }
    }
    this.tele.registrar({ tipo: "resolver", rol, via: "fallo", selector: null });
    return null;
  }
}
