/**
 * Tareas entre el equipo de la oficina (22-11-2026).
 *
 * Pedido del gerente: que cada uno pueda pedirle una tarea a otro del equipo y
 * que le aparezca arriba, en el Inicio, como un ticket.
 *
 * Reglas que se niega a saltarse:
 *  - Una tarea **no se borra**. Se termina, se rechaza o se cancela, y lo que
 *    pasó queda a la vista de quien la pidió y de quien la recibió.
 *  - **Quien la recibe** la mueve (empezar, terminar, rechazar, devolver a
 *    pendiente). **Quien la pidió** solo la cancela o la corrige mientras siga
 *    abierta. Nadie más la toca: no es una bandeja compartida, es un encargo
 *    de una persona a otra.
 *  - **Rechazar pide motivo.** Un «no» sin explicación vuelve como otra
 *    pregunta por WhatsApp, que es justo lo que esto viene a ordenar.
 *  - Se le puede pedir una tarea **solo a una cuenta activa** de la oficina.
 *    Los guardias no tienen fila en `usuarios` y quedan afuera.
 *
 * No manda correos. Lo que avisa es el Inicio, que es la primera pantalla que
 * ve todo el que entra al panel.
 */

import { buscar, primero, insertar, actualizar, anotar } from './datos.js';
import { esFecha } from './fechas.js';

export const MIGRACION = '20261122120000_tareas.sql';

export const PRIORIDADES = ['normal', 'alta', 'urgente'];
export const ESTADOS = ['pendiente', 'en_curso', 'hecha', 'rechazada', 'cancelada'];
const ABIERTAS = ['pendiente', 'en_curso'];

/** Cuánto tiempo se siguen mostrando las cerradas: lo justo para que quien
 *  pidió vea que se hizo, sin que el Inicio se vuelva un archivo. */
const DIAS_CERRADAS = 14;

// -------------------------------------------------------------- utilidades
const linea = (v, max) => {
  const t = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return t ? t.slice(0, max) : null;
};

/** El detalle conserva los saltos de línea: es donde se escribe una lista de
 *  pasos o un listado de nombres, y aplanarlo lo deja ilegible. */
const parrafo = (v, max) => {
  const t = typeof v === 'string'
    ? v.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : '';
  return t ? t.slice(0, max) : null;
};

const entero = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function tablasListas(env) {
  try {
    await buscar(env, 'tareas?select=id&limit=1');
    return true;
  } catch {
    return false;
  }
}

export const avisoMigracion = () =>
  `Falta aplicar la migración ${MIGRACION} en Supabase. Mientras tanto no se `
  + 'pueden pedir tareas; el resto del sistema funciona igual.';

/** Las cuentas a las que se les puede pedir algo: la oficina activa. */
async function equipo(env) {
  const filas = await buscar(env,
    'usuarios?select=usuario,nombre,rol&activo=is.true&usuario=not.is.null&order=nombre.asc');
  return filas.map((u) => ({ usuario: u.usuario, nombre: u.nombre || u.usuario, rol: u.rol }));
}

const nombreDe = (lista, usuario) =>
  (lista.find((u) => u.usuario === usuario) || {}).nombre || usuario;

/** Primero lo urgente y lo que vence antes; lo sin fecha al final. */
const PESO = { urgente: 0, alta: 1, normal: 2 };
function ordenar(a, b) {
  const ab = ABIERTAS.includes(a.estado) ? 0 : 1;
  const bb = ABIERTAS.includes(b.estado) ? 0 : 1;
  if (ab !== bb) return ab - bb;
  if (ab === 1) return String(b.cerrado_en || '').localeCompare(String(a.cerrado_en || ''));
  if (PESO[a.prioridad] !== PESO[b.prioridad]) return PESO[a.prioridad] - PESO[b.prioridad];
  if (a.vence !== b.vence) {
    if (!a.vence) return 1;
    if (!b.vence) return -1;
    return a.vence.localeCompare(b.vence);
  }
  return String(a.creado_en).localeCompare(String(b.creado_en));
}

// ------------------------------------------------------------------ leer
/**
 * Lo que ve una persona en su Inicio: lo que le pidieron, lo que pidió ella,
 * y la lista del equipo para pedir algo nuevo.
 */
export async function listar(env, usuario) {
  const yo = encodeURIComponent(usuario.usuario);
  // Solo el día: un instante completo trae puntos y dos puntos, y dentro de un
  // `or=(...)` de PostgREST conviene no darle nada que tenga que adivinar.
  const desde = new Date(Date.now() - DIAS_CERRADAS * 86400000).toISOString().slice(0, 10);
  const filtro = `or=(estado.in.(${ABIERTAS.join(',')}),cerrado_en.gte.${desde})`;
  const [recibidas, enviadas, gente] = await Promise.all([
    buscar(env, `tareas?select=*&para_usuario=eq.${yo}&${filtro}&order=creado_en.desc&limit=200`),
    buscar(env, `tareas?select=*&de_usuario=eq.${yo}&para_usuario=neq.${yo}&${filtro}`
      + '&order=creado_en.desc&limit=200'),
    equipo(env),
  ]);
  const conNombres = (t) => ({
    ...t,
    de_nombre: nombreDe(gente, t.de_usuario),
    para_nombre: nombreDe(gente, t.para_usuario),
  });
  return {
    recibidas: recibidas.map(conNombres).sort(ordenar),
    enviadas: enviadas.map(conNombres).sort(ordenar),
    equipo: gente,
    prioridades: PRIORIDADES,
  };
}

// ----------------------------------------------------------------- crear
export async function crear(env, usuario, cuerpo) {
  const titulo = linea(cuerpo.titulo, 160);
  if (!titulo) return { error: 'Escriba qué hay que hacer', status: 400 };

  const para = linea(cuerpo.para, 60);
  if (!para) return { error: 'Elija a quién se la pide', status: 400 };
  const gente = await equipo(env);
  const destino = gente.find((u) => u.usuario === para);
  if (!destino) {
    return { error: 'Esa persona no tiene una cuenta activa en la oficina', status: 400 };
  }

  const prioridad = cuerpo.prioridad || 'normal';
  if (!PRIORIDADES.includes(prioridad)) {
    return { error: 'La prioridad tiene que ser normal, alta o urgente', status: 400 };
  }

  let vence = null;
  if (cuerpo.vence) {
    if (!esFecha(cuerpo.vence)) return { error: 'La fecha límite no es válida', status: 400 };
    vence = cuerpo.vence;
  }

  const [fila] = await insertar(env, 'tareas', {
    titulo,
    detalle: parrafo(cuerpo.detalle, 4000),
    de_usuario: usuario.usuario,
    para_usuario: destino.usuario,
    prioridad,
    vence,
  });
  await anotar(env, usuario.usuario, 'tarea', fila.id, 'pidió una tarea',
    `«${titulo}» a ${destino.nombre}${vence ? ` · para el ${vence}` : ''}`
    + (prioridad !== 'normal' ? ` · ${prioridad}` : ''));
  return { ok: true, tarea: { ...fila, de_nombre: usuario.nombre, para_nombre: destino.nombre } };
}

// ---------------------------------------------------------------- cambiar
/**
 * Mueve una tarea. Quién puede hacer qué:
 *   quien la recibe:  pendiente ↔ en_curso → hecha | rechazada (con motivo)
 *   quien la pidió:   cancelada, o corregir título/detalle/fecha/prioridad
 *                     mientras siga abierta.
 * Una tarea cerrada no se reabre desde acá: si hace falta otra vez, se pide
 * otra, y las dos quedan.
 */
export async function cambiar(env, usuario, id, cuerpo) {
  const t = await primero(env, `tareas?select=*&id=eq.${entero(id) || 0}`);
  if (!t) return { error: 'Esa tarea no existe', status: 404 };

  const soyQuienRecibe = t.para_usuario === usuario.usuario;
  const soyQuienPide = t.de_usuario === usuario.usuario;
  if (!soyQuienRecibe && !soyQuienPide) {
    return { error: 'Esa tarea no es suya ni la pidió usted', status: 403 };
  }
  if (!ABIERTAS.includes(t.estado)) {
    return { error: 'Esa tarea ya está cerrada. Si hace falta otra vez, pida una nueva.',
             status: 409 };
  }

  const ahora = new Date().toISOString();
  const campos = { actualizado_en: ahora };
  let accion;

  if (cuerpo.estado !== undefined) {
    const nuevo = cuerpo.estado;
    if (!ESTADOS.includes(nuevo)) return { error: 'Ese estado no existe', status: 400 };
    if (nuevo === t.estado) return { ok: true, tarea: t, sin_cambios: true };

    if (nuevo === 'cancelada') {
      if (!soyQuienPide) {
        return { error: 'La cancela quien la pidió. Si no la puede hacer, recházela con el motivo.',
                 status: 403 };
      }
      accion = 'canceló una tarea';
    } else {
      if (!soyQuienRecibe) {
        return { error: 'La mueve la persona a quien se le pidió', status: 403 };
      }
      if (nuevo === 'rechazada' && !linea(cuerpo.respuesta, 10)) {
        return { error: 'Escriba por qué la rechaza: quien la pidió necesita saberlo',
                 status: 400 };
      }
      accion = { pendiente: 'devolvió a pendiente una tarea', en_curso: 'empezó una tarea',
                 hecha: 'terminó una tarea', rechazada: 'rechazó una tarea' }[nuevo];
    }
    campos.estado = nuevo;
    if (!ABIERTAS.includes(nuevo)) campos.cerrado_en = ahora;
    const resp = parrafo(cuerpo.respuesta, 2000);
    if (resp) campos.respuesta = resp;
  } else {
    // Corregir lo que se pidió. Solo quien la pidió.
    if (!soyQuienPide) return { error: 'La corrige quien la pidió', status: 403 };
    if ('titulo' in cuerpo) {
      const titulo = linea(cuerpo.titulo, 160);
      if (!titulo) return { error: 'El título no puede quedar vacío', status: 400 };
      campos.titulo = titulo;
    }
    if ('detalle' in cuerpo) campos.detalle = parrafo(cuerpo.detalle, 4000);
    if ('vence' in cuerpo) {
      if (cuerpo.vence && !esFecha(cuerpo.vence)) {
        return { error: 'La fecha límite no es válida', status: 400 };
      }
      campos.vence = cuerpo.vence || null;
    }
    if ('prioridad' in cuerpo) {
      if (!PRIORIDADES.includes(cuerpo.prioridad)) {
        return { error: 'La prioridad tiene que ser normal, alta o urgente', status: 400 };
      }
      campos.prioridad = cuerpo.prioridad;
    }
    if (Object.keys(campos).length === 1) return { ok: true, tarea: t, sin_cambios: true };
    accion = 'corrigió una tarea';
  }

  const [fila] = await actualizar(env, `tareas?id=eq.${t.id}`, campos);
  await anotar(env, usuario.usuario, 'tarea', t.id, accion,
    `«${t.titulo}»${campos.respuesta ? ` · ${campos.respuesta.slice(0, 200)}` : ''}`);
  return { ok: true, tarea: fila || { ...t, ...campos } };
}
