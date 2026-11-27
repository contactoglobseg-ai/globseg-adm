/**
 * Planilla de turnos: qué guardia va a qué instalación, cada día, de día o de
 * noche. Se arma arrastrando a los guardias sobre una tabla semanal.
 *
 * Lo pidió la gerencia el 27-11-2026 para tener a la vista dónde está cada
 * uno. Lo abren Joaquín, José, Sebastián y vislaj, con el permiso `planilla`.
 *
 * Tres reglas:
 *
 * 1. **Un guardia no puede estar en dos partes el mismo día y turno.** La
 *    pantalla lo avisa, pero quien lo impide es la base (índice único): dos
 *    personas moviendo la tabla a la vez no pueden dejarlo duplicado. El error
 *    dice dónde quedó.
 * 2. **Esto es lo que se planeó, no lo que pasó.** Lo que pasó son las marcas
 *    del libro de asistencia. No se cruzan: si se confunden, la planilla
 *    termina usándose para probar horas trabajadas, y no sirve para eso.
 * 3. **La instalación de prueba no aparece.** Es interna; tenerla en la tabla
 *    sería una fila vacía que alguien terminaría llenando por error.
 */

import { buscar, primero, insertar, insertarSinDuplicar, actualizar, borrar, anotar } from './datos.js';

export const MIGRACION = '20261127150000_planilla_turnos.sql';

export async function tablaLista(env) {
  try {
    await buscar(env, 'planilla_turnos?select=id&limit=1');
    return true;
  } catch {
    return false;
  }
}

const TURNOS = ['dia', 'noche'];
const NOMBRE_TURNO = { dia: 'día', noche: 'noche' };

/** La fecha de hoy en Chile, no en UTC: a las 22:00 del domingo en Santiago
 *  ya es lunes en Greenwich, y la planilla saltaría de semana antes de tiempo. */
function hoyChile() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
}

const esFecha = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

function sumar(iso, dias) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** El lunes de la semana de esa fecha. */
export function lunesDe(iso) {
  const d = new Date((esFecha(iso) ? iso : hoyChile()) + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;            // lunes = 0
  return sumar(d.toISOString().slice(0, 10), -dow);
}

const esPrueba = (i) => /prueba/i.test(i.nombre || '') || /prueba/i.test(i.clientes?.nombre || '');

/** Todo lo que la pantalla necesita para una semana, en un viaje. */
export async function semana(env, fecha) {
  const lunes = lunesDe(fecha);
  const domingo = sumar(lunes, 6);
  const [instalaciones, guardias, asignaciones] = await Promise.all([
    buscar(env, 'instalaciones?select=id,nombre,comuna,clientes(nombre)&activa=is.true&order=nombre.asc'),
    buscar(env, 'trabajadores?select=id,nombre,rut,instalacion_id&activo=is.true&cargo=eq.guardia&order=nombre.asc'),
    buscar(env, `planilla_turnos?select=id,fecha,turno,instalacion_id,trabajador_id`
      + `&fecha=gte.${lunes}&fecha=lte.${domingo}&order=id.asc`),
  ]);
  return {
    lunes,
    dias: Array.from({ length: 7 }, (_, i) => sumar(lunes, i)),
    hoy: hoyChile(),
    instalaciones: instalaciones.filter((i) => !esPrueba(i)).map((i) => ({
      id: i.id, nombre: i.nombre, comuna: i.comuna, cliente: i.clientes?.nombre || null,
    })),
    guardias,
    asignaciones,
  };
}

/** Lo que se recibe para poner a alguien en una casilla, ya revisado. */
async function casillaValida(env, cuerpo) {
  const fecha = String(cuerpo.fecha || '');
  const turno = String(cuerpo.turno || '');
  const instalacionId = Number(cuerpo.instalacion_id);
  if (!esFecha(fecha)) return { error: 'Falta el día', status: 400 };
  if (!TURNOS.includes(turno)) return { error: 'El turno es de día o de noche', status: 400 };
  if (!Number.isInteger(instalacionId) || instalacionId <= 0) {
    return { error: 'Falta la instalación', status: 400 };
  }
  const inst = await primero(env,
    `instalaciones?select=id,nombre,activa,clientes(nombre)&id=eq.${instalacionId}`);
  if (!inst || !inst.activa || esPrueba(inst)) return { error: 'Esa instalación no está en la planilla', status: 400 };
  return { fecha, turno, inst };
}

/** El mensaje cuando el guardia ya está en otra parte ese día y turno. */
async function dondeEsta(env, trabajadorId, fecha, turno, salvoId) {
  const ya = await primero(env,
    `planilla_turnos?select=id,instalaciones(nombre)&trabajador_id=eq.${trabajadorId}`
    + `&fecha=eq.${fecha}&turno=eq.${turno}${salvoId ? `&id=neq.${salvoId}` : ''}`);
  return ya ? ya.instalaciones?.nombre || 'otra instalación' : null;
}

const fechaCorta = (iso) => {
  const [a, m, d] = iso.split('-');
  return `${d}-${m}-${a}`;
};

/** Poner a un guardia en una casilla. */
export async function asignar(env, quien, cuerpo) {
  const c = await casillaValida(env, cuerpo);
  if (c.error) return c;
  const trabajadorId = Number(cuerpo.trabajador_id);
  const t = Number.isInteger(trabajadorId) && trabajadorId > 0
    ? await primero(env, `trabajadores?select=id,nombre,activo,cargo&id=eq.${trabajadorId}`) : null;
  if (!t || !t.activo) return { error: 'Ese guardia no está activo', status: 400 };

  const ya = await dondeEsta(env, t.id, c.fecha, c.turno);
  if (ya) {
    return { error: `${t.nombre} ya está el ${fechaCorta(c.fecha)} de ${NOMBRE_TURNO[c.turno]} en ${ya}`,
             status: 409 };
  }
  let fila;
  try {
    [fila] = await insertar(env, 'planilla_turnos', {
      fecha: c.fecha, turno: c.turno, instalacion_id: c.inst.id, trabajador_id: t.id, creado_por: quien,
    });
  } catch (e) {
    // Dos personas lo pusieron a la vez: ganó la otra.
    if (e.detalle?.code === '23505') {
      return { error: `${t.nombre} ya quedó en otra instalación ese ${NOMBRE_TURNO[c.turno]}. Recargue la planilla.`,
               status: 409 };
    }
    throw e;
  }
  await anotar(env, quien, 'planilla', fila.id, 'asignó turno',
    `${t.nombre} · ${c.inst.nombre} · ${fechaCorta(c.fecha)} ${NOMBRE_TURNO[c.turno]}`);
  return { asignacion: fila };
}

/** Mover una asignación a otra casilla (arrastrar de una casilla a otra). */
export async function mover(env, quien, id, cuerpo) {
  const a = await primero(env,
    `planilla_turnos?select=*,trabajadores(nombre),instalaciones(nombre)&id=eq.${Number(id)}`);
  if (!a) return { error: 'Esa asignación ya no está. Recargue la planilla.', status: 404 };
  const c = await casillaValida(env, cuerpo);
  if (c.error) return c;
  if (a.fecha === c.fecha && a.turno === c.turno && a.instalacion_id === c.inst.id) {
    return { asignacion: a };
  }
  const ya = await dondeEsta(env, a.trabajador_id, c.fecha, c.turno, a.id);
  if (ya) {
    return { error: `${a.trabajadores?.nombre} ya está el ${fechaCorta(c.fecha)} de ${NOMBRE_TURNO[c.turno]} en ${ya}`,
             status: 409 };
  }
  let fila;
  try {
    [fila] = await actualizar(env, `planilla_turnos?id=eq.${a.id}`,
      { fecha: c.fecha, turno: c.turno, instalacion_id: c.inst.id });
  } catch (e) {
    if (e.detalle?.code === '23505') {
      return { error: 'Ese guardia ya quedó en otra parte en ese turno. Recargue la planilla.', status: 409 };
    }
    throw e;
  }
  await anotar(env, quien, 'planilla', a.id, 'movió turno',
    `${a.trabajadores?.nombre} · de ${a.instalaciones?.nombre} ${fechaCorta(a.fecha)} ${NOMBRE_TURNO[a.turno]}`
    + ` a ${c.inst.nombre} ${fechaCorta(c.fecha)} ${NOMBRE_TURNO[c.turno]}`);
  return { asignacion: fila };
}

/** Sacar a un guardia de una casilla. */
export async function quitar(env, quien, id) {
  const a = await primero(env,
    `planilla_turnos?select=*,trabajadores(nombre),instalaciones(nombre)&id=eq.${Number(id)}`);
  if (!a) return { ok: true };
  await borrar(env, `planilla_turnos?id=eq.${a.id}`);
  await anotar(env, quien, 'planilla', a.id, 'quitó turno',
    `${a.trabajadores?.nombre} · ${a.instalaciones?.nombre} · ${fechaCorta(a.fecha)} ${NOMBRE_TURNO[a.turno]}`);
  return { ok: true };
}

/**
 * Copiar la semana anterior a esta. Agrega lo que falta y no toca lo que ya
 * está; lo que chocaría con algo ya puesto (el mismo guardia en otra parte) se
 * salta y se cuenta, para que la pantalla lo diga.
 */
export async function copiarAnterior(env, quien, fecha) {
  const lunes = lunesDe(fecha);
  const antes = sumar(lunes, -7);
  const [previas, actuales, instalaciones, activos] = await Promise.all([
    buscar(env, `planilla_turnos?select=fecha,turno,instalacion_id,trabajador_id`
      + `&fecha=gte.${antes}&fecha=lte.${sumar(antes, 6)}`),
    buscar(env, `planilla_turnos?select=fecha,turno,instalacion_id,trabajador_id`
      + `&fecha=gte.${lunes}&fecha=lte.${sumar(lunes, 6)}`),
    buscar(env, 'instalaciones?select=id,nombre,clientes(nombre)&activa=is.true'),
    buscar(env, 'trabajadores?select=id&activo=is.true&cargo=eq.guardia'),
  ]);
  if (!previas.length) return { error: 'La semana anterior está vacía: no hay nada que copiar', status: 400 };

  const validas = new Set(instalaciones.filter((i) => !esPrueba(i)).map((i) => i.id));
  const vigentes = new Set(activos.map((t) => t.id));
  const ocupado = new Set(actuales.map((a) => `${a.fecha}|${a.turno}|${a.trabajador_id}`));
  const nuevas = [];
  let saltadas = 0;
  for (const p of previas) {
    const f = sumar(p.fecha, 7);
    const clave = `${f}|${p.turno}|${p.trabajador_id}`;
    if (!validas.has(p.instalacion_id) || !vigentes.has(p.trabajador_id) || ocupado.has(clave)) {
      saltadas++;
      continue;
    }
    ocupado.add(clave);
    nuevas.push({ fecha: f, turno: p.turno, instalacion_id: p.instalacion_id,
                  trabajador_id: p.trabajador_id, creado_por: quien });
  }
  const hechas = nuevas.length
    ? await insertarSinDuplicar(env, 'planilla_turnos', nuevas, 'fecha,turno,trabajador_id')
    : [];
  saltadas += nuevas.length - hechas.length;
  await anotar(env, quien, 'planilla', null, 'copió la semana anterior',
    `semana del ${fechaCorta(lunes)} · ${hechas.length} turnos copiados` + (saltadas ? ` · ${saltadas} saltados` : ''));
  return { copiadas: hechas.length, saltadas };
}
