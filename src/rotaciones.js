/**
 * Rotación de patrullas: a qué parque va cada patrulla, cada día.
 *
 * En Copec RM hay cuatro parques y una patrulla de dos personas que visita uno
 * por día. El orden lo arma la oficina —José o Joaquín— semana por semana, y
 * lo que el gerente pidió cuidar es que no sea siempre el mismo: un recorrido
 * que se sabe de memoria es un recorrido que se puede esperar.
 *
 * Cuatro reglas que explican casi todo el archivo:
 *
 * 1. **Un día, un parque.** Lo obliga un índice único de la base, no este
 *    archivo. Acá solo se traduce el error de Postgres a una frase que se
 *    entienda.
 * 2. **Una persona no puede estar en dos parques el mismo día.** Esto sí se
 *    rechaza, y es la única cosa que este módulo se niega a guardar: no es un
 *    hecho que ya ocurrió y hay que anotar, es una planificación imposible, y
 *    descubrirla el martes en la mañana cuesta un turno sin cubrir. El error
 *    dice en qué otra rotación quedó esa persona.
 * 3. **Mandar la patrulla a un parque que no es de la rotación se acepta, con
 *    aviso.** Pasa de verdad: un día hay que ir a otro lado. Negarlo haría que
 *    el turno se arme por WhatsApp y no quede escrito en ninguna parte.
 * 4. **Esto es lo que se planeó, no lo que pasó.** Lo que pasó son las marcas
 *    del libro de asistencia. Son dos cosas distintas y la pantalla lo dice:
 *    si se confunden, la planilla termina usándose como respaldo de horas
 *    trabajadas, que es justo lo que no puede probar.
 */

import { buscar, insertar, actualizar, borrar, anotar } from './datos.js';
// Los ayudantes de validación viven en rrhh.js y se importan en vez de
// copiarse: una segunda copia se separa de la primera el día que una cambie.
import { limpio, entero, fechaO } from './rrhh.js';

export const MIGRACION = '20261104120000_rotaciones.sql';

/** Si la migración no corrió, la pantalla lo dice con el nombre del archivo y
 *  el resto del sistema sigue andando. Nadie las aplica solo desde el 14-10. */
export async function tablasListas(env) {
  try {
    await buscar(env, 'rotaciones?select=count&limit=1');
    await buscar(env, 'rotacion_dias?select=count&limit=1');
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

// --------------------------------------------------------------- rotaciones
/**
 * Las rotaciones con sus parques.
 *
 * Los parques se pegan con una segunda consulta y no con un `embed` de
 * PostgREST: son unas pocas filas, no se nota, y así no hay una sintaxis que
 * solo se pueda probar contra la base de verdad. Mismo criterio que `panel()`.
 */
export async function listarRotaciones(env) {
  const [rotaciones, puntos, instalaciones] = await Promise.all([
    buscar(env, 'rotaciones?select=*&order=activa.desc,nombre.asc'),
    buscar(env, 'rotacion_puntos?select=rotacion_id,instalacion_id'),
    buscar(env, 'instalaciones?select=id,nombre,comuna,activa&order=nombre.asc'),
  ]);
  const porId = new Map(instalaciones.map(i => [i.id, i]));
  for (const r of rotaciones) {
    r.parques = puntos
      .filter(p => p.rotacion_id === r.id)
      .map(p => porId.get(p.instalacion_id))
      .filter(Boolean);
  }
  return { rotaciones, instalaciones };
}

async function guardarParques(env, rotacionId, ids) {
  await borrar(env, `rotacion_puntos?rotacion_id=eq.${rotacionId}`);
  if (ids.length) {
    await insertar(env, 'rotacion_puntos',
      ids.map(instalacion_id => ({ rotacion_id: rotacionId, instalacion_id })));
  }
}

/** Los parques que vienen de la pantalla, sin repetidos y como números. */
function idsDeParques(cuerpo) {
  if (!Array.isArray(cuerpo.parques)) return null;
  return [...new Set(cuerpo.parques.map(entero).filter(Boolean))];
}

export async function crearRotacion(env, quien, cuerpo) {
  const nombre = limpio(cuerpo.nombre, 120);
  if (!nombre) return { error: 'La rotación necesita un nombre.', status: 400 };

  let fila;
  try {
    [fila] = await insertar(env, 'rotaciones',
      { nombre, notas: limpio(cuerpo.notas, 500), creado_por: quien });
  } catch (e) {
    if (String(e.message || e).includes('rotaciones_nombre_unico')) {
      return { error: `Ya hay una rotación que se llama «${nombre}».`, status: 400 };
    }
    throw e;
  }
  const parques = idsDeParques(cuerpo);
  if (parques?.length) await guardarParques(env, fila.id, parques);
  await anotar(env, quien, 'rotacion', fila.id, 'creada', nombre);
  return { rotacion: fila };
}

export async function editarRotacion(env, quien, id, cuerpo) {
  const campos = {};
  if ('nombre' in cuerpo) {
    const nombre = limpio(cuerpo.nombre, 120);
    if (!nombre) return { error: 'La rotación necesita un nombre.', status: 400 };
    campos.nombre = nombre;
  }
  if ('notas' in cuerpo) campos.notas = limpio(cuerpo.notas, 500);
  if ('activa' in cuerpo) campos.activa = cuerpo.activa === true || cuerpo.activa === 'true';

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
  const parques = idsDeParques(cuerpo);
  if (parques) await guardarParques(env, id, parques);
  await anotar(env, quien, 'rotacion', id, 'editada',
    Object.keys(campos).concat(parques ? ['parques'] : []).join(', ') || 'sin cambios');
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
  const [rotacion, guardados, guardias] = await Promise.all([
    buscar(env, `rotaciones?select=*&id=eq.${rotacionId}`).then(f => f[0] || null),
    buscar(env, `v_rotacion_dias?rotacion_id=eq.${rotacionId}`
      + `&fecha=gte.${dias[0]}&fecha=lte.${dias[6]}&order=fecha.asc`),
    buscar(env, 'trabajadores?select=id,nombre,cargo,instalacion_id'
      + '&activo=is.true&order=nombre.asc'),
  ]);
  if (!rotacion) return { error: 'Esa rotación no existe.', status: 404 };

  const porFecha = new Map(guardados.map(d => [d.fecha, d]));
  return {
    rotacion,
    lunes,
    guardias,
    dias: dias.map((fecha, i) => ({
      fecha,
      dia: DIAS[i],
      ...(porFecha.get(fecha) || {
        instalacion_id: null, guardia_1_id: null, guardia_2_id: null, notas: null,
      }),
    })),
  };
}

/**
 * Guarda la semana completa de una pasada.
 *
 * Es una llamada y no siete porque la semana se arma mirándola entera: con una
 * por día, la mitad de los choques entre parques se descubren recién al guardar
 * el último. Acá se revisan todos antes de escribir ninguno.
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
      instalacion_id: entero(d.instalacion_id),
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
  const [choque, faltaParque, faltaGuardia] = await Promise.all([
    choquesDeGuardias(env, Number(rotacionId), filas),
    revisarParques(env, Number(rotacionId), filas, avisos),
    revisarGuardias(env, filas, avisos),
  ]);
  // El choque va primero aunque lleguen los tres: es el que cuenta, y el que
  // la persona tiene que leer para arreglar la semana.
  const noVa = choque || faltaParque || faltaGuardia;
  if (noVa) return { error: noVa, status: 400 };

  // Se borra y se vuelve a escribir la semana: un upsert por `on_conflict`
  // pediría mandar todas las columnas de todas formas, y así el día que quedó
  // libre —sin parque y sin nadie— se guarda como libre en vez de quedar con
  // lo de la semana pasada.
  await borrar(env, `rotacion_dias?rotacion_id=eq.${rotacionId}`
    + `&fecha=in.(${fechas.join(',')})`);
  try {
    await insertar(env, 'rotacion_dias', filas);
  } catch (e) {
    if (String(e.message || e).includes('rotacion_dias_unico')) {
      return { error: 'Llegaron dos veces el mismo día. En esta rotación hay un '
                    + 'parque por día.', status: 400 };
    }
    throw e;
  }

  await anotar(env, quien, 'rotacion', Number(rotacionId), 'semana guardada',
    `${fechas[0]} a ${fechas[fechas.length - 1]}, ${filas.length} día(s)`);
  return { ok: true, guardados: filas.length, avisos };
}

/**
 * Una persona no puede estar en dos parques el mismo día. Se mira contra las
 * otras rotaciones, no contra ésta: adentro de ésta ya hay un parque por día.
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
             + 'Una persona no puede estar en dos parques el mismo día.';
      }
    }
  }
  return null;
}

/**
 * El parque que no es de la rotación se acepta: se avisa y se guarda. El que
 * no existe se rechaza acá, con su número, y no cuatro líneas más abajo con
 * el error de la llave foránea escrito en inglés dentro de la pantalla.
 */
async function revisarParques(env, rotacionId, filas, avisos) {
  const usados = [...new Set(filas.map(f => f.instalacion_id).filter(Boolean))];
  if (!usados.length) return null;
  const [puntos, instalaciones] = await Promise.all([
    buscar(env, `rotacion_puntos?select=instalacion_id&rotacion_id=eq.${rotacionId}`),
    buscar(env, `instalaciones?select=id,nombre&id=in.(${usados.join(',')})`),
  ]);
  const dentro = new Set(puntos.map(p => p.instalacion_id));
  const nombre = new Map(instalaciones.map(i => [i.id, i.nombre]));
  const perdidos = usados.filter(id => !nombre.has(id));
  if (perdidos.length) {
    return 'Quedó elegida una instalación que ya no existe '
         + `(N° ${perdidos.join(', ')}). Vuelva a cargar la pantalla.`;
  }
  for (const id of usados) {
    if (!dentro.has(id)) {
      avisos.push(`${nombre.get(id) || 'Una instalación'} no está en la lista de parques `
                + 'de esta rotación. Se guardó igual.');
    }
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
