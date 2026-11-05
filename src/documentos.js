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
import { hoyISO, esFecha, sumarMeses } from './fechas.js';
import { armar, faltantes, explicarFaltantes, hash,
         datosLaborales, datosArriendo, datosAnexo, datosFiniquito,
         CAUSALES_SIN_FINIQUITO } from './plantillas.js';
import { editarContrato, CAUSALES, parametros, saldoFeriado,
         calcularFiniquito, valor } from './rrhh.js';
import { ipDe, huellaDe } from './limite.js';
import { formatearRut } from './rut.js';

export const MIGRACION = '20261020180000_documentos_firma.sql';
/** La del anexo que dice qué cambia. Si falta, el anexo sigue andando como
 *  antes del 04-11-2026 —repitiendo lo que el contrato ya decía— y la pantalla
 *  lo dice con el nombre del archivo en vez de ofrecer un formulario que el
 *  servidor va a ignorar. */
export const MIGRACION_ANEXO = '20261104180000_anexo_cambios.sql';
/** La del finiquito que se firma. Si falta, la plantilla sencillamente no
 *  existe y no sale en el desplegable; el cálculo estimado de Sueldos sigue
 *  andando igual, que es lo que había hasta el 05-11-2026. */
export const MIGRACION_FINIQUITO = '20261105120000_finiquito_documento.sql';

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
    //
    // Las de `fuente` 'archivo' no salen acá: no se arman desde una plantilla,
    // se sube el PDF hecho. Ofrecerlas en el formulario de generar daría un
    // documento vacío, que es peor que no ofrecerlas. Viven en su propia
    // sección (ver src/prevencion.js).
    plantillas: plantillas.filter((p) => (p.fuente || 'texto') === 'texto')
                          .map(({ cuerpo, ...resto }) => resto),
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

// ------------------------------------------------------------- qué cambia
/**
 * Las condiciones del contrato que un anexo puede modificar.
 *
 * Son cuatro y no todas las columnas del contrato a propósito. Lo que un anexo
 * modifica de verdad en esta empresa es dónde trabaja la persona, qué hace,
 * cuánto gana y en qué turno; el resto —el tipo de contrato, la causal de
 * término, la resolución de la Dirección del Trabajo— o es otro documento o es
 * una corrección de lo que estaba mal escrito, que se hace con «Corregir» en
 * la ficha y queda en la bitácora. Mezclar las dos cosas haría que una errata
 * se arreglara con un papel firmado por el trabajador.
 *
 * Lo que no esté acá se escribe en la cláusula libre, que no toca la base.
 */
export const CAMBIOS_ANEXO = {
  instalacion_id: 'instalación',
  cargo: 'cargo',
  sueldo_base: 'sueldo base',
  turno: 'turno',
};

/**
 * Comprueba lo que la oficina dice que cambia, contra lo que el contrato dice
 * hoy. Devuelve solo lo que de verdad cambia.
 *
 * La regla que se niega a saltarse: **un anexo que no modifica nada se
 * rechaza**. Un documento que el trabajador firma diciendo que a contar de tal
 * fecha pasa al mismo parque, con el mismo cargo y el mismo sueldo, no es un
 * papel inútil: es un papel que parece decir algo y no dice nada, y dentro de
 * dos años nadie va a saber qué se acordó ese día.
 */
async function revisarCambios(env, contrato, campos) {
  if (!contrato) {
    return { error: 'Un anexo modifica un contrato, y esta persona no tiene ninguno '
                    + 'cargado. Cárguelo primero en Personas → Fichas.', status: 409 };
  }
  if (contrato.estado !== 'vigente') {
    return { error: 'Ese contrato ya no está vigente: no se modifica con un anexo. '
                    + 'Lo que corresponde es cargar un contrato nuevo.', status: 409 };
  }

  const rige = esFecha(campos.rige_desde) ? campos.rige_desde : null;
  if (!rige) {
    return { error: 'Falta desde cuándo rige el cambio. Es la fecha que el anexo repite '
                    + 'en cada cláusula, y no es la de hoy: puede ser el lunes que viene.',
             status: 400 };
  }
  if (rige < contrato.fecha_inicio) {
    return { error: `El cambio no puede regir antes del ${contrato.fecha_inicio}, que es `
                    + 'cuando empieza el contrato que se modifica.', status: 400 };
  }

  const cambios = { rige_desde: rige };
  let nueva = null;
  const avisos = [];

  const puesto = (k) => campos[k] !== undefined && campos[k] !== null && campos[k] !== '';

  if (puesto('instalacion_id')) {
    const id = entero(campos.instalacion_id);
    nueva = id ? await primero(env, `instalaciones?select=*&id=eq.${id}`) : null;
    if (!nueva) return { error: 'Esa instalación no está en el catálogo', status: 404 };
    if (id === contrato.instalacion_id) {
      return { error: `El contrato ya dice ${nueva.nombre}. Un anexo que deja el lugar de `
                      + 'trabajo como estaba no modifica nada.', status: 409 };
    }
    cambios.instalacion_id = id;
    // La calle de cada instalación la mantiene operaciones y hoy muchas están
    // vacías. El anexo sale igual, con la comuna y la región, y se dice: un
    // documento firmado que no se puede generar es peor que uno que nombra el
    // lugar con menos detalle del que uno quisiera.
    if (!nueva.direccion) {
      avisos.push(`${nueva.nombre} no tiene calle y número cargados, así que el anexo `
        + 'nombra el lugar con la comuna y la región. Se completa en Instalaciones.');
    }
  }

  if (puesto('cargo')) {
    const cargo = limpio(campos.cargo, 60);
    if (!cargo) return { error: 'El cargo nuevo quedó vacío', status: 400 };
    if (cargo === contrato.cargo) {
      return { error: `El contrato ya dice «${cargo}»: eso no es un cambio de cargo.`,
               status: 409 };
    }
    cambios.cargo = cargo;
  }

  if (puesto('sueldo_base')) {
    // Los puntos se sacan antes: un sueldo se teclea «553.553» y `entero`
    // leería eso como un decimal y devolvería null. Es el mismo tropiezo del
    // precio unitario de las cotizaciones, donde «3.500.000» quedaba en 3,5.
    const sueldo = entero(String(campos.sueldo_base).replace(/\./g, ''));
    if (sueldo === null || sueldo <= 0) {
      return { error: 'El sueldo base nuevo tiene que ser un monto en pesos', status: 400 };
    }
    if (sueldo === contrato.sueldo_base) {
      return { error: 'El sueldo base nuevo es el mismo que ya tiene el contrato', status: 409 };
    }
    cambios.sueldo_base = sueldo;
  }

  if (puesto('turno')) {
    const turno = limpio(campos.turno, 80);
    if (!turno) return { error: 'El turno nuevo quedó vacío', status: 400 };
    if (turno === contrato.turno) {
      return { error: `El contrato ya dice «${turno}»: eso no es un cambio de turno.`,
               status: 409 };
    }
    cambios.turno = turno;
  }

  const otra = limpio(campos.otra_glosa, 800);
  if (otra) cambios.otra_glosa = otra;

  if (!Object.keys(cambios).some((k) => k in CAMBIOS_ANEXO) && !otra) {
    return { error: 'Marque al menos una cosa que cambia. Un anexo que no modifica nada '
                    + 'es un documento firmado que no dice nada.', status: 400 };
  }

  return { cambios, rige, nueva, aviso: avisos.join(' ') || null };
}

/** Lo que modifica un anexo, en palabras, para la pantalla y la bitácora. */
export const resumirCambios = (cambios) => {
  const partes = Object.keys(CAMBIOS_ANEXO).filter((k) => k in (cambios || {}))
    .map((k) => CAMBIOS_ANEXO[k]);
  if (cambios?.otra_glosa) partes.push('una cláusula escrita a mano');
  return partes.join(', ');
};

/**
 * Lleva al contrato lo que el anexo modifica.
 *
 * Por qué es un botón y no algo que pase solo al generar: el anexo puede
 * quedarse sin firmar, puede anularse, y sobre todo **puede regir desde el
 * lunes que viene**. Quien decide cuándo el sistema da por hecho el traslado
 * es la oficina, no el papel.
 *
 * Por qué existe: un anexo firmado dice que desde el día tal la persona
 * trabaja en otro parque. Si eso no llega al contrato, el estado de pago de
 * ese mes, el recorte del F30-1 y la rotación de patrullas la siguen contando
 * donde ya no está, y nadie se entera hasta que el mandante reclama. Antes de
 * esto el único camino era acordarse de ir a «Corregir» el contrato a mano.
 *
 * No escribe la fecha desde la que rige en ninguna parte del contrato, porque
 * el contrato no guarda historia: guarda cómo están las cosas hoy. La historia
 * es el anexo, que queda con su texto congelado y sus firmas, y la bitácora,
 * que anota qué decía antes cada campo.
 */
export async function aplicarCambios(env, quien, id) {
  const d = await primero(env, `documentos_generados?select=*&id=eq.${entero(id)}`);
  if (!d) return { error: 'Ese documento no existe', status: 404 };
  if (d.estado === 'anulado') {
    return { error: 'Ese anexo está anulado: no se lleva al contrato', status: 409 };
  }

  const cambios = d.datos?.cambios;
  if (!cambios || !Object.keys(cambios).some((k) => k in CAMBIOS_ANEXO)) {
    return { error: 'Este documento no modifica condiciones del contrato', status: 409 };
  }
  if (d.aplicado_en) {
    return { ok: true, ya_estaba: true, aplicado_en: d.aplicado_en,
             aplicado_por: d.aplicado_por };
  }
  if (!d.contrato_id) {
    return { error: 'Este anexo no quedó amarrado a un contrato', status: 409 };
  }

  // Solo las cuatro condiciones. `otra_glosa` y `rige_desde` viven en el texto
  // del anexo y no son columnas del contrato: meterlas acá escribiría en la
  // ficha una frase que nadie va a volver a mirar.
  const patch = {};
  for (const campo of Object.keys(CAMBIOS_ANEXO)) {
    if (campo in cambios) patch[campo] = cambios[campo];
  }

  // Pasa por la misma puerta que «Corregir» en la ficha: revisa la ley, deja
  // cada campo en la bitácora con lo que decía antes, y pone al día el cargo y
  // la instalación de la persona. Escribir el `update` acá habría sido una
  // segunda forma de modificar un contrato, que se separa de la primera el día
  // que una de las dos cambie.
  const r = await editarContrato(env, quien, d.contrato_id, patch);
  if (r.error) return { error: r.error, status: r.status || 409 };

  // La instalación cambia de id y así es como queda escrita: «instalación:
  // 2 → 1», que no se lo puede leer nadie. Esto lo lee la oficina en la
  // pantalla y, sobre todo, queda en la bitácora, que es donde dentro de un
  // año alguien va a buscar de dónde a dónde se movió esta persona.
  const quedaron = r.cambios || [];
  const dosIds = quedaron.filter((x) => x.campo === 'instalacion_id');
  if (dosIds.length) {
    const ids = dosIds.flatMap((x) => [x.antes, x.despues])
      .map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
    const filas = ids.length
      ? await buscar(env, `instalaciones?select=id,nombre&id=in.(${ids.join(',')})`) : [];
    const nombre = new Map(filas.map((f) => [String(f.id), f.nombre]));
    for (const x of dosIds) {
      x.antes = nombre.get(String(x.antes)) || x.antes;
      x.despues = nombre.get(String(x.despues)) || x.despues;
    }
  }

  await actualizar(env, `documentos_generados?id=eq.${d.id}`, {
    aplicado_en: new Date().toISOString(), aplicado_por: quien,
  });
  await anotar(env, quien, 'documento_generado', d.id,
    'llevó el anexo al contrato',
    `${d.numero} · ` + quedaron.map((x) => `${x.rotulo}: ${x.antes} → ${x.despues}`)
      .join(' · ').slice(0, 900));

  return { ok: true, cambios: quedaron, avisos: r.avisos || [] };
}

// ------------------------------------------------------------- el finiquito
/**
 * Revisa lo que se pidió y recalcula el finiquito.
 *
 * Los montos **no vienen de la pantalla**. Vienen de `calcularFiniquito`, el
 * mismo que alimenta la pestaña Sueldos → Finiquito, corrido acá otra vez con
 * la causal y la fecha que se pidieron. La pantalla y el documento coinciden
 * porque hacen la misma cuenta con los mismos datos, no porque uno le crea al
 * otro: si los montos llegaran en el cuerpo del pedido, cualquiera con sesión
 * podría firmar un finiquito por la cifra que quisiera.
 */
async function revisarFiniquito(env, { trabajador, contrato, campos }) {
  const causal = limpio(campos.causal, 20);
  if (!causal || !CAUSALES[causal]) {
    return { error: 'Falta la causal de término del contrato', status: 400 };
  }
  if (CAUSALES_SIN_FINIQUITO[causal]) {
    return { error: CAUSALES_SIN_FINIQUITO[causal], status: 409 };
  }
  // El 160 es diez causales distintas en un solo código, y la invocación vale
  // por el numeral y por los hechos. «Causales del art. 160» a secas, dentro
  // de un documento firmado, es lo que después se objeta entero.
  if (causal === '160' && !limpio(campos.causal_detalle, 1000)) {
    return { error: 'Con una causal del artículo 160 hay que escribir el numeral y los hechos '
                    + 'en que se funda. Un finiquito que solo dice «artículo 160» no identifica '
                    + 'la causal que se invocó.', status: 400 };
  }

  const fechaTermino = esFecha(campos.fecha_termino) ? campos.fecha_termino
    : (contrato.termino_fecha || null);
  if (!fechaTermino) return { error: 'Falta la fecha de término', status: 400 };
  if (fechaTermino < contrato.fecha_inicio) {
    return { error: 'La fecha de término es anterior al inicio del contrato', status: 400 };
  }
  if (fechaTermino > hoyISO()) {
    return { error: 'La fecha de término todavía no llega. Un finiquito se firma por una '
                    + 'relación laboral que ya terminó.', status: 400 };
  }

  const p = await parametros(env, fechaTermino);
  const ausencias = await buscar(env,
    `ausencias?select=tipo,desde,dias_habiles,estado&trabajador_id=eq.${trabajador.id}`);

  const finiquito = calcularFiniquito({
    trabajador, contrato, causal, fechaTermino,
    avisoDado: campos.aviso_dado === true,
    baseManual: entero(campos.base),
    saldo: saldoFeriado(trabajador, ausencias, fechaTermino),
    p, uf: Number(campos.uf) || valor(p, 'uf', 0) || null,
  });
  if (finiquito.error) return { error: finiquito.error, status: 400 };

  const datos = datosFiniquito({
    finiquito, contrato, trabajador,
    campos: {
      causal_detalle: limpio(campos.causal_detalle, 1000),
      reserva: limpio(campos.reserva, 1000),
      cotizaciones_hasta: limpio(campos.cotizaciones_hasta, 7),
      forma_pago: limpio(campos.forma_pago, 20),
      otros: sumas(campos.otros),
      descuentos: sumas(campos.descuentos),
    },
  });

  // Un finiquito que no paga nada no dice nada, igual que un anexo que no
  // modifica nada. Pasa de verdad —una renuncia con el feriado al día— y la
  // salida no es emitir un papel con el total en cero: es que la oficina
  // agregue lo que el cálculo no conoce, que casi siempre son los días
  // trabajados del último mes.
  if (!datos.detalle_pagos) {
    return { error: 'El cálculo no arroja ninguna suma que pagar y no se agregó ninguna otra. '
                    + 'La causal elegida no da derecho a indemnización y no hay feriado '
                    + 'pendiente. Agregue las sumas que correspondan —la remuneración de los '
                    + 'días trabajados del último mes, por ejemplo— o revise la causal y la '
                    + 'fecha de término.', status: 409 };
  }

  // Lo que el cálculo usó y nadie ha confirmado, más sus propias notas. Queda
  // copiado dentro del documento: el que lo abra el año que viene tiene que
  // poder ver con qué tope de UF se calculó sin depender de que alguien se
  // acuerde de la pantalla donde lo leyó.
  const aviso = [
    ...finiquito.por_confirmar.map((x) => `${x.glosa || x.codigo} = ${x.valor}.`),
    ...finiquito.notas,
  ].join(' ') || null;

  return { finiquito: { ...finiquito, pagos: datos.finiquito_pagos,
                        descuentos: datos.finiquito_descuentos,
                        total_documento: datos.finiquito_total },
           datos, aviso };
}

/** Las sumas que escribe la oficina, limpiadas. Se topan en seis: una lista
 *  larga dentro de un finiquito es un libro de remuneraciones, y lo que se
 *  firma tiene que caber en una lectura. */
function sumas(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((x) => ({ glosa: limpio(x?.glosa, 120), monto: entero(x?.monto) }))
    .filter((x) => x.glosa && x.monto > 0)
    .slice(0, 6);
}

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
  // Lo que este documento modifica del contrato, ya comprobado. Queda guardado
  // dentro de `datos` para que después se pueda llevar al contrato sin volver
  // a preguntarle nada a nadie: lo que se firmó es lo que se aplica.
  let cambios = null;
  let avisoCambio = null;
  // El cálculo del finiquito, si esta plantilla es uno. Se guarda dentro de
  // `datos` igual que los cambios del anexo: el documento tiene que poder
  // explicarse solo el año que viene, sin volver a calcular nada.
  let finiquito = null;
  let avisoFiniquito = null;

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
    // Un finiquito se emite, casi siempre, con el contrato ya cerrado: la
    // oficina registra el término y después hace el papel. Buscar solo el
    // vigente dejaba el documento imposible de generar justo en el caso
    // normal, que es el que el gerente se encontró el 04-11-2026.
    //
    // El desempate por `id` no es un adorno. Cargar un contrato nuevo cierra
    // el anterior poniéndole de término **el día antes de que empiece el
    // nuevo**, así que los dos quedan con la MISMA fecha de inicio cuando el
    // nuevo se cargó para corregir al viejo. Sin `id.desc` cuál vuelve lo
    // decide Postgres, y el finiquito podía salir con el sueldo y la jornada
    // del contrato equivocado. Se vio en la ficha de un trabajador real el
    // 05-11-2026: dos contratos, los dos desde el 07-08-2026.
    if (!contrato && p.usa_finiquito) {
      contrato = await primero(env,
        `contratos?select=*&trabajador_id=eq.${trabajador.id}`
        + '&order=fecha_inicio.desc,id.desc');
    }
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

    // Un anexo no se arma con lo que el contrato dice hoy: se arma con lo que
    // cambia. Por eso acá se reemplazan el cargo, el sueldo y el lugar de
    // trabajo por los nuevos, y las cláusulas que no cambian desaparecen del
    // texto. Hasta el 04-11-2026 el anexo repetía lo que el contrato ya decía,
    // con la fecha de inicio del contrato en vez de la del cambio, así que el
    // de un traslado salía afirmando un reajuste de sueldo que no existió.
    if (p.cambia_contrato) {
      const r = await revisarCambios(env, contrato, cuerpo.campos || {});
      if (r.error) return r;
      cambios = r.cambios;
      avisoCambio = r.aviso;
      datos = { ...datos, ...datosAnexo({
        contrato, anterior: instalacion, nueva: r.nueva, cambios, rigeDesde: r.rige }) };
      datos.cambios = cambios;
    }

    // Los montos del finiquito se recalculan acá. La pantalla ya los mostró,
    // pero no se le creen: manda la causal y la fecha, no las cifras.
    if (p.usa_finiquito) {
      const r = await revisarFiniquito(env, { trabajador, contrato, campos: cuerpo.campos || {} });
      if (r.error) return r;
      finiquito = r.finiquito;
      datos = { ...datos, ...r.datos };
      avisoFiniquito = r.aviso;
    }

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
    avisoCambio,
    avisoFiniquito,
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
    // Qué modifica, en palabras, para que la pantalla lo diga antes de generar
    // y el que abre el documento el año que viene no tenga que leerlo entero.
    cambios: cambios || null,
    cambios_resumen: cambios ? resumirCambios(cambios) : null,
    // El desglose, para que la pantalla muestre los mismos números que el
    // texto sin volver a sumarlos por su cuenta.
    finiquito: finiquito || null,
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
  return (await siguientesNumeros(env, 1))[0];
}

/**
 * Los `cuantos` correlativos que siguen.
 *
 * Un envío de prevención saca doce documentos de una vez y los doce necesitan
 * su número. Se pide el último una sola vez y se cuentan desde ahí: pedirlo
 * doce veces daría doce veces el mismo, porque ninguno está grabado todavía.
 * La columna es única, así que si dos personas envían en el mismo segundo la
 * segunda inserción falla y se vuelve a intentar: no quedan dos documentos con
 * el mismo número.
 */
export async function siguientesNumeros(env, cuantos) {
  const anio = hoyISO().slice(0, 4);
  const ultima = await primero(env,
    `documentos_generados?select=numero&numero=like.${anio}-*&order=numero.desc`);
  const desde = ultima ? Number(ultima.numero.split('-')[1]) + 1 : 1;
  return Array.from({ length: cuantos },
    (_, i) => `${anio}-${String(desde + i).padStart(4, '0')}`);
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
    primero(env, 'plantillas_documento?select=nombre,clase,firmantes,fuente'
                 + `&codigo=eq.${encodeURIComponent(d.plantilla)}`),
    buscar(env, `firmas_documento?select=*&documento_id=eq.${d.id}&order=firmado_en.asc`),
  ]);
  // La ruta dentro del bucket no viaja a la pantalla. No es un secreto —el
  // bucket es privado y solo el Worker lo abre— pero tampoco es asunto de
  // nadie afuera: lo que la pantalla necesita saber es que hay archivo y que
  // se pide por /documentos/:id/archivo.
  const { archivo_ruta, ...resto } = d;
  return {
    ...resto,
    tiene_archivo: !!archivo_ruta,
    plantilla_nombre: p?.nombre ?? d.plantilla,
    clase: p?.clase ?? 'general',
    // Qué modifica del contrato, si es un anexo. La pantalla lo usa para
    // ofrecer llevarlo al contrato y para decir si eso ya se hizo.
    cambios: d.datos?.cambios || null,
    cambios_resumen: d.datos?.cambios ? resumirCambios(d.datos.cambios) : null,
    fuente: p?.fuente ?? 'texto',
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
  // El tipo elegido al enviar manda sobre el de la plantilla. En prevención la
  // plantilla es una sola y el tipo lo eligió la prevencionista: si se tomara
  // el de la plantilla, un IRL se archivaría como «otro» y no volvería a salir
  // en las alertas de RRHH a los doce meses, que es la mitad de para qué sirve
  // archivarlo.
  const tipo = d.tipo_documento || p?.tipo_documento || 'otro';

  // Cuándo vuelve a hacer falta. El catálogo ya lo dice —el IRL del DS 40
  // vence a los doce meses— y si no se escribe acá, el documento queda
  // archivado para siempre y nunca vuelve a salir en las alertas de RRHH, que
  // es la mitad de para qué se archiva. Misma cuenta que la carga masiva.
  const td = await primero(env,
    `tipos_documento?select=nombre,vence,meses_validez&codigo=eq.${encodeURIComponent(tipo)}`);
  const emision = String(d.creado_en).slice(0, 10);
  const vence = td?.vence && td?.meses_validez
    ? sumarMeses(emision, Number(td.meses_validez)) : null;

  const [doc] = await insertar(env, 'documentos_trabajador', {
    trabajador_id: d.trabajador_id,
    contrato_id: d.contrato_id,
    tipo,
    glosa: `${td?.nombre || p?.nombre || 'Documento'} N° ${d.numero}, firmado en el sistema`,
    numero: d.numero,
    fecha_emision: emision,
    fecha_vencimiento: vence,
    creado_por: quien,
  });
  await actualizar(env, `documentos_generados?id=eq.${d.id}`, { documento_id: doc.id });
  await anotar(env, quien, 'documento_generado', d.id, 'archivó el documento firmado',
    `${d.numero} · quedó en la ficha como ${tipo}`);
  return { ok: true, documento_id: doc.id, tipo };
}

export { MAX_FIRMA, CAUSALES_SIN_FINIQUITO };
