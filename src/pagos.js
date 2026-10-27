/**
 * Estados de pago por instalación y remuneraciones del mes.
 *
 * El problema real, dicho por el gerente: el mandante no paga contra la
 * factura, paga contra una carpeta. Esa carpeta lleva, por instalación y por
 * mes, el libro de asistencia, el libro de remuneraciones, las liquidaciones,
 * el F30 y el F30-1. Hoy se arma a mano, y lo que se atrasa no es el papeleo:
 * es el cobro.
 *
 * Tres decisiones que explican la forma de este módulo:
 *
 * 1. **La liquidación se congela.** Hasta hoy se calculaba al vuelo y no se
 *    guardaba: sirve para estimar y no para respaldar. El libro de
 *    remuneraciones que recibe el mandante tiene que seguir diciendo lo mismo
 *    cuando cambien la UF, el sueldo o el contrato. Por eso
 *    `remuneraciones_mes` guarda la liquidación entera (`detalle`) y no los
 *    datos con que se calculó.
 * 2. **La instalación se congela también.** Un estado de pago es por
 *    instalación; si la persona se traslada en noviembre, el de octubre tiene
 *    que seguir saliendo donde trabajó.
 * 3. **Borrador y cerrado.** Mientras está en borrador se recalcula y se
 *    corrigen las horas extra y los anticipos. Al cerrar deja de recalcularse:
 *    desde ahí lo que vale es lo que se le dijo al mandante y a la persona.
 */

import { buscar, primero, insertar, actualizar, anotar, ErrorDatos } from './datos.js';
import * as rrhh from './rrhh.js';
import { hoyISO } from './fechas.js';
import { formatearRut, normalizarRut } from './rut.js';

export const FALTA_MIGRACION =
  'Falta aplicar la migración supabase/migrations/20261027120000_estados_pago.sql';

export const CLASES = {
  libro_asistencia:     'Libro de asistencia',
  libro_remuneraciones: 'Libro de remuneraciones',
  liquidaciones:        'Liquidaciones',
  f30:                  'F30 · Certificado de antecedentes laborales y previsionales',
  f30_1:                'F30-1 · Certificado de cumplimiento de obligaciones',
  previred:             'Planilla Previred',
  factura:              'Factura',
  otro:                 'Otro documento',
};

export const ESTADOS = ['armando', 'enviado', 'aprobado', 'pagado'];

const esMes = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v ?? ''));
const entero = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : null; };
const limpio = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };

/** Último día del mes, que es con el que se piden los parámetros vigentes. */
const cierreDe = (mes) => `${mes}-${new Date(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)
  .getDate().toString().padStart(2, '0')}`;

/**
 * ¿Están las tablas? Igual que en activos.js: el módulo degrada con un aviso
 * que nombra el archivo, en vez de reventar, porque acá una migración no se
 * aplica sola.
 */
export async function tablasListas(env) {
  try {
    await buscar(env, 'estados_pago?select=id&limit=1');
    await buscar(env, 'remuneraciones_mes?select=id&limit=1');
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ remuneraciones

/**
 * La dotación de una instalación en un mes: quién tenía contrato vigente ahí.
 *
 * La instalación sale de la ficha del trabajador, que es donde la asigna
 * operaciones. Si alguien no la tiene asignada no aparece en ningún estado de
 * pago, y eso **se dice** en vez de dejarlo pasar: una persona sin instalación
 * es una persona que no se le cobra a nadie.
 */
export async function dotacion(env, { mes, instalacion_id }) {
  const trabajadores = await buscar(env,
    'trabajadores?select=id,nombre,rut,instalacion_id,banco,cuenta_tipo,cuenta_numero,correo,'
    + 'afp,salud_sistema,salud_isapre,salud_plan_uf,jubilado,apv_monto,activo'
    + '&activo=is.true&order=nombre.asc');
  const dentro = instalacion_id
    ? trabajadores.filter((t) => t.instalacion_id === instalacion_id)
    : trabajadores;
  return { trabajadores: dentro, sin_instalacion: trabajadores.filter((t) => !t.instalacion_id) };
}

/**
 * Todo lo que el cálculo necesita, en un viaje: parámetros del mes, AFPs,
 * tramos de impuesto, contratos vigentes y cargas familiares.
 *
 * Va en una sola pasada y no una consulta por persona porque el Worker tiene
 * tiempo de CPU contado y una dotación de cincuenta guardias son cincuenta
 * liquidaciones.
 */
async function insumos(env, mes, ids) {
  const enIds = ids.length ? `(${ids.join(',')})` : '(0)';
  const [p, afps, tramos, contratos, cargas] = await Promise.all([
    rrhh.parametros(env, cierreDe(mes)),
    buscar(env, 'afps?select=*'),
    buscar(env, 'tramos_impuesto?select=*&order=tramo.asc'),
    buscar(env, `contratos?select=*&trabajador_id=in.${enIds}&order=fecha_inicio.desc`),
    buscar(env, `cargas_familiares?select=*&trabajador_id=in.${enIds}`).catch(() => []),
  ]);
  return { p, afps, tramos, contratos, cargas };
}

/** El contrato que corresponde a ese mes: el vigente, o el último que hubo. */
function contratoDe(contratos, id, mes) {
  const suyos = contratos.filter((c) => c.trabajador_id === id);
  return suyos.find((c) => c.estado === 'vigente')
      || suyos.find((c) => (c.fecha_inicio || '') <= cierreDe(mes))
      || suyos[0] || null;
}

function liquidacionDe({ t, contrato, ins, mes, extra }) {
  const uf = rrhh.valor(ins.p, 'uf', 0) || null;
  const utm = rrhh.valor(ins.p, 'utm', 0) || null;
  const afp = t.afp ? ins.afps.find((a) => a.nombre === t.afp) : null;
  const cargas = rrhh.cargasQueCorresponden(
    ins.cargas.filter((c) => c.trabajador_id === t.id), cierreDe(mes));
  return rrhh.liquidar({
    contrato, trabajador: t, p: ins.p, afp, uf, utm, cargas,
    extra: { ...extra, tramos: ins.tramos },
  });
}

/**
 * Calcula (o recalcula) el mes de una instalación y lo deja en borrador.
 *
 * Lo ya cerrado **no se toca**, y se dice cuántas filas se dejaron quietas:
 * recalcular en silencio un mes que ya se le mandó al mandante es cambiarle
 * las cifras por detrás.
 */
export async function calcularMes(env, quien, { mes, instalacion_id }) {
  if (!esMes(mes)) return { error: 'Falta el mes (AAAA-MM)', status: 400 };
  const inst = entero(instalacion_id);
  if (!inst) return { error: 'Falta la instalación', status: 400 };

  const { trabajadores } = await dotacion(env, { mes, instalacion_id: inst });
  if (!trabajadores.length) {
    return { error: 'Esa instalación no tiene a nadie asignado en la ficha', status: 409 };
  }
  const ids = trabajadores.map((t) => t.id);
  const [ins, previas] = await Promise.all([
    insumos(env, mes, ids),
    buscar(env, `remuneraciones_mes?select=*&mes=eq.${mes}&trabajador_id=in.(${ids.join(',')})`),
  ]);

  const omitidos = [];
  let escritas = 0, cerradas = 0;
  for (const t of trabajadores) {
    const previa = previas.find((r) => r.trabajador_id === t.id);
    if (previa && previa.estado === 'cerrado') { cerradas++; continue; }
    const contrato = contratoDe(ins.contratos, t.id, mes);
    if (!contrato) {
      omitidos.push({ trabajador: t.nombre, motivo: 'no tiene contrato cargado' });
      continue;
    }
    // Lo tecleado encima del contrato se conserva al recalcular: si RRHH ya
    // cargó las horas extra de ese mes, volver a calcular no se las lleva.
    const extra = previa?.extra && typeof previa.extra === 'object' ? previa.extra : {};
    const liq = liquidacionDe({ t, contrato, ins, mes, extra });
    const fila = {
      mes, trabajador_id: t.id, instalacion_id: inst, contrato_id: contrato.id,
      cargo: contrato.cargo || null,
      dias_trabajados: previa?.dias_trabajados ?? null,
      extra, detalle: liq,
      total_haberes: liq.haberes.total_haberes,
      total_descuentos: liq.descuentos.total_descuentos,
      liquido: liq.liquido,
      costo_empresa: liq.empresa.costo_total,
      estado: 'borrador',
    };
    if (previa) {
      await actualizar(env, `remuneraciones_mes?id=eq.${previa.id}`, fila);
    } else {
      await insertar(env, 'remuneraciones_mes', { ...fila, creado_por: quien });
    }
    escritas++;
  }
  await anotar(env, quien, 'remuneraciones_mes', inst, 'calculó el mes',
    `${mes}: ${escritas} liquidaciones` + (cerradas ? `, ${cerradas} ya cerradas sin tocar` : ''));
  return { ok: true, escritas, cerradas, omitidos };
}

/** Las filas de un mes, con el nombre y el RUT pegados para la pantalla. */
export async function listarMes(env, { mes, instalacion_id }) {
  if (!esMes(mes)) return { error: 'Falta el mes (AAAA-MM)', status: 400 };
  const filtros = [`mes=eq.${mes}`];
  const inst = entero(instalacion_id);
  if (inst) filtros.push(`instalacion_id=eq.${inst}`);
  const filas = await buscar(env,
    `remuneraciones_mes?select=*,trabajadores(nombre,rut,banco,cuenta_tipo,cuenta_numero,correo)`
    + `&${filtros.join('&')}&order=id.asc`);
  const lista = filas.map((f) => ({
    ...f,
    trabajador: f.trabajadores?.nombre ?? '—',
    rut: f.trabajadores?.rut ? formatearRut(f.trabajadores.rut) : null,
    rut_crudo: f.trabajadores?.rut ?? null,
    banco: f.trabajadores?.banco ?? null,
    cuenta_tipo: f.trabajadores?.cuenta_tipo ?? null,
    cuenta_numero: f.trabajadores?.cuenta_numero ?? null,
    correo: f.trabajadores?.correo ?? null,
    trabajadores: undefined,
  }));
  const suma = (k) => lista.reduce((a, f) => a + Number(f[k] || 0), 0);
  return {
    mes,
    remuneraciones: lista,
    totales: {
      personas: lista.length,
      haberes: suma('total_haberes'),
      descuentos: suma('total_descuentos'),
      liquido: suma('liquido'),
      costo_empresa: suma('costo_empresa'),
      cerradas: lista.filter((f) => f.estado === 'cerrado').length,
    },
  };
}

/**
 * Corrige lo que va encima del contrato de un mes (horas extra, bonos,
 * anticipos, días trabajados) y vuelve a calcular esa sola fila.
 *
 * Una fila cerrada no se edita: para eso está reabrir, que queda anotado.
 */
export async function editarFila(env, quien, id, cuerpo) {
  const fila = await primero(env, `remuneraciones_mes?select=*&id=eq.${id}`);
  if (!fila) return { error: 'Esa liquidación no está en el registro', status: 404 };
  if (fila.estado === 'cerrado') {
    return { error: 'Ese mes ya está cerrado. Para corregirlo hay que reabrirlo.', status: 409 };
  }
  const t = await primero(env, `trabajadores?select=*&id=eq.${fila.trabajador_id}`);
  const contrato = await primero(env, `contratos?select=*&id=eq.${fila.contrato_id}`);
  if (!t || !contrato) return { error: 'Falta la ficha o el contrato de esa persona', status: 409 };

  const extra = {};
  for (const k of ['horas_extra_monto', 'bono_imponible', 'no_imponible', 'otros_descuentos',
                   'anticipo', 'apv']) {
    const v = cuerpo.extra?.[k];
    if (v !== undefined && v !== null && v !== '') extra[k] = entero(v) ?? 0;
  }
  const ins = await insumos(env, fila.mes, [t.id]);
  const liq = liquidacionDe({ t, contrato, ins, mes: fila.mes, extra });
  const actualizada = await actualizar(env, `remuneraciones_mes?id=eq.${id}`, {
    extra,
    dias_trabajados: cuerpo.dias_trabajados === undefined
      ? fila.dias_trabajados : entero(cuerpo.dias_trabajados),
    detalle: liq,
    total_haberes: liq.haberes.total_haberes,
    total_descuentos: liq.descuentos.total_descuentos,
    liquido: liq.liquido,
    costo_empresa: liq.empresa.costo_total,
  });
  await anotar(env, quien, 'remuneraciones_mes', id, 'corrigió la liquidación',
    `${fila.mes}, ${t.nombre}: líquido $${Math.round(liq.liquido).toLocaleString('es-CL')}`);
  return { ok: true, fila: actualizada?.[0] || null };
}

/** Cierra el mes de una instalación. Desde acá no se recalcula solo. */
export async function cerrarMes(env, quien, { mes, instalacion_id }) {
  if (!esMes(mes)) return { error: 'Falta el mes (AAAA-MM)', status: 400 };
  const inst = entero(instalacion_id);
  if (!inst) return { error: 'Falta la instalación', status: 400 };
  const filas = await buscar(env,
    `remuneraciones_mes?select=id&mes=eq.${mes}&instalacion_id=eq.${inst}&estado=eq.borrador`);
  if (!filas.length) return { error: 'No hay nada en borrador para cerrar', status: 409 };
  await actualizar(env,
    `remuneraciones_mes?mes=eq.${mes}&instalacion_id=eq.${inst}&estado=eq.borrador`,
    { estado: 'cerrado', cerrado_en: new Date().toISOString(), cerrado_por: quien });
  await anotar(env, quien, 'remuneraciones_mes', inst, 'cerró el mes',
    `${mes}: ${filas.length} liquidaciones`);
  return { ok: true, cerradas: filas.length };
}

/** Reabrir queda anotado con el motivo: es volver atrás sobre algo ya dicho. */
export async function reabrirMes(env, quien, { mes, instalacion_id, motivo }) {
  if (!esMes(mes)) return { error: 'Falta el mes (AAAA-MM)', status: 400 };
  const inst = entero(instalacion_id);
  if (!inst) return { error: 'Falta la instalación', status: 400 };
  if (!limpio(motivo)) return { error: 'Hay que escribir por qué se reabre', status: 400 };
  const filas = await buscar(env,
    `remuneraciones_mes?select=id&mes=eq.${mes}&instalacion_id=eq.${inst}&estado=eq.cerrado`);
  if (!filas.length) return { error: 'Ese mes no está cerrado', status: 409 };
  await actualizar(env,
    `remuneraciones_mes?mes=eq.${mes}&instalacion_id=eq.${inst}&estado=eq.cerrado`,
    { estado: 'borrador', cerrado_en: null, cerrado_por: null });
  await anotar(env, quien, 'remuneraciones_mes', inst, 'reabrió el mes',
    `${mes}: ${filas.length} liquidaciones. Motivo: ${limpio(motivo)}`);
  return { ok: true, reabiertas: filas.length };
}

// ---------------------------------------------------------- transferencias
//
// La nómina que se sube al banco. El formato es el del archivo que entregó la
// empresa («Formato Excel Transferencias Masivas»): trece columnas, en este
// orden, con los encabezados exactos. El Excel lo arma la pantalla; acá se
// deciden las filas y, sobre todo, **qué no se puede pagar y por qué**.

export const COLUMNAS_NOMINA = [
  'Cuenta origen\n(obligatorio)',
  'Moneda origen\n(obligatorio)',
  'Cuenta destino\n(obligatorio)',
  'Moneda destino\n(obligatorio)',
  'Código banco destino\n(obligatorio solo si banco destino no es Santander)',
  'RUT beneficiario\n(obligatorio solo si banco destino no es Santander)',
  'Nombre beneficiario\n(obligatorio solo si banco destino no es Santander)',
  'Monto transferencia\n(obligatorio)',
  'Glosa personalizada transferencia\n(opcional)',
  'Correo beneficiario\n(opcional)',
  'Mensaje correo beneficiario\n(opcional)',
  'Glosa cartola originador\n(opcional)',
  'Glosa cartola beneficiario\n(opcional, solo aplica si cuenta destino es Santander)',
];

/**
 * ¿Es el mismo banco? Se comparan los nombres sin tildes, sin espacios y sin la
 * palabra «banco» delante: en la ficha dice «BancoEstado» y en la tabla
 * «BancoEstado», pero también puede decir «Banco Estado».
 *
 * **Y nada más que eso.** La primera versión caía de vuelta a un «contiene» y
 * eso hacía que «Banco de Chile» calzara con «Banco de Crédito e Inversiones»
 * por la palabra «de»: el pago habría salido con el código de otro banco. Si el
 * nombre no calza, la fila sale sin código y se avisa, que es lo peor que puede
 * pasar sin perder plata.
 */
const simplificar = (s) => String(s ?? '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '').replace(/^banco/, '');
const mismoNombre = (a, b) => !!a && !!b && simplificar(a) === simplificar(b);

/** Una cuenta se escribe sin puntos, guiones ni espacios, o el banco la rechaza. */
const cuentaLimpia = (v) => String(v ?? '').replace(/[^0-9]/g, '');

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
               'septiembre', 'octubre', 'noviembre', 'diciembre'];
const mesEnPalabras = (mes) => `${MESES[Number(mes.slice(5, 7)) - 1]} ${mes.slice(0, 4)}`;

/**
 * Arma la nómina de un mes.
 *
 * Reglas que se niega a saltarse:
 * - **No se paga lo que no está cerrado**, salvo que se pida expresamente. Una
 *   nómina armada sobre un borrador paga una cifra que todavía se está
 *   corrigiendo, y una transferencia no se deshace.
 * - **Líquido cero o negativo no entra.** Puede pasar con un mes de licencia
 *   completa, y el banco rechazaría la fila entera.
 * - **A quien le falta la cuenta, el banco o el RUT no entra, y se dice quién
 *   es.** Dejarlo fuera en silencio es el error caro: la planilla cuadra, el
 *   total parece bien y esa persona no cobra.
 */
export async function nomina(env, { mes, instalacion_id, incluir_borrador = false }) {
  if (!esMes(mes)) return { error: 'Falta el mes (AAAA-MM)', status: 400 };
  const { remuneraciones } = await listarMes(env, { mes, instalacion_id });
  const [empresa, bancos] = await Promise.all([
    buscar(env, 'datos_empresa?select=codigo,valor,por_confirmar').catch(() => []),
    buscar(env, 'bancos?select=*&activo=is.true&order=orden.asc').catch(() => []),
  ]);
  const dato = (c) => empresa.find((d) => d.codigo === c) || null;
  const cuentaOrigen = cuentaLimpia(dato('cuenta_origen')?.valor);
  const bancoOrigen = limpio(dato('banco_origen')?.valor);

  const filas = [];
  const omitidos = [];
  const avisos = [];
  if (!cuentaOrigen) {
    avisos.push('Falta la cuenta desde la que se paga. Se escribe en Documentos → '
      + 'Datos de la empresa, y la nómina sale con esa columna en blanco.');
  }
  if (dato('cuenta_origen')?.por_confirmar) {
    avisos.push('La cuenta de origen está sin confirmar.');
  }

  for (const r of remuneraciones) {
    const quien = `${r.trabajador} (${r.rut || 's/RUT'})`;
    if (r.estado !== 'cerrado' && !incluir_borrador) {
      omitidos.push({ quien, motivo: 'su liquidación todavía está en borrador' });
      continue;
    }
    const monto = Math.round(Number(r.liquido || 0));
    if (monto <= 0) {
      omitidos.push({ quien, motivo: `el líquido quedó en $${monto.toLocaleString('es-CL')}` });
      continue;
    }
    const cuenta = cuentaLimpia(r.cuenta_numero);
    if (!cuenta) { omitidos.push({ quien, motivo: 'no tiene número de cuenta en su ficha' }); continue; }
    if (!r.banco) { omitidos.push({ quien, motivo: 'no tiene banco en su ficha' }); continue; }
    const rut = normalizarRut(r.rut_crudo);
    if (!rut) { omitidos.push({ quien, motivo: 'no tiene RUT válido en su ficha' }); continue; }

    // El código lo pide la nómina salvo que el banco destino sea el mismo con
    // que se paga. Si no está en la tabla, la fila sale igual con el código en
    // blanco y se dice: el banco puede recibirla y nosotros no inventamos un
    // número de tres dígitos.
    const b = bancos.find((x) => mismoNombre(x.nombre, r.banco));
    const mismoBanco = mismoNombre(bancoOrigen, r.banco);
    if (!b && !mismoBanco) {
      avisos.push(`«${r.banco}» (${r.trabajador}) no está en la lista de bancos: la fila sale `
        + 'sin código de banco destino.');
    } else if (b?.por_confirmar && !mismoBanco) {
      avisos.push(`El código de «${b.nombre}» está sin confirmar (${b.codigo}). `
        + 'Conviene comprobarlo contra la nómina del banco antes de subirla.');
    }

    filas.push({
      cuenta_origen: cuentaOrigen,
      moneda_origen: 'CLP',
      cuenta_destino: cuenta,
      moneda_destino: 'CLP',
      banco_destino: mismoBanco ? '' : (b?.codigo || ''),
      rut: rut.slice(0, -1),            // la nómina lleva el cuerpo, sin dígito verificador
      nombre: r.trabajador,
      monto,
      glosa: `Remuneracion ${mesEnPalabras(mes)}`.slice(0, 40),
      correo: r.correo || '',
      mensaje: '',
      glosa_originador: `Sueldo ${mes}`.slice(0, 15),
      glosa_beneficiario: '',
      // Para la pantalla, no para el banco. El RUT con puntos y dígito va
      // aparte porque la columna del banco lleva solo el cuerpo, y en pantalla
      // «12345678» se lee como un RUT equivocado.
      _trabajador_id: r.trabajador_id,
      _rut: r.rut,
      _banco: r.banco,
      _cuenta_tipo: r.cuenta_tipo,
    });
  }

  return {
    mes,
    columnas: COLUMNAS_NOMINA,
    filas,
    omitidos,
    avisos: [...new Set(avisos)],
    total: filas.reduce((a, f) => a + f.monto, 0),
    cuenta_origen: cuentaOrigen,
    banco_origen: bancoOrigen,
  };
}

// ----------------------------------------------------------- estados de pago

export async function listarEstados(env, { mes }) {
  const filtro = esMes(mes) ? `&mes=eq.${mes}` : '';
  const estados = await buscar(env,
    `v_estados_pago?select=*${filtro}&order=mes.desc,instalacion.asc`);
  return { estados };
}

export async function crearEstado(env, quien, cuerpo) {
  if (!esMes(cuerpo.mes)) return { error: 'Falta el mes (AAAA-MM)', status: 400 };
  const inst = entero(cuerpo.instalacion_id);
  if (!inst) return { error: 'Falta la instalación', status: 400 };
  const ya = await primero(env,
    `estados_pago?select=id&mes=eq.${cuerpo.mes}&instalacion_id=eq.${inst}`);
  if (ya) return { ok: true, id: ya.id, ya_existia: true };
  const creado = await insertar(env, 'estados_pago', {
    mes: cuerpo.mes, instalacion_id: inst, nota: limpio(cuerpo.nota), creado_por: quien,
  });
  const id = creado?.[0]?.id;
  await anotar(env, quien, 'estado_pago', id, 'creó el estado de pago', cuerpo.mes);
  return { ok: true, id, ya_existia: false };
}

export async function editarEstado(env, quien, id, cuerpo) {
  const e = await primero(env, `estados_pago?select=*&id=eq.${id}`);
  if (!e) return { error: 'Ese estado de pago no está en el registro', status: 404 };
  const campos = { actualizado_en: new Date().toISOString() };
  if (cuerpo.estado !== undefined) {
    if (!ESTADOS.includes(cuerpo.estado)) return { error: 'Ese estado no existe', status: 400 };
    campos.estado = cuerpo.estado;
    if (cuerpo.estado === 'enviado' && !e.enviado_en) campos.enviado_en = hoyISO();
  }
  if (cuerpo.folio_factura !== undefined) campos.folio_factura = limpio(cuerpo.folio_factura);
  if (cuerpo.nota !== undefined) campos.nota = limpio(cuerpo.nota);
  const fila = await actualizar(env, `estados_pago?id=eq.${id}`, campos);
  await anotar(env, quien, 'estado_pago', id, 'editó el estado de pago',
    Object.keys(campos).filter((k) => k !== 'actualizado_en').join(', '));
  return { ok: true, estado: fila?.[0] || null };
}

/** La carpeta completa: los papeles que hay y los que faltan. */
export async function detalleEstado(env, id) {
  const e = await primero(env, `v_estados_pago?select=*&id=eq.${id}`);
  if (!e) return { error: 'Ese estado de pago no está en el registro', status: 404 };
  const [archivos, mes] = await Promise.all([
    buscar(env, `estado_pago_archivos?select=*&estado_pago_id=eq.${id}&order=subido_en.desc`),
    listarMes(env, { mes: e.mes, instalacion_id: e.instalacion_id }),
  ]);
  // Los cinco papeles que el mandante exige. Lo que falta sale nombrado, no
  // contado: «faltan 2 documentos» deja a la oficina adivinando cuáles.
  const exigidos = ['libro_asistencia', 'libro_remuneraciones', 'liquidaciones', 'f30', 'f30_1'];
  const faltan = exigidos.filter((c) => !archivos.some((a) => a.clase === c))
    .map((c) => ({ clase: c, nombre: CLASES[c] }));
  return {
    estado: e,
    archivos: archivos.map((a) => ({ ...a, clase_nombre: CLASES[a.clase] || a.clase })),
    faltan,
    remuneraciones: mes.remuneraciones,
    totales: mes.totales,
  };
}

export async function registrarArchivo(env, quien, estadoPagoId, datos) {
  if (!CLASES[datos.clase]) return { error: 'Esa clase de documento no existe', status: 400 };
  const creado = await insertar(env, 'estado_pago_archivos', {
    estado_pago_id: estadoPagoId,
    clase: datos.clase,
    nombre: limpio(datos.nombre) || CLASES[datos.clase],
    archivo_ruta: datos.archivo_ruta ?? null,
    archivo_tipo: datos.archivo_tipo ?? null,
    archivo_bytes: datos.archivo_bytes ?? null,
    nota: limpio(datos.nota),
    subido_por: quien,
  });
  await anotar(env, quien, 'estado_pago', estadoPagoId, 'agregó un documento',
    CLASES[datos.clase]);
  return { ok: true, archivo: creado?.[0] || null };
}

export { esMes, cierreDe, mesEnPalabras };
