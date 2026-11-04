/**
 * Rotación de patrullas: a qué dependencia va la patrulla, cada día.
 *
 * La forma del negocio, que el gerente fijó el 04-11-2026: Copec RM no es un
 * parque, es el contrato. Adentro hay cuatro parques —las dependencias—, cada
 * uno con su dirección y su comuna, y una patrulla de dos personas que visita
 * uno por día. El orden lo arma José o Joaquín, semana por semana.
 *
 * Qué manda dónde, que es lo que explica todo lo demás:
 *  · **Se cobra por instalación.** El estado de pago y el F30-1 son de Copec
 *    RM entera. La dependencia no parte la carpeta.
 *  · **El guardia pertenece a la instalación.** Su contrato dice Copec RM; la
 *    dependencia le cambia cada día. Por eso la ficha no se toca.
 *  · **La rotación reparte dependencias**, y es el único lugar del sistema
 *    donde la dependencia manda.
 *
 * Cuatro reglas que explican casi todo el archivo:
 *
 * 1. **Un día, una dependencia.** Lo obliga un índice único de la base, no
 *    este archivo. Acá solo se traduce el error de Postgres a una frase que se
 *    entienda.
 * 2. **Una persona no puede estar en dos partes el mismo día.** Esto sí se
 *    rechaza, y es la única cosa que este módulo se niega a guardar: no es un
 *    hecho que ya ocurrió y hay que anotar, es una planificación imposible, y
 *    descubrirla el martes en la mañana cuesta un turno sin cubrir. El error
 *    dice en qué otra rotación quedó esa persona.
 * 3. **Mandar la patrulla a una dependencia que no está en la rotación se
 *    acepta, con aviso.** Pasa de verdad: un día hay que ir a otro lado.
 *    Negarlo haría que el turno se arme por WhatsApp y no quede escrito.
 * 4. **Esto es lo que se planeó, no lo que pasó.** Lo que pasó son las marcas
 *    del libro de asistencia. Son dos cosas distintas y la pantalla lo dice:
 *    si se confunden, la planilla termina usándose como respaldo de horas
 *    trabajadas, que es justo lo que no puede probar.
 */

import { buscar, insertar, actualizar, borrar, anotar } from './datos.js';
// Los ayudantes de validación viven en rrhh.js y se importan en vez de
// copiarse: una segunda copia se separa de la primera el día que una cambie.
import { limpio, entero, fechaO } from './rrhh.js';

export const MIGRACION = '20261104170000_dependencias.sql';

/** Si la migración no corrió, la pantalla lo dice con el nombre del archivo y
 *  el resto del sistema sigue andando. Nadie las aplica solo desde el 14-10. */
export async function tablasListas(env) {
  try {
    await buscar(env, 'dependencias?select=count&limit=1');
    await buscar(env, 'rotacion_dias?select=dependencia_id&limit=1');
    return true;
  } catch {
    return false;
  }
}

export const avisoMigracion = () =>
  `Falta aplicar la migración ${MIGRACION} en Supabase. El resto del sistema `
  + 'funciona igual.';

// ---------------------------------------------------------------- utilidades
const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

/** La fecha como se lee en Chile. Los mensajes los lee una persona, no un
 *  registro: «2026-11-02» obliga a traducir mentalmente cada vez. */
const comoSeLee = (iso) => String(iso).split('-').reverse().join('-');

/**
 * El lunes de la semana en que cae esa fecha.
 *
 * Va en UTC a propósito: con `new Date('2026-11-09')` interpretado en hora de
 * Chile, el día se corre uno hacia atrás y la semana entera queda desplazada.
 * Es el mismo tropiezo de las fechas de Excel, una pantalla más adelante.
 */
export function lunesDe(iso) {
  const [a, m, d] = String(iso).split('-').map(Number);
  const t = Date.UTC(a, m - 1, d);
  const diaSemana = (new Date(t).getUTCDay() + 6) % 7; // lunes = 0
  return new Date(t - diaSemana * 86400000).toISOString().slice(0, 10);
}

/** Los siete días de esa semana, de lunes a domingo. El domingo entra: en esta
 *  rotación también hay turno. */
export function diasDeLaSemana(lunes) {
  const [a, m, d] = lunes.split('-').map(Number);
  const base = Date.UTC(a, m - 1, d);
  return Array.from({ length: 7 }, (_, i) =>
    new Date(base + i * 86400000).toISOString().slice(0, 10));
}

// -------------------------------------------------------------- dependencias
/**
 * Las dependencias de una instalación, o todas.
 *
 * Es el catálogo que alimenta la rotación, y se mantiene desde la pestaña
 * Instalaciones: ahí ya está el lugar del que cuelgan, y una pantalla más
 * sería una pantalla que hay que acordarse de visitar.
 */
export async function listarDependencias(env, instalacionId) {
  const filtro = instalacionId ? `&instalacion_id=eq.${entero(instalacionId)}` : '';
  return buscar(env, `v_dependencias?select=*${filtro}&order=instalacion.asc,nombre.asc`);
}

export async function crearDependencia(env, quien, cuerpo) {
  const instalacion_id = entero(cuerpo.instalacion_id);
  if (!instalacion_id) return { error: 'Falta decir de qué instalación es.', status: 400 };
  const nombre = limpio(cuerpo.nombre, 120);
  if (!nombre) return { error: 'La dependencia necesita un nombre.', status: 400 };

  const campos = {
    instalacion_id, nombre,
    direccion: limpio(cuerpo.direccion, 200),
    comuna: limpio(cuerpo.comuna, 80),
    region: limpio(cuerpo.region, 80),
    notas: limpio(cuerpo.notas, 300),
    creado_por: quien,
  };
  try {
    const [fila] = await insertar(env, 'dependencias', campos);
    await anotar(env, quien, 'dependencia', fila.id, 'creada', nombre);
    return { dependencia: fila };
  } catch (e) {
    if (String(e.message || e).includes('dependencias_nombre_unico')) {
      return { error: `Esa instalación ya tiene una dependencia llamada «${nombre}».`,
               status: 400 };
    }
    throw e;
  }
}

export async function editarDependencia(env, quien, id, cuerpo) {
  const campos = {};
  if ('nombre' in cuerpo) {
    const nombre = limpio(cuerpo.nombre, 120);
    if (!nombre) return { error: 'La dependencia necesita un nombre.', status: 400 };
    campos.nombre = nombre;
  }
  for (const c of ['direccion', 'comuna', 'region', 'notas']) {
    if (c in cuerpo) campos[c] = limpio(cuerpo[c], c === 'notas' ? 300 : 200);
  }
  if ('activa' in cuerpo) campos.activa = cuerpo.activa === true || cuerpo.activa === 'true';
  if (!Object.keys(campos).length) return { ok: true, sin_cambios: true };

  try {
    await actualizar(env, `dependencias?id=eq.${id}`, campos);
  } catch (e) {
    if (String(e.message || e).includes('dependencias_nombre_unico')) {
      return { error: `Esa instalación ya tiene una dependencia llamada «${campos.nombre}».`,
               status: 400 };
    }
    throw e;
  }
  await anotar(env, quien, 'dependencia', Number(id), 'editada', Object.keys(campos).join(', '));
  return { ok: true };
}

// --------------------------------------------------------------- rotaciones
/**
 * Las rotaciones con su instalación y sus dependencias.
 *
 * Se pegan con consultas aparte y no con un `embed` de PostgREST: son unas
 * pocas filas, no se nota, y así no hay una sintaxis que solo se pueda probar
 * contra la base de verdad. Mismo criterio que `panel()`.
 */
export async function listarRotaciones(env) {
  const [rotaciones, puntos, dependencias, instalaciones] = await Promise.all([
    buscar(env, 'rotaciones?select=*&order=activa.desc,nombre.asc'),
    buscar(env, 'rotacion_puntos?select=rotacion_id,dependencia_id'),
    buscar(env, 'v_dependencias?select=*&order=nombre.asc'),
    buscar(env, 'instalaciones?select=id,nombre,comuna,activa&order=nombre.asc'),
  ]);
  const porId = new Map(dependencias.map(d => [d.id, d]));
  const nombreInst = new Map(instalaciones.map(i => [i.id, i.nombre]));
  for (const r of rotaciones) {
    r.instalacion = nombreInst.get(r.instalacion_id) || null;
    r.dependencias = puntos
      .filter(p => p.rotacion_id === r.id)
      .map(p => porId.get(p.dependencia_id))
      .filter(Boolean);
  }
  return { rotaciones, dependencias, instalaciones };
}

async function guardarPuntos(env, rotacionId, ids) {
  await borrar(env, `rotacion_puntos?rotacion_id=eq.${rotacionId}`);
  if (ids.length) {
    await insertar(env, 'rotacion_puntos',
      ids.map(dependencia_id => ({ rotacion_id: rotacionId, dependencia_id })));
  }
}

/** Las dependencias que vienen de la pantalla, sin repetidos y como números. */
function idsDePuntos(cuerpo) {
  if (!Array.isArray(cuerpo.dependencias)) return null;
  return [...new Set(cuerpo.dependencias.map(entero).filter(Boolean))];
}

/**
 * Las dependencias elegidas tienen que ser de la instalación de la rotación.
 * Acá sí se rechaza, al revés que en la planilla del día: armar la rotación
 * con una dependencia de otro contrato no es «un día hay que ir a otro lado»,
 * es un error de carga que después reparte gente todas las semanas.
 */
async function sonDeLaInstalacion(env, instalacionId, ids) {
  if (!ids.length) return null;
  const deps = await buscar(env,
    `dependencias?select=id,nombre,instalacion_id&id=in.(${ids.join(',')})`);
  const perdidas = ids.filter(id => !deps.some(d => d.id === id));
  if (perdidas.length) {
    return 'Quedó elegida una dependencia que ya no existe. Vuelva a cargar la pantalla.';
  }
  const ajenas = deps.filter(d => d.instalacion_id !== instalacionId);
  if (ajenas.length) {
    return `${ajenas.map(d => d.nombre).join(', ')} no ${ajenas.length === 1 ? 'es' : 'son'} `
         + 'de esta instalación. Una rotación reparte las dependencias de una sola.';
  }
  return null;
}

export async function crearRotacion(env, quien, cuerpo) {
  const nombre = limpio(cuerpo.nombre, 120);
  if (!nombre) return { error: 'La rotación necesita un nombre.', status: 400 };
  const instalacion_id = entero(cuerpo.instalacion_id);
  if (!instalacion_id) {
    return { error: 'Falta decir de qué instalación es la rotación.', status: 400 };
  }

  const puntos = idsDePuntos(cuerpo) || [];
  const malas = await sonDeLaInstalacion(env, instalacion_id, puntos);
  if (malas) return { error: malas, status: 400 };

  let fila;
  try {
    [fila] = await insertar(env, 'rotaciones',
      { nombre, instalacion_id, notas: limpio(cuerpo.notas, 500), creado_por: quien });
  } catch (e) {
    if (String(e.message || e).includes('rotaciones_nombre_unico')) {
      return { error: `Ya hay una rotación que se llama «${nombre}».`, status: 400 };
    }
    throw e;
  }
  if (puntos.length) await guardarPuntos(env, fila.id, puntos);
  await anotar(env, quien, 'rotacion', fila.id, 'creada', nombre);
  return { rotacion: fila };
}

export async function editarRotacion(env, quien, id, cuerpo) {
  const actual = (await buscar(env, `rotaciones?select=*&id=eq.${id}`))[0];
  if (!actual) return { error: 'Esa rotación no existe.', status: 404 };

  const campos = {};
  if ('nombre' in cuerpo) {
    const nombre = limpio(cuerpo.nombre, 120);
    if (!nombre) return { error: 'La rotación necesita un nombre.', status: 400 };
    campos.nombre = nombre;
  }
  if ('notas' in cuerpo) campos.notas = limpio(cuerpo.notas, 500);
  if ('activa' in cuerpo) campos.activa = cuerpo.activa === true || cuerpo.activa === 'true';
  if ('instalacion_id' in cuerpo) {
    const i = entero(cuerpo.instalacion_id);
    if (!i) return { error: 'Falta decir de qué instalación es la rotación.', status: 400 };
    campos.instalacion_id = i;
  }
  const instalacion = campos.instalacion_id || actual.instalacion_id;

  const puntos = idsDePuntos(cuerpo);
  if (puntos) {
    const malas = await sonDeLaInstalacion(env, instalacion, puntos);
    if (malas) return { error: malas, status: 400 };
  }

  if (Object.keys(campos).length) {
    try {
      await actualizar(env, `rotaciones?id=eq.${id}`, campos);
    } catch (e) {
      if (String(e.message || e).includes('rotaciones_nombre_unico')) {
        return { error: `Ya hay una rotación que se llama «${campos.nombre}».`, status: 400 };
      }
      throw e;
    }
  }
  if (puntos) await guardarPuntos(env, id, puntos);
  await anotar(env, quien, 'rotacion', Number(id), 'editada',
    Object.keys(campos).concat(puntos ? ['dependencias'] : []).join(', ') || 'sin cambios');
  return { ok: true };
}

// ----------------------------------------------------------------- la semana
/**
 * La semana de una rotación: siempre siete días, estén escritos o no.
 *
 * Devuelve los siete aunque la base tenga tres: una pantalla que solo muestra
 * lo guardado deja al jueves invisible, y lo que hay que ver de un vistazo es
 * justamente el día que falta por llenar.
 */
export async function verSemana(env, rotacionId, fecha) {
  const lunes = lunesDe(fecha || new Date().toISOString().slice(0, 10));
  const dias = diasDeLaSemana(lunes);
  const rotacion = (await buscar(env, `rotaciones?select=*&id=eq.${rotacionId}`))[0];
  if (!rotacion) return { error: 'Esa rotación no existe.', status: 404 };

  const [guardados, guardias, dependencias] = await Promise.all([
    buscar(env, `v_rotacion_dias?rotacion_id=eq.${rotacionId}`
      + `&fecha=gte.${dias[0]}&fecha=lte.${dias[6]}&order=fecha.asc`),
    buscar(env, 'trabajadores?select=id,nombre,cargo,instalacion_id'
      + '&activo=is.true&order=nombre.asc'),
    // Las de la instalación, para poder mandar la patrulla a otra del mismo
    // contrato sin tener que editar la rotación entera.
    rotacion.instalacion_id
      ? buscar(env, 'dependencias?select=id,nombre,activa'
        + `&instalacion_id=eq.${rotacion.instalacion_id}&order=nombre.asc`)
      : Promise.resolve([]),
  ]);

  const porFecha = new Map(guardados.map(d => [d.fecha, d]));
  return {
    rotacion,
    lunes,
    guardias,
    dependencias,
    dias: dias.map((fecha, i) => ({
      fecha,
      dia: DIAS[i],
      ...(porFecha.get(fecha) || {
        dependencia_id: null, guardia_1_id: null, guardia_2_id: null, notas: null,
      }),
    })),
  };
}

/**
 * Guarda la semana completa de una pasada.
 *
 * Es una llamada y no siete porque la semana se arma mirándola entera: con una
 * por día, la mitad de los choques entre dependencias se descubren recién al
 * guardar el último. Acá se revisan todos antes de escribir ninguno.
 */
export async function guardarSemana(env, quien, rotacionId, cuerpo) {
  const entrantes = Array.isArray(cuerpo.dias) ? cuerpo.dias : [];
  if (!entrantes.length) return { error: 'No llegó ningún día que guardar.', status: 400 };

  const rotacion = (await buscar(env, `rotaciones?select=*&id=eq.${rotacionId}`))[0];
  if (!rotacion) return { error: 'Esa rotación no existe.', status: 404 };

  // --- lo que se va a escribir, ya limpio
  const filas = [];
  for (const d of entrantes) {
    const fecha = fechaO(d.fecha);
    if (!fecha) return { error: `Hay un día con la fecha mal escrita: «${d.fecha}».`, status: 400 };
    const g1 = entero(d.guardia_1_id);
    const g2 = entero(d.guardia_2_id);
    if (g1 && g2 && g1 === g2) {
      return { error: `El ${comoSeLee(fecha)} quedó la misma persona en los dos `
                    + 'puestos de la patrulla. Una patrulla son dos.', status: 400 };
    }
    filas.push({
      rotacion_id: Number(rotacionId),
      fecha,
      dependencia_id: entero(d.dependencia_id),
      guardia_1_id: g1,
      guardia_2_id: g2,
      notas: limpio(d.notas, 300),
      creado_por: quien,
      actualizado_en: new Date().toISOString(),
    });
  }

  const avisos = [];
  const fechas = filas.map(f => f.fecha);

  // Las tres revisiones son lecturas y van juntas: en fila son tres viajes más
  // a la base, y esto se guarda con la semana entera en pantalla esperando.
  const [choque, faltaDep, faltaGuardia] = await Promise.all([
    choquesDeGuardias(env, Number(rotacionId), filas),
    revisarDependencias(env, rotacion, filas, avisos),
    revisarGuardias(env, filas, avisos),
  ]);
  // El choque va primero aunque lleguen los tres: es el que cuenta, y el que
  // la persona tiene que leer para arreglar la semana.
  const noVa = choque || faltaDep || faltaGuardia;
  if (noVa) return { error: noVa, status: 400 };

  // Se borra y se vuelve a escribir la semana: un upsert por `on_conflict`
  // pediría mandar todas las columnas de todas formas, y así el día que quedó
  // libre —sin dependencia y sin nadie— se guarda como libre en vez de quedar
  // con lo de la semana pasada.
  await borrar(env, `rotacion_dias?rotacion_id=eq.${rotacionId}`
    + `&fecha=in.(${fechas.join(',')})`);
  try {
    await insertar(env, 'rotacion_dias', filas);
  } catch (e) {
    if (String(e.message || e).includes('rotacion_dias_unico')) {
      return { error: 'Llegaron dos veces el mismo día. En esta rotación hay una '
                    + 'dependencia por día.', status: 400 };
    }
    throw e;
  }

  await anotar(env, quien, 'rotacion', Number(rotacionId), 'semana guardada',
    `${fechas[0]} a ${fechas[fechas.length - 1]}, ${filas.length} día(s)`);
  return { ok: true, guardados: filas.length, avisos };
}

/**
 * Una persona no puede estar en dos partes el mismo día. Se mira contra las
 * otras rotaciones, no contra ésta: adentro de ésta ya hay una por día.
 */
async function choquesDeGuardias(env, rotacionId, filas) {
  const porFecha = new Map();
  for (const f of filas) {
    const suyos = [f.guardia_1_id, f.guardia_2_id].filter(Boolean);
    if (suyos.length) porFecha.set(f.fecha, suyos);
  }
  if (!porFecha.size) return null;

  const fechas = [...porFecha.keys()];
  const otros = await buscar(env, 'v_rotacion_dias?select=fecha,rotacion,guardia_1_id,'
    + `guardia_2_id,guardia_1,guardia_2&fecha=in.(${fechas.join(',')})`
    + `&rotacion_id=neq.${rotacionId}`);

  for (const o of otros) {
    const suyos = porFecha.get(o.fecha) || [];
    for (const id of suyos) {
      if (o.guardia_1_id === id || o.guardia_2_id === id) {
        const nombre = o.guardia_1_id === id ? o.guardia_1 : o.guardia_2;
        return `${nombre} ya está en la rotación «${o.rotacion}» el ${comoSeLee(o.fecha)}. `
             + 'Una persona no puede estar en dos partes el mismo día.';
      }
    }
  }
  return null;
}

/**
 * La dependencia que no está en la rotación se acepta: se avisa y se guarda,
 * porque un día hay que ir a otro lado. La que no existe, o la que es de otra
 * instalación, se rechaza acá y no cuatro líneas más abajo con el error de la
 * llave foránea escrito en inglés dentro de la pantalla.
 */
async function revisarDependencias(env, rotacion, filas, avisos) {
  const usadas = [...new Set(filas.map(f => f.dependencia_id).filter(Boolean))];
  if (!usadas.length) return null;
  const [puntos, deps] = await Promise.all([
    buscar(env, `rotacion_puntos?select=dependencia_id&rotacion_id=eq.${rotacion.id}`),
    buscar(env, `dependencias?select=id,nombre,activa,instalacion_id&id=in.(${usadas.join(',')})`),
  ]);
  const perdidas = usadas.filter(id => !deps.some(d => d.id === id));
  if (perdidas.length) {
    return 'Quedó elegida una dependencia que ya no existe. Vuelva a cargar la pantalla.';
  }
  const ajenas = deps.filter(d => d.instalacion_id !== rotacion.instalacion_id);
  if (ajenas.length) {
    return `${ajenas.map(d => d.nombre).join(', ')} no es de la instalación de esta `
         + 'rotación. Si la patrulla de verdad va para allá, va con otra rotación.';
  }

  const dentro = new Set(puntos.map(p => p.dependencia_id));
  for (const d of deps) {
    if (!dentro.has(d.id)) {
      avisos.push(`${d.nombre} no está en la lista de dependencias de esta rotación. `
                + 'Se guardó igual.');
    }
    if (!d.activa) avisos.push(`${d.nombre} está dada de baja. Se guardó igual.`);
  }
  return null;
}

/**
 * Quien ya no trabaja acá se avisa, no se rechaza: la baja puede ser de ayer y
 * la planilla puede estar corrigiéndose. Quien no existe sí se rechaza —es una
 * pantalla vieja o un id inventado— y se dice con palabras.
 */
async function revisarGuardias(env, filas, avisos) {
  const ids = [...new Set(filas.flatMap(f => [f.guardia_1_id, f.guardia_2_id]).filter(Boolean))];
  if (!ids.length) return null;
  const gente = await buscar(env, `trabajadores?select=id,nombre,activo&id=in.(${ids.join(',')})`);
  const faltan = ids.filter(id => !gente.some(g => g.id === id));
  if (faltan.length) {
    return `Quedó asignada una persona que no está en la lista de trabajadores `
         + `(N° ${faltan.join(', ')}). Vuelva a cargar la pantalla.`;
  }
  for (const g of gente) {
    if (!g.activo) avisos.push(`${g.nombre} está de baja en el sistema. Se guardó igual.`);
  }
  return null;
}
