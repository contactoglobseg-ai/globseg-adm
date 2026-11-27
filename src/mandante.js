/**
 * La carpeta de cada trabajador para la empresa mandante.
 *
 * 27-11-2026, pedido de gerencia: las mandantes piden, por cada guardia que
 * entra a su obra, una ficha con sus datos y sus papeles (cédula, contrato,
 * exámenes, OS-10, IRL, EPP…). Antes eso se armaba a mano, archivo por
 * archivo. Ahora se marcan las personas y se baja un ZIP con una carpeta por
 * cada una: su ficha en PDF con el membrete de la empresa y sus documentos.
 *
 * El PDF y el ZIP se arman en el navegador (jsPDF y el ZIP sin comprimir que
 * ya usa Prevención). Acá solo se juntan los datos y se entregan los archivos.
 *
 * Quién lo puede usar: RRHH y Prevención (`documentos`). Por decisión de
 * gerencia la prevencionista baja **todos** los documentos de la persona,
 * contrato incluido, porque la mandante también lo pide. Lo que NO va en la
 * ficha es el sueldo, la cuenta bancaria ni la previsión: la mandante no los
 * necesita y la ficha sale de la empresa.
 */

import { buscar, primero } from './datos.js';
import * as arch from './archivos.js';

const MAX_PERSONAS = 200;

/** Lo que dice el encabezado del PDF. */
async function empresa(env) {
  const filas = await buscar(env, 'datos_empresa?select=codigo,valor');
  const e = Object.fromEntries(filas.map((f) => [f.codigo, f.valor]));
  return {
    razon_social: e.razon_social || '', nombre_fantasia: e.nombre_fantasia || '',
    rut: e.rut || '', domicilio: e.domicilio || '', telefono: e.telefono_oficina || '',
  };
}

/**
 * Datos de la ficha y lista de documentos vigentes de cada persona.
 * `ids` viene de la pantalla; se pasa por número y se acota.
 */
export async function fichas(env, ids) {
  const lista = [...new Set((ids || []).map((x) => Math.round(Number(x))).filter((x) => x > 0))]
    .slice(0, MAX_PERSONAS);
  if (!lista.length) return { error: 'Marque al menos una persona', status: 400 };
  const en = `in.(${lista.join(',')})`;

  const [personas, laboral, documentos, emp] = await Promise.all([
    buscar(env, 'trabajadores?select=id,nombre,rut,fecha_nacimiento,nacionalidad,estado_civil,'
      + `telefono,email,direccion,comuna,region,activo&id=${en}`),
    // De la vista, solo lo laboral: el sueldo está ahí y no se pide.
    buscar(env, 'v_personal?select=id,cargo,instalacion,fecha_ingreso,contrato_tipo,'
      + `contrato_desde,contrato_hasta,sin_contrato&id=${en}`),
    buscar(env, 'v_documentos?select=id,trabajador_id,tipo,tipo_nombre,tipo_grupo,numero,'
      + 'fecha_emision,fecha_vencimiento,estado,tiene_archivo,archivo_nombre,archivo_tipo,observacion'
      + `&trabajador_id=${en}&vigente=is.true&order=tipo_nombre.asc,fecha_vencimiento.desc.nullslast`),
    empresa(env),
  ]);

  const lab = new Map(laboral.map((l) => [l.id, l]));
  const docsDe = new Map();
  for (const d of documentos) {
    if (!docsDe.has(d.trabajador_id)) docsDe.set(d.trabajador_id, []);
    docsDe.get(d.trabajador_id).push(d);
  }
  const orden = new Map(lista.map((id, i) => [id, i]));
  return {
    empresa: emp,
    emitido_en: new Date().toISOString(),
    trabajadores: personas
      .sort((a, b) => orden.get(a.id) - orden.get(b.id))
      .map((p) => ({ ...p, ...(lab.get(p.id) || {}), id: p.id, documentos: docsDe.get(p.id) || [] })),
  };
}

/** El archivo de un documento de la persona, para meterlo al ZIP. */
export async function archivo(env, documentoId) {
  const d = await primero(env, 'documentos_trabajador?select=id,archivo_ruta,archivo_nombre,archivo_tipo'
    + `&id=eq.${Math.round(Number(documentoId)) || 0}`);
  if (!d?.archivo_ruta) return null;
  return { ...d, contenido: await arch.bajar(env, d.archivo_ruta) };
}
