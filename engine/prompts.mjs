// prompts.mjs — reglas PROPIAS del cliente para hablarle a meta.
//
// 1) COMO HAY QUE PEDIR ARCHIVOS/CODIGO
//    Meta tiene dos salidas: (a) bloque de codigo en el mensaje, o (b) un
//    artefacto/visor incrustado en su front (el icono "<>"), que el front
//    renderiza. El cliente (gateway) SOLO puede leer los bloques de codigo:
//    un artefacto embebido no viaja en el stream. Hay que pedirlo explicito.
//
// 2) QUE HACER CUANDO META SE QUEDA CALLADO
//    Es un defecto conocido del servicio (tambien pasa en la web): la
//    generacion se queda en "pensando" o se corta a mitad. La web se
//    recupera escribiendo "continua". El motor hace lo mismo: watchdog que
//    reenvia "continua" en el MISMO hilo cuando el turno se queda mudo.

export const REGLAS_CODIGO = `
COMO ME ENTREGAZ EL ARCHIVO (obligatorio, leelo):
- NO lo muestres como artefacto, mock o visor incrustado en tu interfaz (el icono "<>").
- NO lo renderices: yo NO puedo ver lo que renderizas, solo leo el mensaje.
- Enviame el contenido como TEXTO dentro de un bloque de codigo con su lenguaje (por ejemplo un bloque de codigo html).
- Si el archivo es largo, entrega el bloque COMPLETO en una sola respuesta, sin "continuara" ni partes pendientes.
- Si no cabe entero, entrega la primera parte completa y luego me dices "continua" para el resto.
`.replace("ENTREGAZ", "ENTREGAS");

export const REGLAS_CONTINUA = `
Si la generacion se queda sin contenido o se corta a mitad, NO te quedes callado: responde con lo que llevas hasta ahora y sigue.
`.trim();

/** Prompt de generacion de archivo: rol + reglas de entrega. */
export function promptArchivo({ rol, requisitos = [], entrega = "un solo archivo index.html con HTML, CSS y JavaScript inline" }) {
	return [
		rol,
		requisitos.length ? "REQUISITOS OBLIGATORIOS:" : "",
		...requisitos.map((r) => `- ${r}`),
		requisitos.length ? "" : "",
		`ENTREGA: ${entrega}.`,
		REGLAS_CODIGO,
	].filter((l) => l !== undefined).join("\n");
}

/** El watchdog usa esta frase cuando el turno se queda mudo. */
export const FRASE_CONTINUA = "continua";
