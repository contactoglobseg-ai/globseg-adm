/**
 * Documentos generados desde plantilla y firmados con el dedo.
 *
 * El ciclo completo, que es lo que explica el resto del archivo:
 *
 *   1. La oficina elige plantilla y persona. El servidor arma el texto con los
 *      datos de la ficha y del contrato, y lo **congela**: a partir de ahí ese
 *      documento es ese texto y nada más.
 *   2. El trabajador entra a asistencia.seggarridos.com con su propia cuenta
 *      —la misma con la que marca turno, con la clave que él eligió—, lee el
 *      documento completo y firma con el dedo.
 *   3. La empresa firma desde el panel.
 *   4. Con todas las firmas puestas, el documento queda `firmado` y, si es un
 *      documento laboral, se archiva como documento de esa persona para poder
 *      mandárselo y subirlo a la Dirección del Trabajo.
 *
 * Qué clase de firma es esto, dicho sin adornos: **firma electrónica simple de
 * la Ley 19.799**. Vale, y entre las partes hace plena prueba cuando ninguna la
 * objeta. Lo que se discute cuando alguien la objeta es si se puede demostrar
 * quién firmó y cuándo, y para eso están las columnas de `firmas_documento`.
 * No es firma electrónica avanzada: eso exige un certificado de un prestador
 * acreditado, que la empresa no tiene. El sistema no promete más que eso y la
 * pantalla lo dice donde se firma.
 */

import { buscar, primero, insertar, actualizar, anotar } from './datos.js';
import { hoyISO, esFecha } from './fechas.js';
import { armar, faltantes, explicarFaltantes, hash,
         datosLaborales, datosArriendo } from './plantillas.js';
import { ipDe, huellaDe } from './limite.js';
import { formatearRut } from './rut.js';

export const MIGRACION = '20261020180000_documentos_firma.sql';

/** Una firma pesa unos pocos kB. 400 kB es diez veces un trazo largo en un
 *  teléfono grande, y corta de raíz que alguien mande una foto como «firma». */
const MAX_FIRMA = 400 * 1024;

const limpio = (v, max = 200) => {
  const t = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return t ? t.slice(0, max) : null;
};
const entero = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(String(v).replace(/[^\d.-]/g, '')));
  return Number.isFinite(n) ? n : null;
};

/**
 * Si la migración no corrió, lo dice con el nombre del archivo en vez de
 * reventar. Es la costumbre de `/api/contacto` y de la ficha de ingreso, y en
 * este proyecto es lo único que ha estado avisando de que una migración quedó
 * sin aplicar: nadie las aplica solo desde el 14-10-2026.
 */
export async function tablasListas(env) {
  try {
    await buscar(env, 'plantillas_documento?select=codigo&limit=1');
    await buscar(env, 'documentos_generados?select=id&limit=1');
    return true;
  } catch {
    return false;
  }
}

export const avisoMigracion = () =>
  'Falta aplicar la migración ' + MIGRACION + ' en el SQL Editor de Supabase. '
  + 'Las plantillas y las firmas no están disponibles hasta que se aplique; '
  + 'el resto del sistema funciona igual. Ver COMO-APLICAR-MIGRACIONES.md.';

// ------------------------------------------------------------------ catálogo
export async function catalogos(env) {
  const [plantillas, bloques, empresa] = await Promise.all([
    buscar(env, 'plantillas_documento?select=*&activa=is.true&order=orden.asc'),
    buscar(env, 'bloques_plantilla?select=*&activo=is.true&order=orden.asc'),
    buscar(env, 'datos_empresa?select=*&order=codigo.asc'),
  ]);
  return {
    // El cuerpo no viaja a la pantalla: es largo, no se edita desde ahí y lo
    // que se muestra es siempre el documento ya armado.
    plantillas: plantillas.map(({ cuerpo, ...resto }) => resto),
    bloques,
    empresa: empresa.map((e) => ({ ...e, ...rotuloEmpresa(e) })),
    empresa_por_confirmar: empresa.filter((e) => e.por_confirmar),
  };
}

/**
 * El rótulo corto de un dato de la empresa y, aparte, la explicación.
 *
 * Sale de la glosa, que ya vive en la base: hasta el primer punto o la primera
 * coma es el nombre del dato y el resto es qué estaba en duda. Así el nombre no
 * se escribe por segunda vez en la pantalla, y el servidor puede nombrarlo
 * igual cuando algo se rechaza. «Domicilio de la empresa, el que va en el
 * encabezado del contrato» da un rótulo que no cabe en la columna.
 */
export function rotuloEmpresa(e) {
  const glosa = String(e.glosa || e.codigo).trim();
  const corte = glosa.search(/[.,] /);
  if (corte < 0) return { rotulo: glosa.replace(/[.,]$/, ''), nota: '' };
  return { rotulo: glosa.slice(0, corte), nota: glosa.slice(corte + 2) };
}

/**
 * Corrige un dato de la empresa desde la pantalla.
 *
 * Antes esto vivía solo en la semilla de la migración: la razón social con que
 * se firman los contratos y el correo del representante salían en ámbar como
 * «hay que confirmar» y no había dónde confirmarlos, así que la única salida
 * era un update a mano en la base. Son los datos que entran en **todos** los
 * contratos, y el sistema se niega a generar uno al que le falte alguno.
 *
 * Tres reglas:
 *  - Solo códigos que ya existen. La pantalla corrige los ocho datos que la
 *    migración sembró; no inventa llaves nuevas, que después nadie sabría qué
 *    plantilla las usa.
 *  - No se puede dejar vacío. Un dato en blanco no es «sin confirmar»: es un
 *    hueco que aparece como una línea de guiones adentro de un contrato.
 *  - **Guardar es confirmar.** La glosa es la pregunta y guardar es la
 *    respuesta: alguien la leyó y decidió. Por eso baja `por_confirmar`
 *    aunque el valor no cambie, y por eso queda en la bitácora con lo que
 *    decía antes: lo que se firmó el mes pasado se firmó con el valor viejo.
 */
export async function guardarEmpresa(env, quien, cuerpo) {
  const codigo = String(cuerpo?.codigo || '').trim();
  if (!/^[a-z_]{2,40}$/.test(codigo)) return { error: 'Falta el código del dato', status: 400 };

  const actual = await primero(env, `datos_empresa?select=*&codigo=eq.${codigo}`);
  if (!actual) {
    return { error: `«${codigo}» no es un dato de la empresa que el sistema use`, status: 404 };
  }

  const valor = limpio(cuerpo.valor, 300);
  if (!valor) {
    return { error: `${rotuloEmpresa(actual).rotulo} no puede quedar vacío: saldría como una `
                    + 'línea de guiones adentro del contrato', status: 400 };
  }

  const cambio = valor !== actual.valor;
  const confirma = actual.por_confirmar;
  if (!cambio && !confirma) return { dato: actual, sin_cambios: true };

  const [guardado] = await actualizar(env, `datos_empresa?codigo=eq.${codigo}`, {
    valor,
    por_confirmar: false,
    actualizado_por: quien,
    actualizado_en: new Date().toISOString(),
  });

  await anotar(env, quien, 'dato_empresa', null,
    cambio ? 'corrigió un dato de la empresa' : 'confirmó un dato de la empresa',
    cambio ? `${actual.glosa || codigo}: «${actual.valor}» → «${valor}»`
           : `${actual.glosa || codigo}: «${valor}»`);

  return { dato: guardado || { ...actual, valor, por_confirmar: false }, cambio, confirma };
}

const empresaPorCodigo = async (env) => {
  const filas = await buscar(env, 'datos_empresa?select=*');
  return Object.fromEntries(filas.map((f) => [f.codigo, f]));
};

// ------------------------------------------------------------------ armado
/**
 * Arma el documento. Con `guardar` en false es la vista previa, que no escribe
 * nada: la oficina tiene que poder mirar el contrato completo antes de
 * congelarlo, porque después no se edita.
 */
export async function generar(env, quien, cuerpo,
                              { guardar = false, puedeLaboral = true } = {}) {
  const codigo = limpio(cuerpo.plantilla, 40);
  const p = codigo && await primero(env,
    `plantillas_documento?select=*&codigo=eq.${encodeURIComponent(codigo)}`);
  if (!p) return { error: 'Esa plantilla no existe', status: 404 };
  if (!p.activa) return { error: 'Esa plantilla está desactivada', status: 409 };
  // La segunda puerta: una plantilla laboral lleva el sueldo y la cuenta
  // bancaria en el cuerpo. Se mira acá y no solo en el Worker para que no haya
  // un camino que arme el documento sin pasar por esta pregunta.
  if (p.clase === 'laboral' && !puedeLaboral) {
    return { error: 'Los documentos laborales los genera Recursos Humanos', status: 403 };
  }

  const empresa = await empresaPorCodigo(env);
  const hoy = esFecha(cuerpo.fecha) ? cuerpo.fecha : hoyISO();

  let datos;
  let trabajador = null;
  let contrato = null;
  let bloque = '';
  let titulo = p.titulo;

  if (p.clase === 'laboral') {
    trabajador = await primero(env,
      `trabajadores?select=*&id=eq.${entero(cuerpo.trabajador_id)}`);
    if (!trabajador) return { error: 'Esa persona no está en el registro', status: 404 };

    // El contrato pedido, o el vigente. Se exige uno cargado porque de ahí
    // salen el sueldo, el cargo y el plazo: generarlo sin contrato sería
    // escribir a mano los datos que el sistema ya tiene, que es exactamente lo
    // que este módulo viene a terminar.
    contrato = entero(cuerpo.contrato_id)
      ? await primero(env, `contratos?select=*&id=eq.${entero(cuerpo.contrato_id)}`)
      : await primero(env,
          `contratos?select=*&trabajador_id=eq.${trabajador.id}&estado=eq.vigente`
          + '&order=fecha_inicio.desc');
    if (p.requiere_contrato && !contrato) {
      return { error: 'Esa persona no tiene contrato cargado. Cárguelo primero en '
                      + 'Personas → Fichas y después genere el documento.', status: 409 };
    }
    if (contrato && contrato.trabajador_id !== trabajador.id) {
      return { error: 'Ese contrato es de otra persona', status: 400 };
    }

    const instalacion = contrato?.instalacion_id
      ? await primero(env, `instalaciones?select=*&id=eq.${contrato.instalacion_id}`)
      : null;

    datos = datosLaborales({ trabajador, contrato, instalacion, empresa, hoy });

    // El bloque de funciones. Es lo único que distingue el contrato de un
    // guardia del de un supervisor, y por eso es un bloque y no dos plantillas.
    const codigoBloque = limpio(cuerpo.bloque, 40);
    if (codigoBloque) {
      const b = await primero(env,
        `bloques_plantilla?select=*&codigo=eq.${encodeURIComponent(codigoBloque)}`);
      if (!b) return { error: 'Ese bloque de funciones no existe', status: 404 };
      bloque = b.cuerpo;
    }
    titulo = `${p.titulo} — ${trabajador.nombre}`;
  } else {
    // Arriendo y, más adelante, lo del prevencionista: no hay ficha de dónde
    // sacar los datos, los escribe quien genera el documento.
    const campos = {};
    for (const [k, v] of Object.entries(cuerpo.campos || {})) {
      if (/^[a-z_0-9]{1,40}$/.test(k)) campos[k] = typeof v === 'string' ? limpio(v, 300) : v;
    }
    datos = datosArriendo({ empresa, hoy, campos });
    if (campos.patente) titulo = `${p.titulo} — ${String(campos.patente).toUpperCase()}`;
  }

  // `sinLlenar` recoge el nombre de cada campo que quedó en blanco mientras se
  // arma; del texto terminado solo se podría contar cuántos huecos hay.
  const sinLlenar = new Set();
  const texto = armar(p.cuerpo, datos, bloque, sinLlenar);
  const faltan = faltantes(texto);

  // Lo que nadie confirmó: lo de la plantilla más lo de los datos de la
  // empresa que se usaron. Se muestra en ámbar antes de generar y queda
  // copiado dentro del documento, para que no dependa de que alguien se
  // acuerde de la pantalla donde lo leyó.
  const porConfirmar = [
    p.por_confirmar,
    ...Object.values(empresa).filter((e) => e.por_confirmar).map((e) => e.glosa || e.codigo),
  ].filter(Boolean).join(' ');

  const armado = {
    plantilla: p.codigo,
    plantilla_nombre: p.nombre,
    clase: p.clase,
    firmantes: p.firmantes.split(',').map((s) => s.trim()).filter(Boolean),
    titulo,
    cuerpo: texto,
    datos,
    faltan,
    // Qué falta y dónde se arregla cada cosa. «Faltan 11 campos» obliga a
    // buscarlos a ojo entre la ficha, el contrato y las instalaciones.
    faltan_campos: explicarFaltantes(sinLlenar),
    por_confirmar: porConfirmar || null,
  };
  if (!guardar) return { vista_previa: armado };

  // Un documento con campos en blanco no se manda a firmar: la persona que lo
  // firma estaría aceptando un texto con huecos, y lo que firmó dejaría de ser
  // demostrable justo en lo que quedó sin llenar.
  if (faltan) {
    return { error: `El documento tiene ${faltan} ${faltan === 1 ? 'campo' : 'campos'} `
                    + 'sin completar. Complete la ficha o el contrato y vuelva a generarlo.',
             status: 409, vista_previa: armado };
  }

  const numero = await siguienteNumero(env);
  const cuerpoHash = await hash(texto);

  const [creado] = await insertar(env, 'documentos_generados', {
    numero,
    plantilla: p.codigo,
    titulo,
    trabajador_id: trabajador?.id ?? null,
    contrato_id: contrato?.id ?? null,
    datos,
    cuerpo: texto,
    cuerpo_hash: cuerpoHash,
    por_confirmar: porConfirmar || null,
    creado_por: quien,
  });

  await anotar(env, quien, 'documento_generado', creado.id, 'generó un documento',
    `${numero} · ${p.nombre}${trabajador ? ' · ' + trabajador.nombre : ''}`);

  return { documento: { ...creado, ...armado, id: creado.id, numero, estado: creado.estado } };
}

/** Correlativo por año, como el de las cotizaciones. */
async function siguienteNumero(env) {
  const anio = hoyISO().slice(0, 4);
  const ultima = await primero(env,
    `documentos_generados?select=numero&numero=like.${anio}-*&order=numero.desc`);
  const n = ultima ? Number(ultima.numero.split('-')[1]) + 1 : 1;
  return `${anio}-${String(n).padStart(4, '0')}`;
}

// ----------------------------------------------------------------- consultas
export const listar = (env, { trabajador_id, estado } = {}) =>
  buscar(env, 'v_documentos_generados?select=*'
    + (trabajador_id ? `&trabajador_id=eq.${entero(trabajador_id)}` : '')
    + (estado ? `&estado=eq.${encodeURIComponent(estado)}` : '')
    + '&order=creado_en.desc&limit=300');

export async function ver(env, id) {
  const d = await primero(env, `documentos_generados?select=*&id=eq.${entero(id)}`);
  if (!d) return null;
  const [p, firmas] = await Promise.all([
    primero(env, `plantillas_documento?select=nombre,clase,firmantes&codigo=eq.${encodeURIComponent(d.plantilla)}`),
    buscar(env, `firmas_documento?select=*&documento_id=eq.${d.id}&order=firmado_en.asc`),
  ]);
  return {
    ...d,
    plantilla_nombre: p?.nombre ?? d.plantilla,
    clase: p?.clase ?? 'general',
    firmantes: (p?.firmantes || '').split(',').map((s) => s.trim()).filter(Boolean),
    firmas,
    // Si alguna firma no calza con el cuerpo, el texto cambió después de
    // firmado. No debería poder pasar —el cuerpo no se edita por ninguna
    // ruta— pero si pasa hay que decirlo, no mostrar un documento firmado que
    // ya no es el que se firmó.
    descuadrado: firmas.some((f) => f.cuerpo_hash !== d.cuerpo_hash),
  };
}

/** Lo que una persona tiene pendiente de firmar. Es lo que el guardia ve al
 *  entrar a marcar turno. */
export const porFirmarDe = (env, trabajadorId) =>
  buscar(env, 'v_documentos_generados?select=id,numero,titulo,plantilla_nombre,creado_en'
    + `&trabajador_id=eq.${entero(trabajadorId)}&estado=eq.por_firmar&order=creado_en.asc`);

// -------------------------------------------------------------------- firma
/**
 * Comprueba que lo que llegó sea de verdad un PNG y no otra cosa con nombre de
 * PNG. Es la misma regla con que se reciben los archivos de RRHH: el tipo que
 * declara el que sube se puede escribir a mano, los primeros bytes no. Importa
 * porque esta imagen después se muestra dentro del documento firmado.
 */
function revisarImagen(valor) {
  const texto = typeof valor === 'string' ? valor.trim() : '';
  const m = texto.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return { error: 'La firma no llegó como imagen PNG' };
  if (texto.length > MAX_FIRMA) return { error: 'La firma pesa demasiado' };
  let bytes;
  try {
    const bin = atob(m[1]);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return { error: 'La firma llegó dañada' };
  }
  const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  if (bytes.length < 100 || !PNG.every((b, i) => bytes[i] === b)) {
    return { error: 'La firma no es una imagen PNG válida' };
  }
  return { ok: true, imagen: texto };
}

/**
 * Registra una firma.
 *
 * `actor` dice quién está firmando y por qué camino:
 *   { rol:'trabajador', trabajador, origen:'asistencia', quien:'jgarridoh' }
 *   { rol:'empleador',  origen:'panel', quien:'vtorres' }
 */
export async function firmar(env, request, id, actor, cuerpo) {
  const d = await primero(env, `documentos_generados?select=*&id=eq.${entero(id)}`);
  if (!d) return { error: 'Ese documento no existe', status: 404 };
  if (d.estado === 'anulado') return { error: 'Ese documento está anulado', status: 409 };
  if (d.estado === 'firmado') return { error: 'Ese documento ya está firmado', status: 409 };

  const p = await primero(env,
    `plantillas_documento?select=firmantes,clase,tipo_documento&codigo=eq.${encodeURIComponent(d.plantilla)}`);
  const firmantes = (p?.firmantes || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!firmantes.includes(actor.rol)) {
    return { error: 'Este documento no lleva esa firma', status: 400 };
  }

  // El trabajador solo firma lo suyo. La sesión del libro de asistencia ya dice
  // quién es; esto es para que un id cambiado a mano en la llamada no sirva.
  if (actor.rol === 'trabajador') {
    if (!actor.trabajador || d.trabajador_id !== actor.trabajador.id) {
      return { error: 'Ese documento no es suyo', status: 403 };
    }
  }

  const img = revisarImagen(cuerpo.imagen);
  if (img.error) return { error: img.error, status: 400 };

  // Lo que la persona dice haber leído. Sin esta confirmación la firma es un
  // trazo en una pantalla: lo que hace que valga es que quien firma declare que
  // leyó el documento, y eso tiene que quedar escrito.
  if (cuerpo.leido !== true) {
    return { error: 'Falta confirmar que leyó el documento', status: 400 };
  }

  const ya = await primero(env,
    `firmas_documento?select=id&documento_id=eq.${d.id}&rol=eq.${encodeURIComponent(actor.rol)}`);
  if (ya) return { error: 'Esa firma ya está puesta', status: 409 };

  // La IP se guarda como huella, igual que en los contactos de la web. La
  // diferencia es que acá **no se borra a los dos días**: allá la huella sirve
  // para contar envíos de las últimas 24 horas y después estorba, y acá es
  // parte de poder reconstruir el acto de firmar años después.
  let huella = null;
  try {
    huella = await huellaDe(ipDe(request), env);
  } catch {
    // Que no se pueda calcular la huella no puede impedir una firma: lo que se
    // perdería es un dato de contexto, y lo que se ganaría es un contrato sin
    // firmar.
  }

  const nombre = actor.rol === 'trabajador'
    ? actor.trabajador.nombre
    : limpio(actor.nombre, 160) || actor.quien;
  const rut = actor.rol === 'trabajador'
    ? formatearRut(actor.trabajador.rut) || actor.trabajador.rut
    : limpio(actor.rut, 20);

  await insertar(env, 'firmas_documento', {
    documento_id: d.id,
    rol: actor.rol,
    nombre,
    rut,
    imagen: img.imagen,
    cuerpo_hash: d.cuerpo_hash,
    origen: actor.origen,
    quien: actor.quien,
    ip_huella: huella,
    // Tal como se presentó el navegador. Es lo que permite decir después
    // «se firmó desde un teléfono», que es parte de reconstruir el acto.
    agente: (request.headers.get('user-agent') || '').slice(0, 300) || null,
  });

  const firmas = await buscar(env, `firmas_documento?select=rol&documento_id=eq.${d.id}`);
  const puestas = new Set(firmas.map((f) => f.rol));
  const completo = firmantes.every((r) => puestas.has(r));
  if (completo) {
    await actualizar(env, `documentos_generados?id=eq.${d.id}`, { estado: 'firmado' });
  }

  await anotar(env, actor.quien, 'documento_generado', d.id,
    `firmó como ${actor.rol}`,
    `${d.numero} · ${nombre}${completo ? ' · quedó firmado por todas las partes' : ''}`);

  return {
    ok: true,
    completo,
    faltan: firmantes.filter((r) => !puestas.has(r)),
    estado: completo ? 'firmado' : 'por_firmar',
  };
}

// ------------------------------------------------------------------- anular
export async function anular(env, quien, id, motivo) {
  const d = await primero(env, `documentos_generados?select=*&id=eq.${entero(id)}`);
  if (!d) return { error: 'Ese documento no existe', status: 404 };
  if (d.estado === 'anulado') return { error: 'Ese documento ya está anulado', status: 409 };

  const razon = limpio(motivo, 300);
  if (!razon) return { error: 'Escriba por qué se anula', status: 400 };

  await actualizar(env, `documentos_generados?id=eq.${d.id}`, {
    estado: 'anulado', anulado_por: quien, anulado_en: new Date().toISOString(),
    anulado_motivo: razon,
  });
  // El documento no se borra y las firmas tampoco. Un documento firmado que se
  // anula es información: hubo un acto y después se dejó sin efecto, y las dos
  // cosas tienen que poder mirarse.
  await anotar(env, quien, 'documento_generado', d.id, 'anuló un documento',
    `${d.numero} · ${razon}`);
  return { ok: true };
}

// ----------------------------------------------------------------- archivar
/**
 * Deja el documento firmado como documento de esa persona, para que salga en
 * su ficha y en las alertas de RRHH junto a los demás papeles.
 *
 * Crea la fila; el PDF lo sube después la pantalla por la ruta que ya existe
 * (`POST /rrhh/documentos/:id/archivo`), que es la que mira la sesión y revisa
 * los bytes. No se armó un almacenamiento aparte a propósito: ya hay uno.
 */
export async function archivar(env, quien, id) {
  const d = await primero(env, `documentos_generados?select=*&id=eq.${entero(id)}`);
  if (!d) return { error: 'Ese documento no existe', status: 404 };
  if (d.estado !== 'firmado') {
    return { error: 'Todavía no está firmado por todas las partes', status: 409 };
  }
  if (!d.trabajador_id) {
    return { error: 'Este documento no es de una persona del registro, así que no se '
                    + 'archiva en una ficha. Se puede descargar en PDF cuando se quiera.',
             status: 409 };
  }
  if (d.documento_id) return { ok: true, documento_id: d.documento_id, ya_estaba: true };

  const p = await primero(env,
    `plantillas_documento?select=tipo_documento,nombre&codigo=eq.${encodeURIComponent(d.plantilla)}`);
  const tipo = p?.tipo_documento || 'otro';

  const [doc] = await insertar(env, 'documentos_trabajador', {
    trabajador_id: d.trabajador_id,
    contrato_id: d.contrato_id,
    tipo,
    glosa: `${p?.nombre || 'Documento'} N° ${d.numero}, firmado en el sistema`,
    numero: d.numero,
    fecha_emision: String(d.creado_en).slice(0, 10),
    creado_por: quien,
  });
  await actualizar(env, `documentos_generados?id=eq.${d.id}`, { documento_id: doc.id });
  await anotar(env, quien, 'documento_generado', d.id, 'archivó el documento firmado',
    `${d.numero} · quedó en la ficha como ${tipo}`);
  return { ok: true, documento_id: doc.id, tipo };
}

export { MAX_FIRMA };
