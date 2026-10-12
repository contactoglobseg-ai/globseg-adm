/**
 * Cotizaciones.
 *
 * Los totales se calculan acá y se guardan. No se confía en lo que manda el
 * navegador, y no se recalculan al mostrar: una cotización enviada tiene que
 * seguir diciendo lo mismo aunque mañana cambie una tarifa.
 */

import { buscar, primero, insertar, actualizar, borrar, anotar } from './datos.js';

const IVA = 0.19;

const entero = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
};

/** Valida y normaliza las líneas. Devuelve { items, neto } o { error }. */
export function revisarItems(crudos) {
  if (!Array.isArray(crudos) || crudos.length === 0) {
    return { error: 'La cotización necesita al menos una línea' };
  }
  if (crudos.length > 60) return { error: 'Demasiadas líneas (máximo 60)' };

  const items = [];
  let neto = 0;
  for (let i = 0; i < crudos.length; i++) {
    const c = crudos[i];
    const descripcion = (c.descripcion || '').trim();
    if (!descripcion) return { error: `La línea ${i + 1} no tiene descripción` };
    if (descripcion.length > 300) return { error: `La descripción de la línea ${i + 1} es demasiado larga` };

    const cantidad = Number(c.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return { error: `La cantidad de la línea ${i + 1} tiene que ser mayor que cero` };
    }
    if (cantidad > 100000) return { error: `La cantidad de la línea ${i + 1} es demasiado grande` };

    const precio = entero(c.precio_unitario);
    if (precio === null || precio < 0) {
      return { error: `El precio de la línea ${i + 1} no es válido` };
    }

    const subtotal = Math.round(precio * cantidad);
    neto += subtotal;
    items.push({
      orden: i,
      descripcion,
      unidad: (c.unidad || '').trim() || null,
      cantidad,
      precio_unitario: precio,
      subtotal,
    });
  }
  return { items, neto };
}

export const totales = (neto) => {
  const iva = Math.round(neto * IVA);
  return { neto, iva, total: neto + iva };
};

/**
 * Número correlativo por año: 2026-001.
 * Se consulta el último del año y se suma uno. La restricción de unicidad
 * atrapa el caso raro de dos personas creando a la vez, y se reintenta.
 */
async function siguienteNumero(env) {
  const anio = new Date().getFullYear();
  const ultima = await primero(env,
    `cotizaciones?select=numero&numero=like.${anio}-*&order=numero.desc`);
  const n = ultima ? Number(ultima.numero.split('-')[1]) + 1 : 1;
  return `${anio}-${String(n).padStart(3, '0')}`;
}

export async function crear(env, usuario, cuerpo) {
  const cliente_nombre = (cuerpo.cliente_nombre || '').trim();
  if (!cliente_nombre) return { error: 'Falta el nombre del cliente', status: 400 };

  const revisadas = revisarItems(cuerpo.items);
  if (revisadas.error) return { error: revisadas.error, status: 400 };

  const validez = cuerpo.validez_dias === undefined || cuerpo.validez_dias === ''
    ? 30 : entero(cuerpo.validez_dias);
  if (validez === null || validez < 1 || validez > 365) {
    return { error: 'La validez debe ser un número de días entre 1 y 365', status: 400 };
  }

  const t = totales(revisadas.neto);

  let creada = null;
  for (let intento = 0; intento < 3 && !creada; intento++) {
    const numero = await siguienteNumero(env);
    try {
      [creada] = await insertar(env, 'cotizaciones', {
        numero,
        cliente_id: entero(cuerpo.cliente_id),
        cliente_nombre,
        cliente_rut: (cuerpo.cliente_rut || '').trim() || null,
        cliente_contacto: (cuerpo.cliente_contacto || '').trim() || null,
        cliente_email: (cuerpo.cliente_email || '').trim() || null,
        instalacion: (cuerpo.instalacion || '').trim() || null,
        validez_dias: validez,
        condiciones: (cuerpo.condiciones || '').trim() || null,
        observaciones: (cuerpo.observaciones || '').trim() || null,
        ...t,
        creado_por: usuario.usuario,
      });
    } catch (e) {
      // 23505 es choque de clave única: otro tomó ese número, se reintenta.
      if (e.detalle?.code !== '23505' || intento === 2) throw e;
    }
  }

  await insertar(env, 'cotizacion_items',
    revisadas.items.map((i) => ({ ...i, cotizacion_id: creada.id })));

  await anotar(env, usuario.usuario, 'cotizacion', creada.id, 'creada',
               `N° ${creada.numero} para ${cliente_nombre}, total ${t.total}`);
  return { cotizacion: creada };
}

export async function editar(env, usuario, id, cuerpo) {
  const actual = await primero(env, `cotizaciones?select=*&id=eq.${id}`);
  if (!actual) return { error: 'Esa cotización no existe', status: 404 };
  if (actual.estado === 'aceptada') {
    return { error: 'Una cotización aceptada no se edita. Cree una nueva.', status: 409 };
  }

  const campos = { actualizado_en: new Date().toISOString() };
  for (const k of ['cliente_nombre', 'cliente_rut', 'cliente_contacto', 'cliente_email',
                   'instalacion', 'condiciones', 'observaciones']) {
    if (k in cuerpo) campos[k] = (cuerpo[k] || '').trim() || null;
  }
  if (campos.cliente_nombre === null) {
    return { error: 'Falta el nombre del cliente', status: 400 };
  }
  if ('validez_dias' in cuerpo) {
    const v = entero(cuerpo.validez_dias);
    if (v === null || v < 1 || v > 365) {
      return { error: 'La validez debe ser un número de días entre 1 y 365', status: 400 };
    }
    campos.validez_dias = v;
  }
  if ('estado' in cuerpo) {
    if (!['borrador', 'enviada', 'aceptada', 'rechazada'].includes(cuerpo.estado)) {
      return { error: 'Ese estado no existe', status: 400 };
    }
    campos.estado = cuerpo.estado;
  }

  // Las líneas se reemplazan completas: es más simple que casar altas, bajas
  // y cambios, y no deja líneas huérfanas.
  let nuevas = null;
  if ('items' in cuerpo) {
    const revisadas = revisarItems(cuerpo.items);
    if (revisadas.error) return { error: revisadas.error, status: 400 };
    Object.assign(campos, totales(revisadas.neto));
    nuevas = revisadas.items.map((i) => ({ ...i, cotizacion_id: id }));
  }

  // Primero la cabecera: si algo falla, la cotización queda con sus líneas
  // viejas y sus totales viejos, que es coherente. Borrar primero dejaría una
  // cotización sin líneas si el resto fallara.
  await actualizar(env, `cotizaciones?id=eq.${id}`, campos);
  if (nuevas) {
    await borrar(env, `cotizacion_items?cotizacion_id=eq.${id}`);
    await insertar(env, 'cotizacion_items', nuevas);
  }
  await anotar(env, usuario.usuario, 'cotizacion', id,
               'editada' + (campos.estado ? ` · ${actual.estado} → ${campos.estado}` : ''),
               null);
  return { ok: true };
}

export async function conItems(env, id) {
  const [cotizacion, items] = await Promise.all([
    primero(env, `v_cotizaciones?select=*&id=eq.${id}`),
    buscar(env, `cotizacion_items?select=*&cotizacion_id=eq.${id}&order=orden.asc`),
  ]);
  if (!cotizacion) return null;
  return { ...cotizacion, items };
}

export const listar = (env) =>
  buscar(env, 'v_cotizaciones?select=*&order=fecha.desc,numero.desc&limit=200');
