/**
 * Activos y EPP: qué tiene la empresa y quién lo tiene puesto.
 *
 * Dos problemas distintos que terminan en la misma tabla:
 *  · El DS 594 art. 53 obliga a entregar los elementos de protección sin costo
 *    y a dejar registro. Ese registro hoy es un papel en una carpeta.
 *  · Un chaleco antibalas vence, y una radio que se fue con alguien que ya no
 *    trabaja acá es plata que nadie anotó.
 *
 * Tres reglas que explican casi todo el archivo:
 *
 * 1. **El stock lo mueve el sistema, pero la bodega manda.** Baja al entregar y
 *    sube al recibir de vuelta. Si alguien entrega algo que el sistema cree que
 *    no tiene, la entrega se registra igual y se avisa que el stock estaba
 *    descuadrado: la persona tiene el casco puesto, y negarse a anotarlo no se
 *    lo quita de la cabeza. Lo que no se puede es perder el registro.
 * 2. **Devolver no siempre repone.** Vuelve al stock lo que vuelve en buen
 *    estado; lo dañado o inservible queda registrado como devuelto y fuera de
 *    bodega, que es donde está de verdad.
 * 3. **Una entrega no se borra.** Si estuvo entregado, estuvo entregado. Lo que
 *    cambia es su estado: devuelto, perdido o dado de baja.
 */

import { buscar, primero, insertar, actualizar, anotar } from './datos.js';
import { hoyISO } from './fechas.js';
// Los ayudantes de validación viven en rrhh.js y se importan en vez de
// copiarse: una segunda copia se separa de la primera el día que una cambie.
import { limpio, entero, fechaO, siNo } from './rrhh.js';

export const MIGRACION = '20261022120000_activos.sql';

export const CATEGORIAS = ['epp', 'uniforme', 'equipo', 'vehiculo', 'otro'];
export const ESTADOS_DEVOLUCION = ['bueno', 'dañado', 'inservible'];
/** Lo único que vuelve a la bodega es lo que vuelve sirviendo. */
const REPONE_STOCK = new Set(['bueno']);

/** Si la migración no corrió, la pantalla lo dice con el nombre del archivo y
 *  el resto del sistema sigue andando. Nadie las aplica solo desde el 14-10. */
export async function tablasListas(env) {
  try {
    await buscar(env, 'articulos?select=count&limit=1');
    await buscar(env, 'entregas?select=count&limit=1');
    return true;
  } catch {
    return false;
  }
}

export const avisoMigracion = () =>
  `Falta aplicar la migración ${MIGRACION} en Supabase. El resto del sistema `
  + 'funciona igual.';

// ------------------------------------------------------------------ catálogo
/**
 * El catálogo con lo que de verdad importa de cada artículo: cuánto queda en
 * bodega, cuántos están entregados y si está bajo el mínimo.
 *
 * Los entregados se cuentan acá y no se guardan en una columna: una columna
 * más que mantener en cada entrega y cada devolución es una columna más que se
 * puede descuadrar, y esto son unas pocas decenas de filas.
 */
export async function catalogo(env) {
  const [articulos, entregados] = await Promise.all([
    buscar(env, 'articulos?select=*&order=categoria.asc,nombre.asc'),
    buscar(env, 'entregas?select=articulo_id,cantidad&estado=eq.entregado'),
  ]);
  const enPoderDe = new Map();
  for (const e of entregados) {
    enPoderDe.set(e.articulo_id, (enPoderDe.get(e.articulo_id) || 0) + e.cantidad);
  }
  return articulos.map((a) => ({
    ...a,
    entregados: enPoderDe.get(a.id) || 0,
    bajo_minimo: a.activo && a.stock < a.stock_minimo,
  }));
}

export async function crearArticulo(env, quien, cuerpo) {
  const nombre = limpio(cuerpo.nombre, 120);
  if (!nombre) return { error: 'Falta el nombre del artículo', status: 400 };

  const categoria = CATEGORIAS.includes(cuerpo.categoria) ? cuerpo.categoria : 'epp';
  const vence = siNo(cuerpo.vence);
  const meses = entero(cuerpo.meses_vida);
  if (vence && !meses) {
    return { error: 'Si el artículo vence, diga en cuántos meses', status: 400 };
  }

  const fila = {
    nombre,
    categoria,
    talla: limpio(cuerpo.talla, 20) || null,
    unidad: limpio(cuerpo.unidad, 20) || 'unidad',
    stock: Math.max(0, entero(cuerpo.stock) || 0),
    stock_minimo: Math.max(0, entero(cuerpo.stock_minimo) || 0),
    vence,
    meses_vida: vence ? meses : null,
    notas: limpio(cuerpo.notas, 300) || null,
    creado_por: quien,
  };

  try {
    const [creado] = await insertar(env, 'articulos', fila);
    await anotar(env, quien, 'articulo', creado.id, 'agregó un artículo',
      `${nombre}${fila.talla ? ' talla ' + fila.talla : ''} · ${categoria}`);
    return { articulo: creado };
  } catch (e) {
    // El índice único es por nombre y talla: dos filas iguales son la misma
    // cosa contada dos veces, y el stock de una no dice nada sin el de la otra.
    if (String(e.message || '').includes('articulo_sin_repetir')) {
      return { error: `Ya existe «${nombre}»${fila.talla ? ' en talla ' + fila.talla : ''}. `
        + 'Corrija ese en vez de agregar otro.', status: 409 };
    }
    throw e;
  }
}

export async function editarArticulo(env, quien, id, cuerpo) {
  const a = await primero(env, `articulos?select=*&id=eq.${id}`);
  if (!a) return { error: 'Ese artículo no existe', status: 404 };

  const campos = {};
  if ('nombre' in cuerpo) {
    const n = limpio(cuerpo.nombre, 120);
    if (!n) return { error: 'Falta el nombre del artículo', status: 400 };
    campos.nombre = n;
  }
  if ('categoria' in cuerpo && CATEGORIAS.includes(cuerpo.categoria)) {
    campos.categoria = cuerpo.categoria;
  }
  if ('talla' in cuerpo) campos.talla = limpio(cuerpo.talla, 20) || null;
  if ('unidad' in cuerpo) campos.unidad = limpio(cuerpo.unidad, 20) || 'unidad';
  if ('stock_minimo' in cuerpo) campos.stock_minimo = Math.max(0, entero(cuerpo.stock_minimo) || 0);
  if ('activo' in cuerpo) campos.activo = siNo(cuerpo.activo);
  if ('notas' in cuerpo) campos.notas = limpio(cuerpo.notas, 300) || null;
  if ('vence' in cuerpo) {
    campos.vence = siNo(cuerpo.vence);
    const meses = entero(cuerpo.meses_vida) || a.meses_vida;
    if (campos.vence && !meses) {
      return { error: 'Si el artículo vence, diga en cuántos meses', status: 400 };
    }
    campos.meses_vida = campos.vence ? meses : null;
  } else if ('meses_vida' in cuerpo && a.vence) {
    campos.meses_vida = entero(cuerpo.meses_vida) || a.meses_vida;
  }

  // El stock no se edita acá: se ajusta, y el ajuste pide motivo. Dejarlo
  // escribible en el mismo formulario que el nombre haría que una corrección
  // de tipeo se llevara por delante el conteo de la bodega sin que nadie lo
  // notara.
  if (!Object.keys(campos).length) return { error: 'No hay nada que cambiar', status: 400 };

  await actualizar(env, `articulos?id=eq.${id}`, campos);
  await anotar(env, quien, 'articulo', id, 'editó un artículo', a.nombre);
  return { ok: true };
}

/**
 * Mover el stock a mano: una compra que llegó, un conteo de bodega que no
 * cuadra, algo que se perdió. Pide motivo porque un número que cambia solo no
 * se puede defender después.
 */
export async function ajustarStock(env, quien, id, cuerpo) {
  const a = await primero(env, `articulos?select=*&id=eq.${id}`);
  if (!a) return { error: 'Ese artículo no existe', status: 404 };

  const motivo = limpio(cuerpo.motivo, 200);
  if (!motivo) return { error: 'Escriba por qué cambia el stock', status: 400 };

  // Se acepta «cuánto hay» o «cuánto entra o sale»: la oficina cuenta la
  // bodega y escribe el total, o anota una compra de 20.
  const nuevo = 'stock' in cuerpo
    ? Math.max(0, entero(cuerpo.stock) || 0)
    : Math.max(0, a.stock + (entero(cuerpo.delta) || 0));
  if (nuevo === a.stock) return { error: 'El stock quedaría igual', status: 400 };

  await actualizar(env, `articulos?id=eq.${id}`, { stock: nuevo });
  await anotar(env, quien, 'articulo', id, 'ajustó el stock',
    `${a.nombre}: ${a.stock} → ${nuevo} · ${motivo}`);
  return { ok: true, stock: nuevo };
}

// ------------------------------------------------------------------ entregas
export async function listarEntregas(env, { trabajador, estado, articulo } = {}) {
  const filtros = ['select=*'];
  if (entero(trabajador)) filtros.push(`trabajador_id=eq.${entero(trabajador)}`);
  if (entero(articulo)) filtros.push(`articulo_id=eq.${entero(articulo)}`);
  if (estado) filtros.push(`estado=eq.${encodeURIComponent(estado)}`);
  filtros.push('order=entregada_en.desc,id.desc');
  return buscar(env, `v_entregas?${filtros.join('&')}`);
}

/** Suma meses a una fecha, recortando al último día del mes cuando no existe:
 *  entregado el 31 de marzo con 1 mes de vida vence el 30 de abril. Es la
 *  misma regla de aniversario que usa el ciclo de cobro. */
function sumarMeses(iso, meses) {
  const [a, m, d] = iso.slice(0, 10).split('-').map(Number);
  const total = (m - 1) + meses;
  const anio = a + Math.floor(total / 12);
  const mes = (total % 12 + 12) % 12;
  const ultimo = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
  return `${anio}-${String(mes + 1).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
}

export async function entregar(env, quien, cuerpo) {
  const t = await primero(env,
    `trabajadores?select=id,nombre,activo&id=eq.${entero(cuerpo.trabajador_id)}`);
  if (!t) return { error: 'Esa persona no está en el registro', status: 404 };

  const a = await primero(env, `articulos?select=*&id=eq.${entero(cuerpo.articulo_id)}`);
  if (!a) return { error: 'Ese artículo no existe', status: 404 };

  const cantidad = entero(cuerpo.cantidad) || 1;
  if (cantidad < 1) return { error: 'La cantidad tiene que ser al menos 1', status: 400 };

  const entregada = fechaO(cuerpo.entregada_en) || hoyISO();
  if (entregada > hoyISO()) {
    return { error: 'No se puede registrar una entrega con fecha futura', status: 400 };
  }

  // El vencimiento se propone con la vida útil del catálogo y se puede
  // corregir: la fecha que trae marcada el fabricante manda sobre la nuestra.
  const vence = fechaO(cuerpo.vence_en)
    || (a.vence && a.meses_vida ? sumarMeses(entregada, a.meses_vida) : null);

  const avisos = [];
  if (!t.activo) {
    avisos.push('Esta persona está de baja en el registro. Quedó anotado igual, '
      + 'pero revise si corresponde entregarle algo.');
  }

  const [creada] = await insertar(env, 'entregas', {
    trabajador_id: t.id,
    articulo_id: a.id,
    cantidad,
    entregada_en: entregada,
    vence_en: vence,
    observacion: limpio(cuerpo.observacion, 300) || null,
    creado_por: quien,
  });

  // El stock baja hasta cero y no más. Si queda descuadrado se dice: la
  // persona ya tiene el casco puesto, y negarse a anotarlo no se lo quita.
  const quedaba = a.stock;
  const nuevo = Math.max(0, quedaba - cantidad);
  if (nuevo !== quedaba) await actualizar(env, `articulos?id=eq.${a.id}`, { stock: nuevo });
  if (cantidad > quedaba) {
    avisos.push(`El sistema tenía ${quedaba} en bodega y se entregaron ${cantidad}: `
      + 'el stock quedó en cero y hay que cuadrarlo con un ajuste.');
  } else if (nuevo < a.stock_minimo) {
    avisos.push(`Quedan ${nuevo} y el mínimo es ${a.stock_minimo}: hay que reponer.`);
  }

  await anotar(env, quien, 'entrega', creada.id, 'entregó',
    `${t.nombre}: ${cantidad} ${a.unidad}${cantidad > 1 ? 's' : ''} de ${a.nombre}`
    + `${vence ? ` · vence ${vence}` : ''}`);

  return { entrega: creada, avisos };
}

/**
 * Cerrar una entrega: devuelta, perdida o dada de baja.
 *
 * No se borra nunca: si estuvo entregado, estuvo entregado, y el registro de
 * que se entregó es justamente lo que pide el DS 594.
 */
export async function cerrarEntrega(env, quien, id, cuerpo) {
  const e = await primero(env, `v_entregas?select=*&id=eq.${id}`);
  if (!e) return { error: 'Esa entrega no existe', status: 404 };
  if (e.estado !== 'entregado') {
    return { error: `Esta entrega ya está como «${e.estado}»`, status: 409 };
  }

  const estado = ['devuelto', 'perdido', 'dado_de_baja'].includes(cuerpo.estado)
    ? cuerpo.estado : null;
  if (!estado) return { error: 'Diga si se devolvió, se perdió o se dio de baja', status: 400 };

  const campos = { estado, observacion: limpio(cuerpo.observacion, 300) || e.observacion };
  let repone = false;

  if (estado === 'devuelto') {
    const cuando = fechaO(cuerpo.devuelta_en) || hoyISO();
    if (cuando < e.entregada_en) {
      return { error: 'La devolución no puede ser anterior a la entrega', status: 400 };
    }
    const como = ESTADOS_DEVOLUCION.includes(cuerpo.devolucion_estado)
      ? cuerpo.devolucion_estado : null;
    if (!como) return { error: 'Diga en qué estado volvió', status: 400 };
    campos.devuelta_en = cuando;
    campos.devolucion_estado = como;
    repone = REPONE_STOCK.has(como);
  }

  await actualizar(env, `entregas?id=eq.${id}`, campos);

  const avisos = [];
  if (repone) {
    const a = await primero(env, `articulos?select=stock&id=eq.${e.articulo_id}`);
    await actualizar(env, `articulos?id=eq.${e.articulo_id}`,
      { stock: (a?.stock || 0) + e.cantidad });
  } else if (estado === 'devuelto') {
    avisos.push(`Volvió ${campos.devolucion_estado}, así que no se sumó a la bodega: `
      + 'si se puede reparar y vuelve a servir, ajuste el stock.');
  }

  await anotar(env, quien, 'entrega', Number(id), `marcó como ${estado}`,
    `${e.trabajador}: ${e.cantidad} de ${e.articulo}`
    + `${campos.devolucion_estado ? ` · volvió ${campos.devolucion_estado}` : ''}`);

  return { ok: true, avisos };
}

// -------------------------------------------------------------------- panel
/**
 * Lo que hay que mirar: lo que vence, lo que está bajo el mínimo y lo que
 * sigue en poder de gente que ya no trabaja acá.
 *
 * Ese último es el que nadie revisa y el que cuesta plata: una radio que se
 * fue con alguien hace seis meses no aparece en ninguna lista hoy.
 */
export async function panelActivos(env) {
  const [arts, entregadas] = await Promise.all([
    catalogo(env),
    buscar(env, 'v_entregas?select=*&estado=eq.entregado&order=vence_en.asc.nullslast'),
  ]);

  return {
    hoy: hoyISO(),
    bajo_minimo: arts.filter((a) => a.bajo_minimo),
    vencidos: entregadas.filter((e) => e.situacion === 'vencido'),
    por_vencer: entregadas.filter((e) => e.situacion === 'por_vencer'),
    en_poder_de_inactivos: entregadas.filter((e) => !e.trabajador_activo),
    total_entregado: entregadas.reduce((n, e) => n + e.cantidad, 0),
  };
}
