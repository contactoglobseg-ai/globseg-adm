/**
 * Cotizaciones.
 *
 * Los totales se calculan acá y se guardan. No se confía en lo que manda el
 * navegador, y no se recalculan al mostrar: una cotización enviada tiene que
 * seguir diciendo lo mismo aunque mañana cambie una tarifa.
 */

import { buscar, primero, insertar, actualizar, borrar, anotar } from './datos.js';

const IVA = 0.19;

/**
 * Las dos monedas en que se cotiza. Lo único que cambia entre ellas son los
 * decimales, y es lo que importa: un peso no se parte, pero una UF se cotiza
 * con dos ("1,8 UF el turno") y redondearla a 2 cambia el precio.
 */
export const MONEDAS = {
  clp: { decimales: 0, rotulo: 'pesos' },
  uf:  { decimales: 2, rotulo: 'UF' },
};

const entero = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
};

const redondear = (v, decimales) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimales;
  return Math.round(n * f) / f;
};

/**
 * El valor de la UF que RRHH carga cada mes en Sueldos → Parámetros.
 *
 * Si la migración de RRHH no corrió, o nadie escribió el valor del mes, no hay
 * valor y se devuelve null: la cotización se emite igual, en UF y sin
 * equivalencia en pesos. Un valor inventado adentro de un documento que se le
 * manda a un cliente es peor que no poner ninguno.
 */
export async function ufVigente(env, fecha = new Date().toISOString().slice(0, 10)) {
  try {
    const f = await primero(env,
      'parametros_rrhh?select=valor,vigente_desde,por_confirmar' +
      `&codigo=eq.uf&vigente_desde=lte.${fecha}&order=vigente_desde.desc`);
    const v = f ? Number(f.valor) : 0;
    if (!(v > 0)) return null;
    return { valor: v, vigente_desde: f.vigente_desde, por_confirmar: f.por_confirmar };
  } catch {
    return null;
  }
}

/** Valida y normaliza las líneas. Devuelve { items, neto } o { error }. */
export function revisarItems(crudos, moneda = 'clp') {
  const dec = MONEDAS[moneda]?.decimales;
  if (dec === undefined) return { error: 'Esa moneda no existe' };
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

    const precio = redondear(c.precio_unitario, dec);
    if (precio === null || precio < 0) {
      return { error: `El precio de la línea ${i + 1} no es válido` };
    }

    const subtotal = redondear(precio * cantidad, dec);
    neto = redondear(neto + subtotal, dec);
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

export const totales = (neto, moneda = 'clp') => {
  const dec = MONEDAS[moneda].decimales;
  const iva = redondear(neto * IVA, dec);
  return { neto, iva, total: redondear(neto + iva, dec) };
};

/**
 * El valor de la UF que se congela dentro de la cotización. Lo manda la
 * pantalla —quien cotiza puede saber el de hoy mejor que el parámetro— y si no
 * lo manda, se toma el de RRHH. Null es una respuesta válida: significa que no
 * se imprime equivalencia en pesos.
 */
async function valorUF(env, cuerpo) {
  // Si la pantalla mandó el campo, manda la pantalla, aunque venga vacío:
  // vaciarlo a propósito es decir que esta cotización sale sin equivalencia.
  if ('uf_valor' in cuerpo) {
    const dado = cuerpo.uf_valor;
    if (dado === null || dado === '') return { uf_valor: null };
    const v = redondear(dado, 2);
    if (v === null || v <= 0) return { error: 'El valor de la UF no es válido' };
    return { uf_valor: v };
  }
  const uf = await ufVigente(env);
  return { uf_valor: uf ? uf.valor : null };
}

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

  const moneda = (cuerpo.moneda || 'clp').trim();
  if (!(moneda in MONEDAS)) return { error: 'Esa moneda no existe', status: 400 };

  const revisadas = revisarItems(cuerpo.items, moneda);
  if (revisadas.error) return { error: revisadas.error, status: 400 };

  const validez = cuerpo.validez_dias === undefined || cuerpo.validez_dias === ''
    ? 30 : entero(cuerpo.validez_dias);
  if (validez === null || validez < 1 || validez > 365) {
    return { error: 'La validez debe ser un número de días entre 1 y 365', status: 400 };
  }

  const conUF = await soportaUF(env);
  if (!conUF && moneda === 'uf') return { error: SIN_MIGRACION, status: 503 };

  const uf = moneda === 'uf' ? await valorUF(env, cuerpo) : { uf_valor: null };
  if (uf.error) return { error: uf.error, status: 400 };

  const t = totales(revisadas.neto, moneda);

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
        ...(conUF ? { moneda, uf_valor: uf.uf_valor } : {}),
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
               `N° ${creada.numero} para ${cliente_nombre}, ` +
               `total ${t.total} ${MONEDAS[moneda].rotulo}`);
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

  // La moneda no convierte nada: cambiarla cambia en qué unidad se leen las
  // cifras, y los precios los convierte quien cotiza, en la pantalla, que es
  // donde puede mirarlos antes de aceptar. Acá solo se recalculan los totales
  // con los decimales de la moneda nueva.
  const conUF = await soportaUF(env);
  let moneda = actual.moneda || 'clp';
  if ('moneda' in cuerpo) {
    const m = (cuerpo.moneda || '').trim();
    if (!(m in MONEDAS)) return { error: 'Esa moneda no existe', status: 400 };
    if (!conUF) {
      if (m === 'uf') return { error: SIN_MIGRACION, status: 503 };
    } else if (m !== moneda) {
      campos.moneda = m;
    }
    moneda = m;
  }
  if (conUF && moneda === 'uf') {
    if ('uf_valor' in cuerpo || campos.moneda) {
      const uf = await valorUF(env, cuerpo);
      if (uf.error) return { error: uf.error, status: 400 };
      campos.uf_valor = uf.uf_valor;
    }
  } else if (campos.moneda) {
    campos.uf_valor = null;
  }

  // Las líneas se reemplazan completas: es más simple que casar altas, bajas
  // y cambios, y no deja líneas huérfanas.
  //
  // Si cambió la moneda y no vinieron líneas, se releen las guardadas: los
  // totales tienen que quedar con los decimales de la moneda nueva, y dejarlos
  // como estaban es la cotización diciendo dos cosas distintas.
  let nuevas = null;
  const crudas = 'items' in cuerpo ? cuerpo.items
    : (campos.moneda ? await buscar(env,
        `cotizacion_items?select=*&cotizacion_id=eq.${id}&order=orden.asc`) : null);
  if (crudas) {
    const revisadas = revisarItems(crudas, moneda);
    if (revisadas.error) return { error: revisadas.error, status: 400 };
    Object.assign(campos, totales(revisadas.neto, moneda));
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
               campos.moneda
                 ? `moneda ${MONEDAS[actual.moneda || 'clp'].rotulo} → ${MONEDAS[moneda].rotulo}`
                 : null);
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

/**
 * Si la migración de la UF se aplicó. Sin ella la pantalla esconde la moneda y
 * lo dice, y el servidor sigue guardando cotizaciones en pesos sin mandar las
 * dos columnas nuevas: una cotización en pesos no tiene por qué dejar de
 * guardarse porque falte una migración que no necesita.
 *
 * Un sí queda recordado en el isolate: una columna que existe no desaparece.
 * Un no se vuelve a preguntar, porque la migración puede aplicarse en
 * cualquier momento y nadie reinicia el Worker para avisar.
 */
let hayColumnas = false;
export async function soportaUF(env) {
  if (hayColumnas) return true;
  try {
    await buscar(env, 'cotizaciones?select=moneda&limit=1');
    hayColumnas = true;
    return true;
  } catch {
    return false;
  }
}

const SIN_MIGRACION =
  'Todavía no se puede cotizar en UF: falta aplicar la migración ' +
  '20261022160000_cotizacion_uf.sql en Supabase.';
