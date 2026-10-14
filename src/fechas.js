/**
 * Aritmética de fechas de facturación.
 *
 * Todo en YYYY-MM-DD y sin zonas horarias: un periodo de facturación es un día
 * de calendario, no un instante. Vive aparte porque el cálculo del periodo lo
 * usan tanto las rutas como las acciones en lote, y tener dos copias sería
 * tener dos respuestas distintas a la misma pregunta.
 */

const pad2 = (n) => String(n).padStart(2, '0');

export const hoyISO = () => new Date().toISOString().slice(0, 10);

export function sumarDias(iso, dias) {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d) + dias * 86400000).toISOString().slice(0, 10);
}

export function diasEntre(desde, hasta) {
  const p = (s) => { const [a, m, d] = s.split('-').map(Number); return Date.UTC(a, m - 1, d); };
  return Math.round((p(hasta) - p(desde)) / 86400000);
}

export const esFecha = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

/**
 * El día `ancla` de ese mes, recortado al último día si el mes no lo tiene.
 * Un servicio que parte un 31 se cobra el 28 en febrero, no el 3 de marzo.
 */
export function diaDeMes(anio, mes, ancla) {
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${anio}-${pad2(mes)}-${pad2(Math.min(ancla, ultimo))}`;
}

/**
 * Inicio del periodo número `n` (1 = el primero) de un servicio mensual.
 *
 * Se cuenta desde la fecha de inicio, no desde el periodo anterior. Encadenar
 * sumando 30 días es justo lo que hacía correrse el día de cobro: con meses de
 * 31 el aniversario se atrasa uno cada vez, y en un año son seis días.
 */
export function inicioMensual(fechaInicio, n) {
  const [a, m, d] = fechaInicio.split('-').map(Number);
  const t = (m - 1) + (n - 1);
  return diaDeMes(a + Math.floor(t / 12), (t % 12) + 1, d);
}

/**
 * Desde y hasta del periodo número `numero` (1 = el primero).
 *
 * `mensual` respeta el día del mes; `dias` cuenta bloques de `dias_ciclo`, que
 * sirve para servicios que se cobran por quincena o por cantidad de turnos.
 * Los dos se calculan desde la fecha de inicio, así que un periodo mal grabado
 * no arrastra a los siguientes.
 */
export function periodoDe(servicio, numero) {
  if (servicio.ciclo_tipo === 'dias') {
    const dias = servicio.dias_ciclo || 30;
    const desde = sumarDias(servicio.fecha_inicio, (numero - 1) * dias);
    return { desde, hasta: sumarDias(desde, dias - 1) };
  }
  return {
    desde: inicioMensual(servicio.fecha_inicio, numero),
    hasta: sumarDias(inicioMensual(servicio.fecha_inicio, numero + 1), -1),
  };
}
