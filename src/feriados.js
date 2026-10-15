/**
 * Feriados legales chilenos y días hábiles.
 *
 * Existe por una sola razón: el feriado legal se cuenta en días hábiles
 * (art. 67 CT) y el sábado se tiene siempre por inhábil para estos efectos
 * (art. 69 CT). Contar quince días corridos en vez de quince hábiles le quita
 * al trabajador tres días de vacaciones al año, y es el error más fácil de
 * cometer en una planilla hecha a mano.
 *
 * Los feriados se calculan, no se cargan: una tabla que hay que mantener a
 * mano cada diciembre es una tabla que en enero está incompleta. Pero el
 * cálculo se ofrece como propuesta, nunca como veredicto: la pantalla muestra
 * los días que salieron y RRHH puede corregirlos. Hay feriados regionales
 * (Arica, Chiloé) y días que se declaran por ley cada tanto, y el sistema no
 * tiene cómo saberlos.
 */

const pad2 = (n) => String(n).padStart(2, '0');
const iso = (a, m, d) => `${a}-${pad2(m)}-${pad2(d)}`;

/** Domingo de Pascua del año, por el algoritmo de Gauss-Butcher. */
function pascua(anio) {
  const a = anio % 19;
  const b = Math.floor(anio / 100);
  const c = anio % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  return Date.UTC(anio, mes - 1, dia);
}

const desdeUTC = (ms) => new Date(ms).toISOString().slice(0, 10);
const diaSemana = (fecha) => new Date(fecha + 'T00:00:00Z').getUTCDay(); // 0 domingo

/**
 * Traslado de la Ley 19.668: San Pedro y San Pablo (29 de junio) y el
 * Encuentro de Dos Mundos (12 de octubre) se corren al lunes de esa misma
 * semana si caen martes, miércoles o jueves, y al lunes siguiente si caen
 * viernes. Si caen sábado, domingo o lunes se quedan donde están.
 */
function trasladoLunes(fecha) {
  const d = diaSemana(fecha);
  const base = Date.parse(fecha + 'T00:00:00Z');
  if (d >= 2 && d <= 4) return desdeUTC(base - (d - 1) * 86400000); // al lunes anterior
  if (d === 5) return desdeUTC(base + 3 * 86400000);                // al lunes siguiente
  return fecha;
}

/**
 * Traslado de la Ley 20.299 para el Día de las Iglesias Evangélicas (31 de
 * octubre): si cae martes se adelanta al viernes anterior, y si cae miércoles,
 * jueves o viernes se corre al viernes siguiente.
 */
function trasladoViernes(fecha) {
  const d = diaSemana(fecha);
  const base = Date.parse(fecha + 'T00:00:00Z');
  if (d === 2) return desdeUTC(base - 4 * 86400000);
  if (d >= 3 && d <= 5) return desdeUTC(base + (5 - d) * 86400000);
  return fecha;
}

/** Los feriados del año, como { fecha: glosa }. */
export function feriadosDe(anio) {
  const p = pascua(anio);
  const f = {};
  const poner = (fecha, glosa) => { f[fecha] = glosa; };

  poner(iso(anio, 1, 1),  'Año Nuevo');
  poner(desdeUTC(p - 2 * 86400000), 'Viernes Santo');
  poner(desdeUTC(p - 1 * 86400000), 'Sábado Santo');
  poner(iso(anio, 5, 1),  'Día del Trabajo');
  poner(iso(anio, 5, 21), 'Glorias Navales');
  // Ley 21.357: el Día de los Pueblos Indígenas es el solsticio de invierno,
  // que cae el 20 o el 21 de junio según el año. Se propone el 20; si ese año
  // fue el 21, RRHH lo corrige en el registro.
  poner(iso(anio, 6, 20), 'Día de los Pueblos Indígenas (solsticio: puede ser el 21)');
  poner(trasladoLunes(iso(anio, 6, 29)), 'San Pedro y San Pablo');
  poner(iso(anio, 7, 16), 'Virgen del Carmen');
  poner(iso(anio, 8, 15), 'Asunción de la Virgen');
  poner(iso(anio, 9, 18), 'Independencia Nacional');
  poner(iso(anio, 9, 19), 'Glorias del Ejército');
  // Ley 20.215: el 17 de septiembre es feriado cuando cae lunes y el 20 cuando
  // cae viernes, para no dejar un día suelto entre el fin de semana y el 18.
  if (diaSemana(iso(anio, 9, 17)) === 1) poner(iso(anio, 9, 17), 'Fiestas Patrias');
  if (diaSemana(iso(anio, 9, 20)) === 5) poner(iso(anio, 9, 20), 'Fiestas Patrias');
  poner(trasladoLunes(iso(anio, 10, 12)), 'Encuentro de Dos Mundos');
  poner(trasladoViernes(iso(anio, 10, 31)), 'Día de las Iglesias Evangélicas');
  poner(iso(anio, 11, 1),  'Día de Todos los Santos');
  poner(iso(anio, 12, 8),  'Inmaculada Concepción');
  poner(iso(anio, 12, 25), 'Navidad');
  return f;
}

const cache = new Map();
const delAnio = (anio) => {
  if (!cache.has(anio)) cache.set(anio, feriadosDe(anio));
  return cache.get(anio);
};

export const esFeriado = (fecha) => !!delAnio(Number(fecha.slice(0, 4)))[fecha];
export const glosaFeriado = (fecha) => delAnio(Number(fecha.slice(0, 4)))[fecha] || null;

/**
 * Días hábiles entre dos fechas, ambas incluidas.
 *
 * Hábil = de lunes a viernes y que no sea feriado. El sábado queda fuera
 * porque el art. 69 lo declara inhábil para el feriado, que es justamente
 * para lo que sirve esta cuenta.
 */
export function diasHabiles(desde, hasta) {
  let n = 0;
  let t = Date.parse(desde + 'T00:00:00Z');
  const fin = Date.parse(hasta + 'T00:00:00Z');
  if (!Number.isFinite(t) || !Number.isFinite(fin) || fin < t) return 0;
  // Un rango abierto por error no puede dejar el Worker contando para siempre.
  if (fin - t > 400 * 86400000) return 0;
  while (t <= fin) {
    const f = desdeUTC(t);
    const d = new Date(t).getUTCDay();
    if (d >= 1 && d <= 5 && !delAnio(Number(f.slice(0, 4)))[f]) n++;
    t += 86400000;
  }
  return n;
}

/** Días corridos entre dos fechas, ambas incluidas. */
export function diasCorridos(desde, hasta) {
  const t = Date.parse(desde + 'T00:00:00Z');
  const fin = Date.parse(hasta + 'T00:00:00Z');
  if (!Number.isFinite(t) || !Number.isFinite(fin) || fin < t) return 0;
  return Math.round((fin - t) / 86400000) + 1;
}

/** Los feriados que caen dentro del rango, para mostrarlos al que registra. */
export function feriadosEnRango(desde, hasta) {
  const dentro = [];
  let t = Date.parse(desde + 'T00:00:00Z');
  const fin = Date.parse(hasta + 'T00:00:00Z');
  if (!Number.isFinite(t) || !Number.isFinite(fin) || fin - t > 400 * 86400000) return dentro;
  while (t <= fin) {
    const f = desdeUTC(t);
    const g = delAnio(Number(f.slice(0, 4)))[f];
    if (g) dentro.push({ fecha: f, glosa: g });
    t += 86400000;
  }
  return dentro;
}

/**
 * Meses completos entre dos fechas, con la fracción del mes empezado.
 * Es la base del feriado proporcional y de la indemnización por años de
 * servicio, que se cuentan por años y meses, no por días corridos.
 */
export function mesesEntre(desde, hasta) {
  const [a1, m1, d1] = desde.split('-').map(Number);
  const [a2, m2, d2] = hasta.split('-').map(Number);
  let meses = (a2 - a1) * 12 + (m2 - m1);
  if (d2 < d1) meses -= 1;
  return Math.max(0, meses);
}
