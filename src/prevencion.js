/**
 * Documentos de prevención de riesgos: se sube el PDF y se manda a firmar.
 *
 * El caso que lo trajo: la prevencionista tiene que entregar el IRL —el
 * derecho a saber del DS 40 art. 21— a todo un turno, y que cada uno lo firme.
 * Hoy eso es un papel que se pasea en una carpeta y vuelve a medio firmar.
 *
 * El ciclo, que es lo que explica el resto del archivo:
 *
 *   1. La prevencionista elige el tipo de papel (IRL, RIOHS, entrega de EPP,
 *      charla, procedimiento de trabajo seguro, Ley Karin), **sube el PDF que
 *      ya tiene hecho** y marca a quiénes se lo manda.
 *   2. Se guarda **un** archivo y se crea **un documento por persona**, todos
 *      apuntando a él. El IRL se firma de a uno por ley; lo que se comparte es
 *      el papel, no la firma.
 *   3. Cada trabajador lo ve al entrar a marcar turno, lo lee hoja por hoja en
 *      el teléfono y firma con el dedo. Eso ya lo hace `documentos.js`: acá no
 *      se reescribió ni la firma ni la anulación.
 *   4. La copia sellada lleva la firma al pie de **todas las hojas**, que es lo
 *      que en papel se visa una por una, y una hoja final con el registro.
 *      Eso lo arma la pantalla, porque el PDF es una impresión y no el
 *      registro: el registro es el archivo original más las firmas.
 *
 * Tres cosas que este módulo se niega a hacer:
 *
 *  - **No acepta nada que no sea PDF.** Una foto no tiene hojas, y lo que el
 *    gerente pidió es la firma en todas. Un JPG entraría y después no se
 *    podría sellar, que es peor que rechazarlo ahora.
 *  - **No borra el archivo al anular un documento.** Es de los otros once del
 *    envío. El archivo suelto solo se puede sacar cuando se anula el envío
 *    entero, y eso todavía no existe: hoy queda ocupando espacio, que es más
 *    barato que dejar a once personas con un documento firmado sin su papel.
 *  - **No manda correos.** El trabajador lo ve donde ya entra todos los días.
 */

import { buscar, primero, insertar, anotar } from './datos.js';
import { siguientesNumeros } from './documentos.js';
import * as arch from './archivos.js';

export const MIGRACION = '20261102190000_prevencion.sql';

/** La plantilla que sirve de molde a todos éstos. Una sola: lo que cambia
 *  entre un IRL y una entrega de EPP es el tipo con que se archiva, no la
 *  forma del documento. */
export const PLANTILLA = 'prevencion_archivo';

/** De qué grupo de `tipos_documento` sale el catálogo. */
const GRUPO = 'prevencion';

export async function tablasListas(env) {
  try {
    await buscar(env,
      `plantillas_documento?select=codigo,fuente&codigo=eq.${PLANTILLA}&limit=1`);
    await buscar(env, 'documentos_generados?select=envio_id&limit=1');
    return true;
  } catch {
    return false;
  }
}

export const avisoMigracion = () =>
  'Falta aplicar la migración ' + MIGRACION + ' en el SQL Editor de Supabase. '
  + 'Mandar documentos de prevención a firmar no está disponible hasta que se '
  + 'aplique; el resto de Documentos funciona igual. Ver COMO-APLICAR-MIGRACIONES.md.';

/**
 * Los papeles de prevención que se pueden mandar.
 *
 * Salen de `tipos_documento`, que ya los tiene con su base legal y su
 * vencimiento desde el 15-10. Por eso el IRL archivado **vence solo a los doce
 * meses** y vuelve a salir en las alertas de RRHH sin que nadie lo programe.
 */
export const tipos = (env) =>
  buscar(env, 'tipos_documento?select=codigo,nombre,base_legal,vence,meses_validez'
    + `&grupo=eq.${GRUPO}&order=orden.asc`);

/** A quiénes se les puede mandar: los que están trabajando hoy. */
export const destinatarios = (env) =>
  buscar(env, 'v_personal?select=id,nombre,rut,cargo,instalacion,instalacion_id'
    + '&activo=is.true&order=nombre.asc');

const limpio = (v, max = 200) => {
  const t = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return t ? t.slice(0, max) : null;
};

/**
 * Manda el documento a firmar.
 *
 * `archivo` es `{ bytes, nombre }`. Todo lo demás llega en `datos`.
 */
export async function enviar(env, quien, { bytes, nombre }, datos) {
  // ------------------------------------------------------------- el papel
  if (!bytes || !bytes.length) return { error: 'No llegó ningún archivo', status: 400 };
  if (bytes.length > arch.MAX_BYTES) {
    return { error: `El archivo pesa más de ${Math.round(arch.MAX_BYTES / 1048576)} MB.`,
             status: 413 };
  }
  // Lo que el archivo es de verdad, por sus primeros bytes, no por lo que dijo
  // el navegador. Misma revisión que la de los documentos de RRHH.
  const reconocido = arch.reconocer(bytes);
  if (!reconocido || reconocido.tipo !== 'application/pdf') {
    return { error: 'El documento tiene que ser un PDF. Una foto o una imagen no tiene '
                    + 'hojas, y la firma va al pie de cada una. Si lo tiene en Word, '
                    + 'guárdelo como PDF.', status: 415 };
  }

  // -------------------------------------------------------------- el tipo
  const codigo = limpio(datos?.tipo, 40);
  const lista = await tipos(env);
  const tipo = lista.find((t) => t.codigo === codigo);
  if (!tipo) {
    return { error: 'Elija qué documento de prevención es. Los que el sistema conoce son: '
                    + lista.map((t) => t.nombre).join(', ') + '.', status: 400 };
  }

  // -------------------------------------------------------- los que firman
  const pedidos = Array.isArray(datos?.trabajadores)
    ? [...new Set(datos.trabajadores.map((n) => Number(n)).filter(Number.isInteger))]
    : [];
  if (!pedidos.length) return { error: 'No marcó a nadie', status: 400 };

  const gente = await buscar(env,
    `trabajadores?select=id,nombre,rut,activo&id=in.(${pedidos.join(',')})`);
  const activos = gente.filter((t) => t.activo !== false);
  // Quién quedó fuera se dice con nombre, no se cuenta. Una persona que
  // desaparece del envío sin aviso es una persona que no firmó el IRL y nadie
  // se enteró hasta la fiscalización.
  const omitidos = [
    ...pedidos.filter((id) => !gente.some((t) => t.id === id))
              .map((id) => ({ id, motivo: 'no está en el registro' })),
    ...gente.filter((t) => t.activo === false)
            .map((t) => ({ id: t.id, nombre: t.nombre, motivo: 'está de baja' })),
  ];
  if (!activos.length) {
    return { error: 'Ninguna de las personas marcadas puede recibir el documento', status: 409,
             omitidos };
  }

  // ------------------------------------------------------------- el envío
  const envio = [...crypto.getRandomValues(new Uint8Array(12))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const ruta = arch.rutaPrevencion(envio, 'pdf');
  const nombreArchivo = arch.nombreSeguro(nombre || '', 'pdf');
  // El hash es de los bytes del PDF, no de un texto: acá no hay cuerpo que
  // resumir. Es lo que cada firma guarda, y lo que deja decir después que el
  // papel firmado es el mismo que está guardado.
  const hash = await arch.hashBytes(bytes);
  const paginas = Number.isInteger(Number(datos?.paginas)) && Number(datos.paginas) > 0
    ? Number(datos.paginas) : null;
  const nota = limpio(datos?.nota, 300);

  await arch.subir(env, ruta, bytes, reconocido.tipo);

  const numeros = await siguientesNumeros(env, activos.length);
  const filas = activos.map((t, i) => ({
    numero: numeros[i],
    plantilla: PLANTILLA,
    titulo: `${tipo.nombre} — ${t.nombre}`,
    trabajador_id: t.id,
    tipo_documento: tipo.codigo,
    envio_id: envio,
    firma_todas_hojas: true,
    archivo_ruta: ruta,
    archivo_nombre: nombreArchivo,
    archivo_tipo: reconocido.tipo,
    archivo_bytes: bytes.length,
    archivo_paginas: paginas,
    cuerpo: null,
    cuerpo_hash: hash,
    // Lo que se usó, tal como estaba ese día. La base legal se congela acá
    // porque es lo que la hoja de registro del PDF imprime, y el catálogo se
    // puede corregir el año que viene.
    datos: {
      tipo: tipo.codigo, tipo_nombre: tipo.nombre, base_legal: tipo.base_legal || null,
      archivo: nombreArchivo, paginas, nota,
    },
    por_confirmar: null,
    creado_por: quien,
  }));

  let creados;
  try {
    creados = await insertar(env, 'documentos_generados', filas);
  } catch (e) {
    // Si no se pudo escribir ninguna fila, el archivo recién subido no lo
    // apunta nadie: se saca, o queda ocupando espacio para siempre. Es el
    // mismo orden que la subida de documentos de RRHH.
    await arch.borrar(env, ruta).catch(() => {});
    throw e;
  }

  await anotar(env, quien, 'envio_prevencion', null, 'mandó a firmar un documento de prevención',
    `${tipo.nombre} · ${activos.length} ${activos.length === 1 ? 'persona' : 'personas'}`
    + ` · ${nombreArchivo}`
    + (omitidos.length ? ` · quedaron fuera: ${omitidos.map((o) => o.nombre || o.id).join(', ')}` : ''));

  return {
    envio_id: envio,
    tipo: tipo.codigo,
    tipo_nombre: tipo.nombre,
    enviados: creados.length,
    documentos: creados.map((d) => ({ id: d.id, numero: d.numero, titulo: d.titulo })),
    omitidos,
  };
}

/** Los envíos, con en qué va cada uno. */
export const listarEnvios = (env) =>
  buscar(env, 'v_envios_prevencion?select=*&order=creado_en.desc&limit=200');

/** Quiénes firmaron y quiénes no, de un envío. Es la pregunta que de verdad se
 *  le hace a esto antes de una fiscalización. */
export const verEnvio = (env, envioId) =>
  buscar(env, 'v_documentos_generados?select=*'
    + `&envio_id=eq.${encodeURIComponent(String(envioId).slice(0, 40))}`
    + '&order=trabajador.asc');
