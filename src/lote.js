/**
 * Acciones sobre varios registros a la vez.
 *
 * Todo pasa por acá en vez de repetir el borrado en cada ruta, porque las
 * reglas de qué se puede tocar y qué no son el punto: una cotización aceptada
 * y un periodo ya facturado son documentos que salieron de la oficina, y
 * borrarlos deja a la empresa sin respaldo de algo que el cliente sí tiene.
 *
 * Nunca falla entero por un registro: hace lo que puede y devuelve la lista de
 * los que omitió con el motivo. Decir "listo" habiendo saltado la mitad en
 * silencio sería peor que no hacer nada.
 */

import { buscar, actualizar, borrar, anotar } from './datos.js';
import { periodoDe, diasEntre, sumarDias } from './fechas.js';

const MAX = 200;

const ESTADOS_COTIZACION = ['borrador', 'enviada', 'aceptada', 'rechazada'];
const ESTADOS_CONTACTO   = ['nuevo', 'contactado', 'cotizado', 'cerrado', 'descartado'];
const ESTADOS_PAGO       = ['por_cobrar', 'pagado', 'factorizado'];

const TIPOS = {
  cotizaciones: { permiso: 'cotizaciones', singular: 'cotización',     plural: 'cotizaciones' },
  contactos:    { permiso: 'facturacion',  singular: 'contacto',       plural: 'contactos' },
  ciclos:       { permiso: 'facturacion',  singular: 'periodo',        plural: 'periodos' },
  servicios:    { permiso: 'facturacion',  singular: 'servicio',       plural: 'servicios' },
  instalaciones:{ permiso: 'facturacion',  singular: 'instalación',    plural: 'instalaciones' },
  extras:       { permiso: 'facturacion',  singular: 'servicio extra', plural: 'servicios extra' },
};

const esFecha = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

const entero = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
};

const lista = (ids) => `in.(${ids.join(',')})`;

/**
 * @returns { error, status } o { hechos, omitidos: [{ id, razon }], detalle }
 */
export async function aplicar(env, usuario, puede, cuerpo) {
  const tipo = TIPOS[cuerpo.tipo];
  if (!tipo) return { error: 'No sé trabajar con ese tipo de registro', status: 400 };
  if (!puede(usuario, tipo.permiso)) return { error: 'Sin acceso a este módulo', status: 403 };

  const ids = [...new Set((Array.isArray(cuerpo.ids) ? cuerpo.ids : [])
    .map(entero).filter((n) => n !== null && n > 0))];
  if (!ids.length) return { error: 'No hay nada seleccionado', status: 400 };
  if (ids.length > MAX) {
    return { error: `Son demasiados de una vez (máximo ${MAX})`, status: 400 };
  }

  const manejador = {
    cotizaciones: cotizaciones,
    contactos:    contactos,
    ciclos:       ciclos,
    servicios:    servicios,
    instalaciones: instalaciones,
    extras:       extras,
  }[cuerpo.tipo];

  return manejador(env, usuario, ids, cuerpo);
}

// ------------------------------------------------------------- cotizaciones
async function cotizaciones(env, usuario, ids, cuerpo) {
  const filas = await buscar(env, `cotizaciones?select=id,numero,estado&id=${lista(ids)}`);
  const omitidos = faltantes(ids, filas, 'cotización');

  if (cuerpo.accion === 'borrar') {
    const van = [];
    for (const c of filas) {
      if (c.estado === 'aceptada') {
        omitidos.push({ id: c.id, razon: `La ${c.numero} fue aceptada: queda como respaldo de lo que se comprometió` });
      } else van.push(c);
    }
    if (van.length) {
      // Las líneas se van solas: cotizacion_items borra en cascada.
      await borrar(env, `cotizaciones?id=${lista(van.map((c) => c.id))}`);
      await anotar(env, usuario.usuario, 'cotizacion', null, 'borradas en lote',
                   van.map((c) => c.numero).join(', '));
    }
    return { hechos: van.length, omitidos };
  }

  if (cuerpo.accion === 'estado') {
    if (!ESTADOS_COTIZACION.includes(cuerpo.valor)) {
      return { error: 'Ese estado no existe', status: 400 };
    }
    const van = [];
    for (const c of filas) {
      if (c.estado === 'aceptada' && cuerpo.valor !== 'aceptada') {
        omitidos.push({ id: c.id, razon: `La ${c.numero} ya fue aceptada y no se revierte desde acá` });
      } else van.push(c);
    }
    if (van.length) {
      await actualizar(env, `cotizaciones?id=${lista(van.map((c) => c.id))}`,
        { estado: cuerpo.valor, actualizado_en: new Date().toISOString() });
      await anotar(env, usuario.usuario, 'cotizacion', null, `estado en lote: ${cuerpo.valor}`,
                   van.map((c) => c.numero).join(', '));
    }
    return { hechos: van.length, omitidos };
  }

  return { error: 'Esa acción no existe para cotizaciones', status: 400 };
}

// ---------------------------------------------------------------- contactos
async function contactos(env, usuario, ids, cuerpo) {
  const filas = await buscar(env, `contactos?select=id,nombre,estado&id=${lista(ids)}`);
  const omitidos = faltantes(ids, filas, 'contacto');
  const presentes = filas.map((c) => c.id);

  if (cuerpo.accion === 'borrar') {
    if (presentes.length) {
      await borrar(env, `contactos?id=${lista(presentes)}`);
      await anotar(env, usuario.usuario, 'contacto', null, 'borrados en lote',
                   filas.map((c) => c.nombre).join(', ').slice(0, 400));
    }
    return { hechos: presentes.length, omitidos };
  }

  if (cuerpo.accion === 'estado') {
    if (!ESTADOS_CONTACTO.includes(cuerpo.valor)) {
      return { error: 'Ese estado no existe', status: 400 };
    }
    if (presentes.length) {
      await actualizar(env, `contactos?id=${lista(presentes)}`, {
        estado: cuerpo.valor,
        atendido_por: usuario.usuario,
        atendido_en: new Date().toISOString(),
      });
      await anotar(env, usuario.usuario, 'contacto', null, `estado en lote: ${cuerpo.valor}`,
                   `${presentes.length} contactos`);
    }
    return { hechos: presentes.length, omitidos };
  }

  return { error: 'Esa acción no existe para contactos', status: 400 };
}

// ------------------------------------------------------------------- ciclos
async function ciclos(env, usuario, ids, cuerpo) {
  const filas = await buscar(env,
    `ciclos?select=id,servicio_id,numero,estado,factura_folio,pago_estado&id=${lista(ids)}`);
  const omitidos = faltantes(ids, filas, 'periodo');

  if (cuerpo.accion === 'borrar') {
    const avisos = [];
    const idsVan = filas.map((c) => c.id);
    if (idsVan.length) {
      // Si se borra el último periodo de un servicio que sigue activo, el panel
      // lo vuelve a abrir en la siguiente entrada: el servicio estuvo corriendo
      // esos días. Hay que decirlo, o parecerá que el borrado no funcionó.
      const servIds = [...new Set(filas.map((c) => c.servicio_id))];
      const [servicios, todos] = await Promise.all([
        buscar(env, `servicios?select=id,nombre,activo&id=${lista(servIds)}`),
        buscar(env, `ciclos?select=servicio_id,numero&servicio_id=${lista(servIds)}`),
      ]);
      const ultimo = new Map();
      for (const c of todos) {
        ultimo.set(c.servicio_id, Math.max(ultimo.get(c.servicio_id) ?? 0, c.numero));
      }
      for (const s of servicios) {
        if (!s.activo) continue;
        const borraElUltimo = filas.some(
          (c) => c.servicio_id === s.id && c.numero === ultimo.get(s.id));
        if (borraElUltimo) {
          avisos.push(`"${s.nombre}" sigue activo, así que el sistema vuelve a abrir su último periodo. Para que no vuelva, dele de baja en Servicios.`);
        }
      }

      const facturados = filas.filter((c) => c.estado === 'cerrado');
      if (facturados.length) {
        avisos.push(`Se borró${facturados.length > 1 ? 'n' : ''} ${facturados.length} periodo${facturados.length > 1 ? 's' : ''} que ya tenía${facturados.length > 1 ? 'n' : ''} factura registrada (folio ${facturados.map((c) => c.factura_folio).join(', ')}).`);
      }

      // Los extras no se borran: vuelven a quedar sueltos. Son trabajo hecho que
      // hay que cobrar en algún lado, y si desaparecieran con el periodo
      // volvería justo el problema que este sistema resuelve.
      await actualizar(env, `extras?ciclo_id=${lista(idsVan)}`, { ciclo_id: null });
      await borrar(env, `ciclos?id=${lista(idsVan)}`);
      await anotar(env, usuario.usuario, 'ciclo', null, 'borrados',
                   filas.map((c) => `N°${c.numero}${c.factura_folio ? ' (factura ' + c.factura_folio + ')' : ''}`).join(', '));
    }
    return { hechos: idsVan.length, omitidos, avisos };
  }

  if (cuerpo.accion === 'pago_estado') {
    if (!ESTADOS_PAGO.includes(cuerpo.valor)) {
      return { error: 'Ese estado de pago no existe', status: 400 };
    }
    const cobrado = cuerpo.valor !== 'por_cobrar';
    const fecha = (cuerpo.fecha || '').trim();
    if (cobrado && !esFecha(fecha)) {
      return { error: 'Indique la fecha en que entró la plata', status: 400 };
    }

    const van = [];
    for (const c of filas) {
      if (cobrado && !c.factura_folio) {
        omitidos.push({ id: c.id, razon: `El periodo N°${c.numero} todavía no tiene folio de factura: no se puede dar por cobrado` });
      } else van.push(c);
    }
    if (van.length) {
      const campos = {
        pago_estado: cuerpo.valor,
        actualizado_en: new Date().toISOString(),
        // El monto no se toca en lote: cada factura entra por un monto distinto,
        // sobre todo en factoring. Se registra uno por uno en su formulario.
        pago_fecha: cobrado ? fecha : null,
        factoring: cuerpo.valor === 'factorizado'
          ? ((cuerpo.factoring || '').trim() || null) : null,
      };
      if (!cobrado) campos.pago_monto = null;
      await actualizar(env, `ciclos?id=${lista(van.map((c) => c.id))}`, campos);
      await anotar(env, usuario.usuario, 'ciclo', null, `cobranza en lote: ${cuerpo.valor}`,
                   `N° ${van.map((c) => c.numero).join(', ')}${cobrado ? ' el ' + fecha : ''}`);
    }
    return { hechos: van.length, omitidos };
  }

  return { error: 'Esa acción no existe para periodos', status: 400 };
}

// ---------------------------------------------------------------- servicios
/**
 * Dar de baja un servicio es lo que de verdad detiene sus periodos. Borrar un
 * periodo suelto no sirve: el panel los vuelve a generar desde la fecha de
 * inicio del servicio, porque el servicio estuvo corriendo esos días.
 */
async function servicios(env, usuario, ids, cuerpo) {
  const filas = await buscar(env, `servicios?select=id,nombre,activo&id=${lista(ids)}`);
  const omitidos = faltantes(ids, filas, 'servicio');
  const presentes = filas.map((s) => s.id);

  if (cuerpo.accion === 'activo') {
    if (typeof cuerpo.valor !== 'boolean') return { error: 'Falta decir si queda activo', status: 400 };
    if (presentes.length) {
      await actualizar(env, `servicios?id=${lista(presentes)}`, { activo: cuerpo.valor });
      await anotar(env, usuario.usuario, 'servicio', null,
                   cuerpo.valor ? 'reactivados en lote' : 'dados de baja en lote',
                   filas.map((s) => s.nombre).join(', ').slice(0, 400));
    }
    return { hechos: presentes.length, omitidos };
  }

  if (cuerpo.accion === 'recalcular') {
    return recalcularFechas(env, usuario, filas, omitidos);
  }

  if (cuerpo.accion === 'borrar') {
    // Un periodo facturado es el respaldo de una factura que el cliente tiene.
    // Borrar el servicio se lo llevaría en cascada, así que no se permite: para
    // esos casos está dar de baja, que detiene los periodos y conserva todo.
    const cerrados = await buscar(env,
      `ciclos?select=servicio_id,numero,factura_folio&estado=eq.cerrado&servicio_id=${lista(presentes.length ? presentes : [0])}`);
    const porServicio = new Map();
    for (const c of cerrados) {
      if (!porServicio.has(c.servicio_id)) porServicio.set(c.servicio_id, []);
      porServicio.get(c.servicio_id).push(c.factura_folio || `N°${c.numero}`);
    }

    const van = [];
    for (const s of filas) {
      const f = porServicio.get(s.id);
      if (f) {
        omitidos.push({ id: s.id, razon: `"${s.nombre}" tiene ${f.length} periodo${f.length > 1 ? 's' : ''} ya facturado${f.length > 1 ? 's' : ''} (${f.slice(0, 3).join(', ')}): dele de baja en vez de borrarlo` });
      } else van.push(s);
    }
    if (van.length) {
      // Los periodos se van en cascada; los extras que colgaban de ellos
      // quedan sueltos, que es lo que corresponde: el trabajo se hizo.
      await borrar(env, `servicios?id=${lista(van.map((s) => s.id))}`);
      await anotar(env, usuario.usuario, 'servicio', null, 'borrados en lote',
                   van.map((s) => s.nombre).join(', ').slice(0, 400));
    }
    return { hechos: van.length, omitidos };
  }

  return { error: 'Esa acción no existe para servicios', status: 400 };
}

/**
 * Rehace las fechas de los periodos según el ciclo del servicio.
 *
 * Existe porque los primeros servicios se cargaron sumando 30 días y el día de
 * cobro se fue corriendo. Solo mueve los periodos **sin factura**: los
 * facturados son el respaldo de un documento que el cliente ya tiene, y
 * cambiarles las fechas dejaría la factura diciendo una cosa y el sistema otra.
 */
async function recalcularFechas(env, usuario, servicios, omitidos) {
  let hechos = 0;
  const avisos = [];

  for (const s of servicios) {
    const completo = await buscar(env,
      `servicios?select=id,nombre,fecha_inicio,ciclo_tipo,dias_ciclo&id=eq.${s.id}`);
    if (!completo.length) continue;
    const serv = completo[0];

    const ciclos = await buscar(env,
      `ciclos?select=id,numero,estado,desde,hasta,factura_folio&servicio_id=eq.${s.id}&order=numero.asc`);

    let movidos = 0;
    let intactos = 0;
    for (const c of ciclos) {
      const esperado = periodoDe(serv, c.numero);
      if (c.desde === esperado.desde && c.hasta === esperado.hasta) continue;
      if (c.estado === 'cerrado') { intactos += 1; continue; }
      await actualizar(env, `ciclos?id=eq.${c.id}`, {
        desde: esperado.desde, hasta: esperado.hasta,
        actualizado_en: new Date().toISOString(),
      });
      movidos += 1;
    }

    if (movidos) {
      hechos += 1;
      await anotar(env, usuario.usuario, 'servicio', s.id, 'fechas recalculadas',
                   `${movidos} periodo${movidos > 1 ? 's' : ''} de "${serv.nombre}"`);
      avisos.push(`"${serv.nombre}": ${movidos} periodo${movidos > 1 ? 's' : ''} corregido${movidos > 1 ? 's' : ''}.`);
    }
    if (intactos) {
      avisos.push(`"${serv.nombre}": ${intactos} periodo${intactos > 1 ? 's' : ''} ya facturado${intactos > 1 ? 's' : ''} quedó con sus fechas originales, que son las que dice la factura.`);
    }
    if (!movidos && !intactos) {
      avisos.push(`"${serv.nombre}": las fechas ya estaban correctas.`);
    }

    // Entre lo que ya se facturó y la serie corregida puede quedar un hueco o
    // un solape. No se puede arreglar sin tocar una factura emitida, pero
    // callarlo sería peor: un extra con fecha en ese hueco no caería en ningún
    // periodo y nadie sabría por qué.
    if (movidos) {
      const finales = await buscar(env,
        `ciclos?select=numero,desde,hasta&servicio_id=eq.${s.id}&order=numero.asc`);
      for (let i = 1; i < finales.length; i++) {
        const salto = diasEntre(finales[i - 1].hasta, finales[i].desde);
        if (salto === 1) continue;
        if (salto > 1) {
          const dias = salto - 1;
          avisos.push(`Ojo: entre el periodo N°${finales[i - 1].numero} y el N°${finales[i].numero} queda${dias > 1 ? 'n' : ''} ${dias} día${dias > 1 ? 's' : ''} sin cubrir (${sumarDias(finales[i - 1].hasta, 1)}${dias > 1 ? ' al ' + sumarDias(finales[i].desde, -1) : ''}). Es el empalme con lo ya facturado: si hay un extra en esas fechas, quedará suelto.`);
        } else {
          avisos.push(`Ojo: el periodo N°${finales[i - 1].numero} y el N°${finales[i].numero} se pisan. Es el empalme con lo ya facturado; revise cuál corresponde antes de cobrar.`);
        }
      }
    }
  }

  return { hechos, omitidos, avisos };
}

// ------------------------------------------------------------ instalaciones
/**
 * El catálogo que alimenta los desplegables. Dar de baja una instalación la
 * saca de las listas sin tocar nada de lo ya registrado; borrarla solo se
 * puede si de verdad no cuelga nada de ella, porque servicios y extras la
 * referencian con `on delete restrict` y la base lo rechazaría igual, pero con
 * un error que nadie entiende.
 */
async function instalaciones(env, usuario, ids, cuerpo) {
  const filas = await buscar(env, `instalaciones?select=id,nombre,activa&id=${lista(ids)}`);
  const omitidos = faltantes(ids, filas, 'instalación');
  const presentes = filas.map((i) => i.id);

  if (cuerpo.accion === 'activa') {
    if (typeof cuerpo.valor !== 'boolean') return { error: 'Falta decir si queda activa', status: 400 };
    if (presentes.length) {
      await actualizar(env, `instalaciones?id=${lista(presentes)}`, { activa: cuerpo.valor });
      await anotar(env, usuario.usuario, 'instalacion', null,
                   cuerpo.valor ? 'reactivadas en lote' : 'dadas de baja en lote',
                   filas.map((i) => i.nombre).join(', ').slice(0, 400));
    }
    return { hechos: presentes.length, omitidos };
  }

  if (cuerpo.accion === 'borrar') {
    const consulta = presentes.length ? presentes : [0];
    const [servicios, extras] = await Promise.all([
      buscar(env, `servicios?select=instalacion_id&instalacion_id=${lista(consulta)}`),
      buscar(env, `extras?select=instalacion_id&instalacion_id=${lista(consulta)}`),
    ]);
    const usos = new Map();
    for (const f of [...servicios, ...extras]) {
      usos.set(f.instalacion_id, (usos.get(f.instalacion_id) || 0) + 1);
    }

    const van = [];
    for (const i of filas) {
      const n = usos.get(i.id);
      if (n) {
        omitidos.push({ id: i.id, razon: `"${i.nombre}" tiene ${n} registro${n > 1 ? 's' : ''} colgando (servicios o extras): dele de baja para sacarla de las listas sin perder nada` });
      } else van.push(i);
    }
    if (van.length) {
      await borrar(env, `instalaciones?id=${lista(van.map((i) => i.id))}`);
      await anotar(env, usuario.usuario, 'instalacion', null, 'borradas en lote',
                   van.map((i) => i.nombre).join(', ').slice(0, 400));
    }
    return { hechos: van.length, omitidos };
  }

  return { error: 'Esa acción no existe para instalaciones', status: 400 };
}

// ------------------------------------------------------------------- extras
async function extras(env, usuario, ids, cuerpo) {
  const filas = await buscar(env, `extras?select=id,item,ciclo_id&id=${lista(ids)}`);
  const omitidos = faltantes(ids, filas, 'servicio extra');

  // Un extra que ya se facturó dentro de un periodo cerrado no se mueve ni se
  // borra: la factura que vio el cliente lo incluye.
  const conCiclo = [...new Set(filas.map((e) => e.ciclo_id).filter(Boolean))];
  const cerrados = new Set();
  if (conCiclo.length) {
    const cs = await buscar(env, `ciclos?select=id,numero,estado&id=${lista(conCiclo)}`);
    for (const c of cs) if (c.estado === 'cerrado') cerrados.add(c.id);
  }
  const libres = [];
  for (const e of filas) {
    if (e.ciclo_id && cerrados.has(e.ciclo_id)) {
      omitidos.push({ id: e.id, razon: `"${e.item}" ya se facturó dentro de un periodo cerrado` });
    } else libres.push(e);
  }

  if (cuerpo.accion === 'borrar') {
    if (libres.length) {
      await borrar(env, `extras?id=${lista(libres.map((e) => e.id))}`);
      await anotar(env, usuario.usuario, 'extra', null, 'borrados en lote',
                   libres.map((e) => e.item).join(', ').slice(0, 400));
    }
    return { hechos: libres.length, omitidos };
  }

  if (cuerpo.accion === 'asignar') {
    const ciclo_id = cuerpo.valor === null || cuerpo.valor === '' ? null : entero(cuerpo.valor);
    if (ciclo_id !== null) {
      const c = await buscar(env, `ciclos?select=id,numero,estado&id=eq.${ciclo_id}`);
      if (!c.length) return { error: 'Ese periodo no existe', status: 404 };
      if (c[0].estado === 'cerrado') {
        return { error: `El periodo N°${c[0].numero} ya está facturado: no se le pueden agregar extras`, status: 409 };
      }
    }
    if (libres.length) {
      await actualizar(env, `extras?id=${lista(libres.map((e) => e.id))}`, { ciclo_id });
      await anotar(env, usuario.usuario, 'extra', null,
                   ciclo_id ? 'asignados en lote' : 'desasignados en lote',
                   `${libres.length} extras${ciclo_id ? ' al periodo ' + ciclo_id : ''}`);
    }
    return { hechos: libres.length, omitidos };
  }

  return { error: 'Esa acción no existe para servicios extra', status: 400 };
}

/** Los ids que se pidieron y la base no devolvió: alguien más los borró. */
function faltantes(ids, filas, etiqueta) {
  const hay = new Set(filas.map((f) => f.id));
  return ids.filter((id) => !hay.has(id))
            .map((id) => ({ id, razon: `Ese ${etiqueta} ya no existe` }));
}
