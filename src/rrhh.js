/**
 * Recursos humanos.
 *
 * Lo que tiene que resolver, en el orden en que aprieta:
 *   1. Que nadie haga turno con la credencial OS-10 vencida. Es lo que cierra
 *      una faena y lo que deja a la empresa sin poder cobrar el mes.
 *   2. Que un contrato a plazo fijo no se pase de fecha sin que nadie lo vea:
 *      el día después venció, el contrato es indefinido y el despido vale tres
 *      veces más.
 *   3. Que el feriado de cada uno esté contado en días hábiles y no de memoria.
 *   4. Que la liquidación y el finiquito se calculen con los números del año
 *      que corresponde, no con los que alguien recuerda.
 *
 * Qué NO hace, a propósito: no emite liquidaciones ni finiquitos. Calcula y
 * muestra el desglose, dice de dónde salió cada número y marca en ámbar los
 * parámetros que nadie confirmó. El documento que se firma lo sigue emitiendo
 * quien corresponde; esto es para saber, antes de firmarlo, cuánto da.
 */

import { buscar, primero, insertar, actualizar, anotar } from './datos.js';
import { hoyISO, esFecha, sumarDias } from './fechas.js';
import { diasHabiles, diasCorridos, feriadosEnRango, mesesEntre } from './feriados.js';
import { normalizarRut, dvCorrecto, formatearRut } from './rut.js';

// ---------------------------------------------------------------- utilidades
const limpio = (v, max = 200) => {
  const t = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return t ? t.slice(0, max) : null;
};

const entero = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(String(v).replace(/[^\d.-]/g, '')));
  return Number.isFinite(n) ? n : null;
};

const decimal = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const fechaO = (v) => (esFecha(v) ? v : null);
const siNo = (v) => v === true || v === 'true' || v === 1 || v === 'si' || v === 'sí';
const peso = (n) => Math.round(n || 0);

export const TIPOS_CONTRATO = ['indefinido', 'plazo_fijo', 'por_obra'];
export const JORNADAS = ['art22', 'art38_2', 'excepcional', 'parcial', 'art22_excluido'];
export const TIPOS_AUSENCIA = [
  'feriado', 'feriado_progresivo', 'licencia_medica', 'accidente_trabajo',
  'permiso_legal', 'permiso_con_goce', 'permiso_sin_goce',
  'falta_injustificada', 'suspension', 'otra',
];
/** Las que descuentan saldo de feriado. Ninguna otra lo toca. */
const AUSENCIAS_DE_FERIADO = new Set(['feriado', 'feriado_progresivo']);

/**
 * Causales de término, con qué paga cada una. El sistema no decide la causal:
 * la decide quien despide. Lo que sí hace es no dejar que una causal del
 * art. 160 arrastre indemnización por años de servicio, que es un error de
 * planilla que termina en demanda.
 */
export const CAUSALES = {
  '159-1': { glosa: 'Mutuo acuerdo de las partes',            ias: false, aviso: false },
  '159-2': { glosa: 'Renuncia del trabajador',                ias: false, aviso: false },
  '159-3': { glosa: 'Muerte del trabajador',                  ias: false, aviso: false },
  '159-4': { glosa: 'Vencimiento del plazo convenido',        ias: false, aviso: false },
  '159-5': { glosa: 'Conclusión del trabajo o servicio',      ias: false, aviso: false },
  '159-6': { glosa: 'Caso fortuito o fuerza mayor',           ias: false, aviso: false },
  '160':   { glosa: 'Causales del art. 160 (sin derecho a indemnización)', ias: false, aviso: false },
  '161-1': { glosa: 'Necesidades de la empresa',              ias: true,  aviso: true },
  '161-2': { glosa: 'Desahucio escrito del empleador',        ias: true,  aviso: true },
  '163-bis': { glosa: 'Procedimiento concursal de liquidación', ias: true, aviso: false },
};

// ---------------------------------------------------------------- parámetros
/**
 * Los parámetros vigentes a una fecha: de cada código, la fila con la vigencia
 * más reciente que no sea posterior a esa fecha.
 *
 * Se filtra acá y no con un `distinct on` en la base porque el cálculo de un
 * mes pasado tiene que poder pedir los de ese mes, y una vista que siempre
 * devuelve "lo último" no sirve para eso.
 */
export async function parametros(env, fecha = hoyISO()) {
  const filas = await buscar(env,
    `parametros_rrhh?select=*&vigente_desde=lte.${fecha}&order=codigo.asc,vigente_desde.desc`);
  const p = {};
  for (const f of filas) if (!(f.codigo in p)) p[f.codigo] = f;
  return p;
}

const valor = (p, codigo, respaldo = 0) =>
  (p[codigo] ? Number(p[codigo].valor) : respaldo);

/** Los códigos que se usaron y todavía nadie confirmó. La pantalla los marca. */
const sinConfirmar = (p, codigos) =>
  codigos.filter((c) => p[c]?.por_confirmar).map((c) => ({
    codigo: c, glosa: p[c].glosa, valor: Number(p[c].valor),
    base_legal: p[c].base_legal,
  }));

export async function editarParametro(env, quien, cuerpo) {
  const codigo = limpio(cuerpo.codigo, 40);
  const desde = fechaO(cuerpo.vigente_desde);
  const v = decimal(cuerpo.valor);
  if (!codigo || !desde || v === null) {
    return { error: 'Falta el código, la fecha de vigencia o el valor', status: 400 };
  }
  if (v < 0) return { error: 'El valor no puede ser negativo', status: 400 };

  const previo = await primero(env,
    `parametros_rrhh?select=*&codigo=eq.${encodeURIComponent(codigo)}&vigente_desde=eq.${desde}`);
  const campos = {
    valor: v,
    // Que alguien lo escriba a mano es, justamente, confirmarlo.
    por_confirmar: siNo(cuerpo.por_confirmar),
    actualizado_por: quien,
    actualizado_en: new Date().toISOString(),
  };
  if ('glosa' in cuerpo) campos.glosa = limpio(cuerpo.glosa, 200);

  if (previo) {
    await actualizar(env,
      `parametros_rrhh?codigo=eq.${encodeURIComponent(codigo)}&vigente_desde=eq.${desde}`, campos);
  } else {
    await insertar(env, 'parametros_rrhh', {
      codigo, vigente_desde: desde, unidad: limpio(cuerpo.unidad, 20) || 'pesos',
      base_legal: limpio(cuerpo.base_legal, 300), ...campos,
    });
  }
  await anotar(env, quien, 'parametro_rrhh', null,
    previo ? 'cambió un parámetro' : 'agregó un parámetro',
    `${codigo} desde ${desde} = ${v}`);
  return { ok: true };
}

// ---------------------------------------------------------------- ficha
const CAMPOS_FICHA_TEXTO = {
  sexo: 1, nacionalidad: 40, estado_civil: 30, email: 120, direccion: 200,
  comuna: 60, region: 60, nivel_estudios: 60, afp: 40, salud_sistema: 10,
  salud_isapre: 60, caja_compensacion: 60, banco: 60, cuenta_tipo: 30,
  cuenta_numero: 40, emergencia_nombre: 100, emergencia_telefono: 40,
  emergencia_parentesco: 40, prevision_salud_nota: 300, talla_uniforme: 20,
  talla_zapato: 10, licencia_conducir: 20, observaciones: 1000, telefono: 40,
};
const CAMPOS_FICHA_FECHA = ['fecha_nacimiento', 'fecha_ingreso', 'feriado_saldo_al'];
const CAMPOS_FICHA_ENTERO = ['apv_monto', 'anios_previos'];
const CAMPOS_FICHA_DECIMAL = ['salud_plan_uf', 'feriado_saldo_inicial'];
const CAMPOS_FICHA_BOOL = ['jubilado', 'discapacidad'];

/** Convierte el cuerpo del formulario en columnas, descartando lo que no es. */
export function camposFicha(cuerpo) {
  const campos = {};
  for (const [c, max] of Object.entries(CAMPOS_FICHA_TEXTO)) {
    if (c in cuerpo) campos[c] = limpio(cuerpo[c], max);
  }
  for (const c of CAMPOS_FICHA_FECHA) if (c in cuerpo) campos[c] = fechaO(cuerpo[c]);
  for (const c of CAMPOS_FICHA_ENTERO) if (c in cuerpo) campos[c] = entero(cuerpo[c]);
  for (const c of CAMPOS_FICHA_DECIMAL) if (c in cuerpo) campos[c] = decimal(cuerpo[c]);
  for (const c of CAMPOS_FICHA_BOOL) if (c in cuerpo) campos[c] = siNo(cuerpo[c]);

  // Lo que la base no acepta se descarta acá, con un valor nulo, en vez de
  // hacer fallar la carga entera por una celda mal escrita.
  if (campos.sexo && !['F', 'M', 'X'].includes(campos.sexo)) campos.sexo = null;
  if (campos.salud_sistema && !['fonasa', 'isapre'].includes(campos.salud_sistema)) {
    campos.salud_sistema = null;
  }
  if (campos.anios_previos !== undefined && campos.anios_previos !== null) {
    campos.anios_previos = Math.min(Math.max(campos.anios_previos, 0), 50);
  }
  return campos;
}

export async function editarFicha(env, quien, id, cuerpo) {
  const t = await primero(env, `trabajadores?select=id,nombre&id=eq.${id}`);
  if (!t) return { error: 'Esa persona no está en el registro', status: 404 };

  const campos = camposFicha(cuerpo);
  if (!Object.keys(campos).length) return { error: 'No hay nada que cambiar', status: 400 };

  await actualizar(env, `trabajadores?id=eq.${t.id}`, campos);
  await anotar(env, quien, 'ficha_rrhh', t.id, 'editó la ficha',
    `${t.nombre} · ${Object.keys(campos).join(', ')}`);
  return { ok: true };
}

// ---------------------------------------------------------------- feriado
/**
 * Saldo de feriado legal, en días hábiles.
 *
 * Reglas aplicadas:
 *  - 15 días hábiles por año de servicio (art. 67), devengados mes a mes.
 *  - Feriado progresivo (art. 68): con 10 años de trabajo —propios y hasta 10
 *    acreditados con empleadores anteriores— se gana un día más por cada tres
 *    años nuevos.
 *  - El sábado es inhábil para estos efectos (art. 69), y por eso se cuenta
 *    con `diasHabiles` y no con días corridos.
 *
 * `feriado_saldo_inicial` existe porque el sistema parte hoy y la gente lleva
 * años: sin ese saldo de arranque, a quien entró en 2021 el cálculo le daría
 * cero días disponibles y cinco años de vacaciones devengadas de golpe.
 */
export function saldoFeriado(t, ausencias, hoy = hoyISO()) {
  const ingreso = t.fecha_ingreso;
  if (!ingreso || ingreso > hoy) {
    return { sin_fecha_ingreso: !ingreso, devengado: 0, tomado: 0, saldo: 0,
             dias_por_anio: 15, progresivo: 0, desde: null };
  }

  // Desde dónde se cuenta: desde el corte que cargó RRHH, si lo hay.
  const desde = t.feriado_saldo_al && t.feriado_saldo_al >= ingreso ? t.feriado_saldo_al : ingreso;
  const inicial = Number(t.feriado_saldo_inicial) || 0;

  const aniosEmpresa = mesesEntre(ingreso, hoy) / 12;
  const aniosTotales = aniosEmpresa + Math.min(Number(t.anios_previos) || 0, 10);
  const progresivo = aniosTotales >= 10 ? Math.floor((aniosTotales - 10) / 3) : 0;
  const diasPorAnio = 15 + progresivo;

  const devengado = (mesesEntre(desde, hoy) / 12) * diasPorAnio;

  const tomado = (ausencias || [])
    .filter((a) => AUSENCIAS_DE_FERIADO.has(a.tipo) && a.estado === 'aprobada'
                   && a.desde >= desde)
    .reduce((s, a) => s + (Number(a.dias_habiles) || 0), 0);

  const r = (n) => Math.round(n * 100) / 100;
  return {
    desde,
    saldo_inicial: inicial,
    dias_por_anio: diasPorAnio,
    progresivo,
    anios_empresa: r(aniosEmpresa),
    anios_totales: r(aniosTotales),
    devengado: r(devengado),
    tomado: r(tomado),
    saldo: r(inicial + devengado - tomado),
  };
}

// ---------------------------------------------------------------- contratos
function camposContrato(cuerpo) {
  const tipo = TIPOS_CONTRATO.includes(cuerpo.tipo) ? cuerpo.tipo : 'indefinido';
  const jornada = JORNADAS.includes(cuerpo.jornada_tipo) ? cuerpo.jornada_tipo : 'art38_2';
  return {
    tipo,
    fecha_inicio: fechaO(cuerpo.fecha_inicio),
    // Un indefinido no lleva fecha de término, y dejarla puesta no es un dato
    // de más: el panel avisa por `fecha_termino` sin mirar el tipo, así que un
    // contrato pasado a indefinido seguiría saliendo en la lista de plazos por
    // vencer. La alerta más cara del módulo quedaría avisando de algo que ya
    // no existe, y la que avisa de más deja de creerse igual que la que falta.
    fecha_termino: tipo === 'indefinido' ? null : fechaO(cuerpo.fecha_termino),
    cargo: limpio(cuerpo.cargo, 60),
    instalacion_id: entero(cuerpo.instalacion_id),
    jornada_tipo: jornada,
    horas_semanales: decimal(cuerpo.horas_semanales),
    turno: limpio(cuerpo.turno, 80),
    resolucion_dt: limpio(cuerpo.resolucion_dt, 80),
    resolucion_vence: fechaO(cuerpo.resolucion_vence),
    colacion_minutos: entero(cuerpo.colacion_minutos),
    sueldo_base: entero(cuerpo.sueldo_base),
    gratificacion: ['legal_25', 'convencional', 'sin'].includes(cuerpo.gratificacion)
      ? cuerpo.gratificacion : 'legal_25',
    gratificacion_monto: entero(cuerpo.gratificacion_monto),
    colacion: entero(cuerpo.colacion) || 0,
    movilizacion: entero(cuerpo.movilizacion) || 0,
    asignacion_glosa: limpio(cuerpo.asignacion_glosa, 60),
    asignacion_monto: entero(cuerpo.asignacion_monto) || 0,
    bono_imponible_glosa: limpio(cuerpo.bono_imponible_glosa, 60),
    bono_imponible_monto: entero(cuerpo.bono_imponible_monto) || 0,
    firmado: siNo(cuerpo.firmado),
    firmado_en: fechaO(cuerpo.firmado_en),
    notas: limpio(cuerpo.notas, 1000),
  };
}

/**
 * Lo que la ley exige de un contrato y el sistema puede revisar solo.
 * Devuelve el motivo del rechazo, o null.
 */
function revisarContrato(c, p) {
  if (!c.fecha_inicio) return 'Falta la fecha de inicio';
  if (!c.cargo) return 'Falta el cargo';
  if (c.sueldo_base === null) return 'Falta el sueldo base';
  if (c.sueldo_base < 0) return 'El sueldo base no puede ser negativo';
  if (c.tipo !== 'indefinido' && !c.fecha_termino) {
    return 'Un contrato a plazo fijo o por obra tiene que llevar fecha de término';
  }
  if (c.fecha_termino && c.fecha_termino < c.fecha_inicio) {
    return 'La fecha de término es anterior a la de inicio';
  }
  // Art. 159 N°4: el plazo fijo no puede pasar de un año.
  if (c.tipo === 'plazo_fijo' && c.fecha_termino
      && mesesEntre(c.fecha_inicio, c.fecha_termino) > 12) {
    return 'Un contrato a plazo fijo no puede durar más de un año (art. 159 N°4)';
  }
  // El sistema excepcional de turnos existe solo mientras exista la resolución.
  if (c.jornada_tipo === 'excepcional' && !c.resolucion_dt) {
    return 'Un sistema excepcional de turnos necesita el número de la resolución de la Dirección del Trabajo';
  }
  const maxHoras = valor(p, 'jornada_semanal', 44);
  if (c.horas_semanales && c.jornada_tipo !== 'art22_excluido'
      && c.horas_semanales > maxHoras + 0.01) {
    return `La jornada ordinaria vigente es de ${maxHoras} horas semanales`;
  }
  return null;
}

/** Aviso que no impide guardar, pero que RRHH tiene que ver. */
function avisosContrato(c, p) {
  const avisos = [];
  const imm = valor(p, 'imm', 0);
  const jornadaCompleta = c.jornada_tipo !== 'parcial';
  if (imm && jornadaCompleta && c.sueldo_base < imm) {
    avisos.push(`El sueldo base queda bajo el ingreso mínimo vigente ($${imm.toLocaleString('es-CL')}). `
      + 'Con jornada completa no puede ser menor.');
  }
  if (c.jornada_tipo === 'excepcional' && !c.resolucion_vence) {
    avisos.push('La resolución de turnos excepcionales no tiene fecha de vencimiento cargada: '
      + 'así nadie va a saber cuándo hay que renovarla.');
  }
  if (c.tipo === 'plazo_fijo') {
    avisos.push('Plazo fijo: si el trabajador sigue prestando servicios después de la fecha de '
      + 'término, el contrato pasa a ser indefinido (art. 159 N°4).');
  }
  if (!c.firmado) {
    avisos.push('Queda registrado como no firmado. El contrato se escritura dentro de 15 días '
      + '(5 si es por obra o faena, o de menos de 30 días; art. 9 CT).');
  }
  return avisos;
}

/**
 * Cómo se nombra cada campo del contrato en la bitácora.
 *
 * Está escrito para que lo lea alguien que no programó esto: lo que la oficina
 * necesita del registro es "el 20 de octubre Valeria corrió el término del 14
 * de diciembre al 31 de marzo", no el nombre de una columna.
 */
const ROTULO_CAMPO_CONTRATO = {
  tipo: 'tipo', fecha_inicio: 'inicio', fecha_termino: 'término',
  cargo: 'cargo', instalacion_id: 'instalación', jornada_tipo: 'jornada',
  horas_semanales: 'horas semanales', turno: 'turno',
  resolucion_dt: 'resolución DT', resolucion_vence: 'vencimiento de la resolución',
  colacion_minutos: 'minutos de colación', sueldo_base: 'sueldo base',
  gratificacion: 'gratificación', gratificacion_monto: 'gratificación convencional',
  colacion: 'colación', movilizacion: 'movilización',
  asignacion_glosa: 'glosa de la asignación', asignacion_monto: 'asignación',
  bono_imponible_glosa: 'glosa del bono', bono_imponible_monto: 'bono imponible',
  firmado: 'firmado', firmado_en: 'fecha de firma', notas: 'notas',
};

/** Vacío se escribe así y no como "null", que no quiere decir nada. */
const comoTexto = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

/**
 * Qué cambió entre lo que había y lo que se va a guardar.
 *
 * Esto existe por la fecha de término: moverla mueve la alerta de plazo por
 * vencer, que es la más cara del módulo —pasado un día, el contrato es
 * indefinido y el despido vale tres veces más—. Un registro que solo dijera
 * "editó el contrato" dejaría esa alerta cambiando sin que se pueda saber
 * quién la cambió ni desde qué fecha. El resto del sistema ya trabaja así.
 */
export function cambiosContrato(antes, despues) {
  const cambios = [];
  for (const [campo, rotulo] of Object.entries(ROTULO_CAMPO_CONTRATO)) {
    if (!(campo in despues)) continue;
    // Comparado como texto: la base devuelve los numéricos como número y el
    // formulario como cadena, y 700000 contra "700000" no es un cambio.
    const a = comoTexto(antes[campo]);
    const b = comoTexto(despues[campo]);
    if (a !== b) cambios.push({ campo, rotulo, antes: a, despues: b });
  }
  return cambios;
}

/**
 * El finiquito que cierra este contrato, si está cargado.
 *
 * Un finiquito registrado desde la ficha puede venir sin contrato elegido —el
 * formulario no lo pedía hasta hoy—, y en ese caso se entiende que es del
 * último contrato de esa persona, que es de lo único que puede ser. Si está
 * enganchado a otro contrato, no toca a este.
 */
async function finiquitoDe(env, contrato) {
  const docs = await buscar(env,
    'documentos_trabajador?select=id,contrato_id,numero,fecha_emision' +
    `&trabajador_id=eq.${contrato.trabajador_id}&tipo=eq.finiquito&vigente=is.true`);
  if (!docs.length) return null;
  const propio = docs.find((d) => d.contrato_id === contrato.id);
  if (propio) return propio;
  const sueltos = docs.filter((d) => d.contrato_id === null);
  if (!sueltos.length) return null;
  const ultimo = await primero(env,
    `contratos?select=id&trabajador_id=eq.${contrato.trabajador_id}&order=fecha_inicio.desc`);
  return ultimo && ultimo.id === contrato.id ? sueltos[0] : null;
}

export async function crearContrato(env, quien, cuerpo) {
  const t = await primero(env, `trabajadores?select=id,nombre,fecha_ingreso&id=eq.${entero(cuerpo.trabajador_id)}`);
  if (!t) return { error: 'Esa persona no está en el registro', status: 404 };

  const c = camposContrato(cuerpo);
  const p = await parametros(env, c.fecha_inicio || hoyISO());
  const malo = revisarContrato(c, p);
  if (malo) return { error: malo, status: 400 };

  // Un contrato nuevo cierra el anterior: dos contratos vigentes a la vez es
  // la situación que después nadie sabe explicar en una fiscalización.
  const vigente = await primero(env,
    `contratos?select=id,fecha_inicio&trabajador_id=eq.${t.id}&estado=eq.vigente&order=fecha_inicio.desc`);
  if (vigente) {
    if (vigente.fecha_inicio > c.fecha_inicio) {
      return { error: 'Ya hay un contrato vigente que empieza después de esta fecha', status: 409 };
    }
    await actualizar(env, `contratos?id=eq.${vigente.id}`, {
      estado: 'terminado',
      termino_fecha: sumarDias(c.fecha_inicio, -1),
      termino_causal: 'reemplazado',
      termino_detalle: 'Reemplazado por un contrato nuevo',
    });
  }

  const [creado] = await insertar(env, 'contratos', {
    ...c, trabajador_id: t.id, estado: 'vigente', creado_por: quien,
  });

  // El cargo y la instalación del contrato son los de la persona: si no se
  // copian, la ficha sigue diciendo lo de antes y nadie sabe cuál manda.
  const ficha = {};
  if (c.cargo) ficha.cargo = c.cargo;
  if (c.instalacion_id) ficha.instalacion_id = c.instalacion_id;
  if (!t.fecha_ingreso) ficha.fecha_ingreso = c.fecha_inicio;
  if (Object.keys(ficha).length) await actualizar(env, `trabajadores?id=eq.${t.id}`, ficha);

  await anotar(env, quien, 'contrato', creado.id, 'creó el contrato',
    `${t.nombre} · ${c.tipo} desde ${c.fecha_inicio}`);
  return { contrato: creado, avisos: avisosContrato(c, p),
           reemplazo: vigente ? vigente.id : null };
}

export async function editarContrato(env, quien, id, cuerpo) {
  const actual = await primero(env, `contratos?select=*,trabajadores(nombre)&id=eq.${id}`);
  if (!actual) return { error: 'Ese contrato no existe', status: 404 };
  const nombre = actual.trabajadores?.nombre || '';

  // Terminar es una operación aparte: necesita causal y fecha, y la causal
  // decide qué se paga.
  if (cuerpo.terminar === true) {
    if (actual.estado !== 'vigente') {
      return { error: 'Ese contrato ya no está vigente: no hay nada que terminar', status: 409 };
    }
    const causal = limpio(cuerpo.termino_causal, 20);
    const fecha = fechaO(cuerpo.termino_fecha);
    if (!causal || !CAUSALES[causal]) return { error: 'Falta la causal de término', status: 400 };
    if (!fecha) return { error: 'Falta la fecha de término', status: 400 };
    if (fecha < actual.fecha_inicio) {
      return { error: 'La fecha de término es anterior al inicio del contrato', status: 400 };
    }
    await actualizar(env, `contratos?id=eq.${actual.id}`, {
      estado: 'terminado', termino_causal: causal, termino_fecha: fecha,
      termino_detalle: limpio(cuerpo.termino_detalle, 500),
    });
    // Quien deja de tener contrato deja de poder marcar: si no, la cuenta del
    // libro de asistencia sigue abierta después del finiquito.
    if (siNo(cuerpo.dar_de_baja)) {
      await actualizar(env, `trabajadores?id=eq.${actual.trabajador_id}`, { activo: false });
    }
    await anotar(env, quien, 'contrato', actual.id, 'terminó el contrato',
      `${nombre} · ${CAUSALES[causal].glosa} al ${fecha}`);
    return { ok: true, causal: CAUSALES[causal] };
  }

  // Con el finiquito cargado, las condiciones de este contrato ya están en un
  // documento firmado por las dos partes y ratificado ante ministro de fe
  // (art. 177). Corregirlas acá dejaría al sistema diciendo una cosa y al
  // papel otra, y el que vale es el papel. Va antes de la revisión de estado
  // porque el motivo es distinto y la pantalla tiene que poder decir cuál es.
  const finiquito = await finiquitoDe(env, actual);
  if (finiquito) {
    return {
      error: 'Este contrato tiene un finiquito cargado'
        + (finiquito.fecha_emision ? ` (${finiquito.fecha_emision})` : '')
        + '. No se edita: lo que se firmó ahí son estas condiciones. Si el finiquito '
        + 'quedó mal, anúlelo primero desde los documentos de la persona.',
      status: 409,
    };
  }

  if (actual.estado !== 'vigente') {
    return {
      error: 'Un contrato terminado no se edita: es lo que decía el contrato en esa fecha, '
        + 'y de eso salen el feriado y la indemnización. Cargue uno nuevo.',
      status: 409,
    };
  }

  const c = camposContrato({ ...actual, ...cuerpo });
  const p = await parametros(env, c.fecha_inicio || hoyISO());
  const malo = revisarContrato(c, p);
  if (malo) return { error: malo, status: 400 };

  const cambios = cambiosContrato(actual, c);
  if (!cambios.length) return { ok: true, cambios: [], avisos: [] };

  await actualizar(env, `contratos?id=eq.${actual.id}`, c);

  // El cargo y la instalación del contrato son los de la persona, igual que al
  // crearlo: si se corrigen acá y la ficha se queda con lo de antes, nadie
  // sabe cuál de las dos manda.
  const ficha = {};
  if (cambios.some((x) => x.campo === 'cargo') && c.cargo) ficha.cargo = c.cargo;
  if (cambios.some((x) => x.campo === 'instalacion_id')) ficha.instalacion_id = c.instalacion_id;
  if (Object.keys(ficha).length) {
    await actualizar(env, `trabajadores?id=eq.${actual.trabajador_id}`, ficha);
  }

  await anotar(env, quien, 'contrato', actual.id, 'editó el contrato',
    `${nombre} · ` + cambios.map((x) => `${x.rotulo}: ${x.antes} → ${x.despues}`)
      .join(' · ').slice(0, 900));
  return { ok: true, cambios, avisos: avisosContrato(c, p) };
}

// ---------------------------------------------------------------- documentos
export async function crearDocumento(env, quien, cuerpo) {
  const trabajadorId = entero(cuerpo.trabajador_id);
  const t = await primero(env, `trabajadores?select=id,nombre&id=eq.${trabajadorId}`);
  if (!t) return { error: 'Esa persona no está en el registro', status: 404 };

  const tipo = limpio(cuerpo.tipo, 40);
  const td = tipo && await primero(env,
    `tipos_documento?select=*&codigo=eq.${encodeURIComponent(tipo)}`);
  if (!td) return { error: 'Ese tipo de documento no existe', status: 400 };

  const emision = fechaO(cuerpo.fecha_emision);
  let vence = fechaO(cuerpo.fecha_vencimiento);
  // Si el tipo vence y nadie escribió hasta cuándo, se propone con la validez
  // del catálogo. Un documento que vence sin fecha de vencimiento es, en la
  // práctica, un documento que nadie va a renovar.
  if (!vence && td.vence && td.meses_validez && emision) {
    const [a, m, d] = emision.split('-').map(Number);
    const total = (m - 1) + td.meses_validez;
    const anio = a + Math.floor(total / 12);
    const mes = (total % 12) + 1;
    const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
    vence = `${anio}-${String(mes).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
  }
  if (vence && emision && vence < emision) {
    return { error: 'El vencimiento es anterior a la emisión', status: 400 };
  }

  const enlace = limpio(cuerpo.enlace, 500);
  if (enlace && !/^https?:\/\//i.test(enlace)) {
    return { error: 'El enlace tiene que empezar con http:// o https://', status: 400 };
  }

  const [creado] = await insertar(env, 'documentos_trabajador', {
    trabajador_id: t.id,
    contrato_id: entero(cuerpo.contrato_id),
    tipo,
    glosa: limpio(cuerpo.glosa, 200),
    numero: limpio(cuerpo.numero, 60),
    fecha_emision: emision,
    fecha_vencimiento: vence,
    enlace,
    observacion: limpio(cuerpo.observacion, 500),
    creado_por: quien,
  });
  await anotar(env, quien, 'documento_rrhh', creado.id, 'cargó un documento',
    `${t.nombre} · ${td.nombre}${vence ? ` · vence ${vence}` : ''}`);
  return { documento: creado, propuso_vencimiento: vence && !fechaO(cuerpo.fecha_vencimiento) };
}

export async function editarDocumento(env, quien, id, cuerpo) {
  const d = await primero(env, `documentos_trabajador?select=*,trabajadores(nombre)&id=eq.${id}`);
  if (!d) return { error: 'Ese documento no existe', status: 404 };

  const campos = {};
  if ('glosa' in cuerpo) campos.glosa = limpio(cuerpo.glosa, 200);
  if ('numero' in cuerpo) campos.numero = limpio(cuerpo.numero, 60);
  if ('fecha_emision' in cuerpo) campos.fecha_emision = fechaO(cuerpo.fecha_emision);
  if ('fecha_vencimiento' in cuerpo) campos.fecha_vencimiento = fechaO(cuerpo.fecha_vencimiento);
  if ('observacion' in cuerpo) campos.observacion = limpio(cuerpo.observacion, 500);
  if ('enlace' in cuerpo) {
    const e = limpio(cuerpo.enlace, 500);
    if (e && !/^https?:\/\//i.test(e)) {
      return { error: 'El enlace tiene que empezar con http:// o https://', status: 400 };
    }
    campos.enlace = e;
  }
  // El documento no se borra: se anula. Lo que se cargó alguna vez y después
  // se retiró es información, y la bitácora sola no alcanza para verlo.
  if ('vigente' in cuerpo) campos.vigente = siNo(cuerpo.vigente);

  if (!Object.keys(campos).length) return { error: 'No hay nada que cambiar', status: 400 };
  await actualizar(env, `documentos_trabajador?id=eq.${d.id}`, campos);
  await anotar(env, quien, 'documento_rrhh', d.id,
    campos.vigente === false ? 'anuló un documento' : 'editó un documento',
    d.trabajadores?.nombre || '');
  return { ok: true };
}

// ---------------------------------------------------------------- ausencias
export async function crearAusencia(env, quien, cuerpo) {
  const t = await primero(env,
    `trabajadores?select=*&id=eq.${entero(cuerpo.trabajador_id)}`);
  if (!t) return { error: 'Esa persona no está en el registro', status: 404 };

  const tipo = TIPOS_AUSENCIA.includes(cuerpo.tipo) ? cuerpo.tipo : null;
  if (!tipo) return { error: 'Falta el tipo de ausencia', status: 400 };

  const desde = fechaO(cuerpo.desde);
  const hasta = fechaO(cuerpo.hasta);
  if (!desde || !hasta) return { error: 'Faltan las fechas', status: 400 };
  if (hasta < desde) return { error: 'El hasta es anterior al desde', status: 400 };
  if (diasCorridos(desde, hasta) > 400) {
    return { error: 'El rango no puede pasar de un año', status: 400 };
  }

  // Dos ausencias encima no son dos ausencias: es una cargada dos veces, o un
  // error de fechas. Cualquiera de las dos descuadra el feriado.
  const choque = await primero(env,
    `ausencias?select=id,tipo,desde,hasta&trabajador_id=eq.${t.id}`
    + `&estado=in.(solicitada,aprobada)&desde=lte.${hasta}&hasta=gte.${desde}`);
  if (choque) {
    return { error: `Ya hay una ausencia cargada del ${choque.desde} al ${choque.hasta} `
      + `(${choque.tipo}). Revísela antes de cargar esta.`, status: 409 };
  }

  const habilesCalculados = diasHabiles(desde, hasta);
  // El cálculo propone; quien registra puede corregirlo. Hay feriados
  // regionales y días declarados por ley que el sistema no conoce.
  const habiles = decimal(cuerpo.dias_habiles);
  const estado = ['solicitada', 'aprobada', 'rechazada', 'anulada'].includes(cuerpo.estado)
    ? cuerpo.estado : 'aprobada';

  const fila = {
    trabajador_id: t.id,
    tipo,
    desde,
    hasta,
    dias_habiles: habiles === null ? habilesCalculados : habiles,
    dias_corridos: diasCorridos(desde, hasta),
    folio: limpio(cuerpo.folio, 60),
    motivo: limpio(cuerpo.motivo, 500),
    estado,
    con_goce: 'con_goce' in cuerpo ? siNo(cuerpo.con_goce) : tipo !== 'permiso_sin_goce',
    aprobada_por: estado === 'aprobada' ? quien : null,
    creado_por: quien,
  };

  const [creada] = await insertar(env, 'ausencias', fila);

  // Si es feriado, decir en el momento cómo queda el saldo: enterarse en
  // marzo de que alguien se tomó días que no tenía no sirve de nada.
  let saldo = null;
  if (AUSENCIAS_DE_FERIADO.has(tipo)) {
    const ausencias = await buscar(env,
      `ausencias?select=tipo,desde,dias_habiles,estado&trabajador_id=eq.${t.id}`);
    saldo = saldoFeriado(t, ausencias);
  }

  await anotar(env, quien, 'ausencia', creada.id, 'registró una ausencia',
    `${t.nombre} · ${tipo} del ${desde} al ${hasta}`);
  return {
    ausencia: creada,
    habiles_calculados: habilesCalculados,
    feriados: feriadosEnRango(desde, hasta),
    saldo,
  };
}

export async function editarAusencia(env, quien, id, cuerpo) {
  const a = await primero(env, `ausencias?select=*,trabajadores(nombre)&id=eq.${id}`);
  if (!a) return { error: 'Esa ausencia no existe', status: 404 };

  const campos = {};
  if ('estado' in cuerpo && ['solicitada', 'aprobada', 'rechazada', 'anulada'].includes(cuerpo.estado)) {
    campos.estado = cuerpo.estado;
    if (cuerpo.estado === 'aprobada') campos.aprobada_por = quien;
  }
  if ('dias_habiles' in cuerpo) {
    const d = decimal(cuerpo.dias_habiles);
    if (d === null || d < 0) return { error: 'Los días hábiles no son un número válido', status: 400 };
    campos.dias_habiles = d;
  }
  if ('folio' in cuerpo) campos.folio = limpio(cuerpo.folio, 60);
  if ('motivo' in cuerpo) campos.motivo = limpio(cuerpo.motivo, 500);

  if (!Object.keys(campos).length) return { error: 'No hay nada que cambiar', status: 400 };
  await actualizar(env, `ausencias?id=eq.${a.id}`, campos);
  await anotar(env, quien, 'ausencia', a.id, 'editó una ausencia',
    `${a.trabajadores?.nombre || ''} · ${campos.estado || ''}`);
  return { ok: true };
}

// ---------------------------------------------------------------- liquidación
/**
 * Liquidación estimada de un mes.
 *
 * Es una estimación y se dice así en pantalla. El documento que se entrega al
 * trabajador lo emite el sistema de remuneraciones; esto sirve para saber de
 * antemano cuánto va a costar un turno, cuánto le va a llegar a la persona y
 * dónde se fue la diferencia. Cada línea dice de qué parámetro salió.
 */
/**
 * Asignación familiar: cuánto corresponde por las cargas de esta persona.
 *
 * La paga el empleador y se la reintegran, así que es un haber **no
 * imponible**: no se le descuenta AFP ni salud ni impuesto. El monto por carga
 * sale del tramo de renta (Ley 18.020), y tanto los montos como los topes de
 * cada tramo los fija la ley todos los años: viven en `parametros_rrhh` y los
 * escribe RRHH, no están en el código.
 *
 * Reglas que se aplican:
 *  - Solo entran las cargas **acreditadas** ante el IPS o la caja, y vigentes
 *    al mes que se calcula. Una carga cargada pero no acreditada se ve en la
 *    ficha y no se paga, porque así es como funciona.
 *  - Una carga con invalidez cuenta **doble** (art. 2 Ley 18.020).
 *    **PENDIENTE VALIDAR** con quien lleva las remuneraciones antes de usar
 *    este número para pagar.
 *  - Sobre el tope del tramo C es tramo D: no corresponde asignación.
 *
 * `renta` es la renta mensual con que se mira el tramo. La ley habla del
 * promedio de los ingresos del semestre; acá se usa el imponible del mes, que
 * es lo que el sistema tiene, y la nota lo dice.
 */
export function asignacionFamiliar({ p, renta, cargas = [] }) {
  const notas = [];
  const unidades = cargas.reduce((n, c) => n + (c.invalidez ? 2 : 1), 0);
  if (!unidades) return { tramo: null, por_carga: 0, unidades: 0, monto: 0, notas };

  const tramos = [
    ['A', valor(p, 'asig_familiar_tope_a', 0), valor(p, 'asig_familiar_a', 0)],
    ['B', valor(p, 'asig_familiar_tope_b', 0), valor(p, 'asig_familiar_b', 0)],
    ['C', valor(p, 'asig_familiar_tope_c', 0), valor(p, 'asig_familiar_c', 0)],
  ];

  // Sin los topes cargados no hay forma de saber en qué tramo cae: se dice y
  // no se inventa un monto. Mismo criterio que con la UTM y el impuesto único.
  if (!tramos.some(([, tope]) => tope > 0)) {
    notas.push(`Esta persona tiene ${unidades === 1 ? 'una carga acreditada' : `${unidades} cargas acreditadas`}, `
      + 'pero los tramos de la asignación familiar están en cero: no se calculó. '
      + 'Cárguelos en Parámetros.');
    return { tramo: null, por_carga: 0, unidades, monto: 0, notas, sin_parametros: true };
  }

  const encontrado = tramos.find(([, tope]) => tope > 0 && renta <= tope);
  if (!encontrado) {
    notas.push('Por su renta, esta persona está en el tramo D: no corresponde asignación '
      + 'familiar aunque tenga cargas acreditadas.');
    return { tramo: 'D', por_carga: 0, unidades, monto: 0, notas };
  }

  const [tramo, , porCarga] = encontrado;
  if (!porCarga) {
    notas.push(`Cae en el tramo ${tramo}, pero el monto por carga de ese tramo está en cero. `
      + 'Cárguelo en Parámetros.');
  }
  if (cargas.some((c) => c.invalidez)) {
    notas.push('Hay cargas con invalidez contadas al doble (art. 2 Ley 18.020). '
      + 'Confírmelo con quien lleva las remuneraciones antes de pagar con este número.');
  }
  return { tramo, por_carga: porCarga, unidades, monto: Math.round(porCarga * unidades), notas };
}

/** Las cargas que corresponde pagar en ese mes: acreditadas y vigentes. */
export const cargasQueCorresponden = (cargas, hasta) => (cargas || []).filter((c) =>
  c.acreditada && c.desde <= hasta && (!c.hasta || c.hasta >= hasta));

export function liquidar({ contrato, trabajador, p, afp, uf, utm, extra = {}, cargas = [] }) {
  const notas = [];
  const base = peso(contrato.sueldo_base);
  const bono = peso(contrato.bono_imponible_monto) + peso(extra.bono_imponible);
  const horasExtra = peso(extra.horas_extra_monto);

  // Gratificación del art. 50: 25% de lo devengado, con tope de 4,75 ingresos
  // mínimos al año, o sea 4,75/12 al mes.
  const imm = valor(p, 'imm', 0);
  const topeGratif = Math.floor(valor(p, 'gratif_tope_imm', 4.75) * imm / 12);
  let gratificacion = 0;
  if (contrato.gratificacion === 'legal_25') {
    gratificacion = Math.min(Math.round(0.25 * (base + bono)), topeGratif);
    if (gratificacion === topeGratif && topeGratif > 0) {
      notas.push(`La gratificación quedó en el tope legal ($${topeGratif.toLocaleString('es-CL')} al mes).`);
    }
  } else if (contrato.gratificacion === 'convencional') {
    gratificacion = peso(contrato.gratificacion_monto);
  }

  const imponible = base + bono + gratificacion + horasExtra;

  // Topes imponibles: van en UF, así que sin el valor de la UF del mes el
  // cálculo no se puede hacer bien. Se dice en vez de inventarlo.
  const topeImp = uf ? Math.round(valor(p, 'tope_imponible_uf', 0) * uf) : null;
  const topeAfc = uf ? Math.round(valor(p, 'tope_afc_uf', 0) * uf) : null;
  if (!uf) notas.push('Sin el valor de la UF del mes no se aplican los topes imponibles. '
    + 'Cárguelo en Parámetros.');

  const baseImponible = topeImp ? Math.min(imponible, topeImp) : imponible;
  const baseAfc = topeAfc ? Math.min(imponible, topeAfc) : imponible;

  // AFP: 10% más la comisión de la administradora. Un pensionado que sigue
  // trabajando no cotiza (DL 3.500).
  const comision = Number(afp?.comision) || 0;
  const tasaAfp = trabajador.jubilado ? 0 : valor(p, 'afp_cotizacion', 10) + comision;
  const descAfp = Math.round(baseImponible * tasaAfp / 100);
  if (!trabajador.jubilado && !afp) {
    notas.push('La ficha no tiene AFP: se calculó solo el 10% sin comisión.');
  }

  // Salud: 7% para Fonasa. En isapre el plan pactado puede ser mayor, y la
  // diferencia la paga el trabajador.
  const tasaSalud = valor(p, 'salud_cotizacion', 7);
  const salud7 = Math.round(baseImponible * tasaSalud / 100);
  let descSalud = salud7;
  let saludAdicional = 0;
  if (trabajador.salud_sistema === 'isapre' && trabajador.salud_plan_uf && uf) {
    const plan = Math.round(Number(trabajador.salud_plan_uf) * uf);
    descSalud = Math.max(salud7, plan);
    saludAdicional = descSalud - salud7;
  } else if (trabajador.salud_sistema === 'isapre' && !uf) {
    notas.push('Está en isapre pero no hay valor de UF: el plan no se pudo convertir a pesos.');
  }

  // Seguro de cesantía: el 0,6% del trabajador solo en contrato indefinido.
  const descAfc = contrato.tipo === 'indefinido'
    ? Math.round(baseAfc * valor(p, 'afc_trabajador', 0.6) / 100) : 0;

  const previsional = descAfp + descSalud + descAfc;
  const tributable = Math.max(0, imponible - previsional);

  // Impuesto único de segunda categoría. Sin UTM no se puede calcular.
  let impuesto = 0;
  let tramo = null;
  if (utm) {
    const enUtm = tributable / utm;
    const t = (extra.tramos || []).find((x) =>
      enUtm > Number(x.desde_utm) && (x.hasta_utm === null || enUtm <= Number(x.hasta_utm)));
    if (t) {
      tramo = t.tramo;
      impuesto = Math.max(0, Math.round(tributable * Number(t.factor) - Number(t.rebaja_utm) * utm));
    }
  } else {
    notas.push('Sin el valor de la UTM del mes no se calculó el impuesto único. '
      + 'Cárguelo en Parámetros.');
  }

  // La asignación familiar se mira con el imponible del mes, que es la renta
  // que el sistema conoce. No se le descuenta nada: es no imponible.
  const asigFamiliar = asignacionFamiliar({ p, renta: imponible, cargas });
  notas.push(...asigFamiliar.notas);

  const noImponible = peso(contrato.colacion) + peso(contrato.movilizacion)
    + peso(contrato.asignacion_monto) + peso(extra.no_imponible) + asigFamiliar.monto;
  const apv = peso(trabajador.apv_monto);
  const otrosDescuentos = peso(extra.otros_descuentos);

  const liquido = imponible + noImponible - previsional - impuesto - apv - otrosDescuentos;

  // Costo para la empresa: lo que se paga más lo que se cotiza por encima.
  const sis = Math.round(baseImponible * valor(p, 'sis', 0) / 100);
  const afcEmpleador = Math.round(baseAfc * valor(p,
    contrato.tipo === 'indefinido' ? 'afc_empleador_ind' : 'afc_empleador_plazo', 0) / 100);
  const mutual = Math.round(baseImponible
    * (valor(p, 'mutual_basica', 0) + valor(p, 'mutual_adicional', 0)) / 100);
  const sanna = Math.round(baseImponible * valor(p, 'sanna', 0) / 100);
  const aporteReforma = Math.round(baseImponible * valor(p, 'aporte_empleador_prev', 0) / 100);
  const costoEmpresa = imponible + noImponible + sis + afcEmpleador + mutual + sanna + aporteReforma;

  if (imm && base < imm && contrato.jornada_tipo !== 'parcial') {
    notas.push(`El sueldo base ($${base.toLocaleString('es-CL')}) está bajo el ingreso mínimo `
      + `vigente ($${imm.toLocaleString('es-CL')}).`);
  }

  return {
    haberes: {
      sueldo_base: base,
      bono_imponible: bono,
      horas_extra: horasExtra,
      gratificacion,
      total_imponible: imponible,
      colacion: peso(contrato.colacion),
      movilizacion: peso(contrato.movilizacion),
      asignacion: peso(contrato.asignacion_monto) + peso(extra.no_imponible),
      asignacion_familiar: asigFamiliar.monto,
      asignacion_familiar_detalle: asigFamiliar,
      total_no_imponible: noImponible,
      total_haberes: imponible + noImponible,
    },
    descuentos: {
      afp: descAfp, afp_tasa: tasaAfp, afp_nombre: afp?.nombre || null,
      salud: descSalud, salud_7: salud7, salud_adicional: saludAdicional,
      cesantia: descAfc,
      total_previsional: previsional,
      impuesto_unico: impuesto, tramo,
      apv, otros: otrosDescuentos,
      total_descuentos: previsional + impuesto + apv + otrosDescuentos,
    },
    bases: {
      imponible: baseImponible, tributable, cesantia: baseAfc,
      tope_imponible: topeImp, tope_cesantia: topeAfc, uf, utm, imm,
    },
    empresa: {
      sis, cesantia: afcEmpleador, mutual, sanna, reforma_previsional: aporteReforma,
      total_cotizaciones: sis + afcEmpleador + mutual + sanna + aporteReforma,
      costo_total: costoEmpresa,
    },
    liquido,
    notas,
    por_confirmar: sinConfirmar(p, ['imm', 'sis', 'mutual_adicional', 'tope_imponible_uf',
                                    'tope_afc_uf', 'aporte_empleador_prev', 'uf', 'utm']),
  };
}

// ---------------------------------------------------------------- finiquito
/**
 * Finiquito estimado.
 *
 * Qué paga cada causal no lo decide el sistema: lo decide el art. 163. Lo que
 * el sistema hace es no dejar que una causal del art. 160 arrastre
 * indemnización por años de servicio, que es el error que termina en demanda.
 */
export function calcularFiniquito({ trabajador, contrato, causal, fechaTermino, avisoDado,
                                     baseManual, saldo, p, uf }) {
  const def = CAUSALES[causal];
  if (!def) return { error: 'Causal desconocida' };

  const notas = [];
  const ingreso = trabajador.fecha_ingreso || contrato.fecha_inicio;

  // Base del art. 172: lo que percibe mensualmente, sin horas extra ni
  // beneficios esporádicos. Si RRHH escribe una base, manda la suya: hay
  // bonos y regalías que el sistema no tiene cargados.
  const baseCalculada = peso(contrato.sueldo_base)
    + peso(contrato.bono_imponible_monto)
    + peso(contrato.colacion) + peso(contrato.movilizacion) + peso(contrato.asignacion_monto);
  const base = baseManual ? peso(baseManual) : baseCalculada;
  if (!baseManual) {
    notas.push('La base incluye sueldo, bonos fijos, colación y movilización, y excluye horas '
      + 'extra y beneficios esporádicos (art. 172). Revísela: puede haber regalías no cargadas.');
  }

  // Tope de 90 UF para la base de la indemnización.
  const topeUf = valor(p, 'tope_ias_uf', 90);
  const topePesos = uf ? Math.round(topeUf * uf) : null;
  const baseTopada = topePesos ? Math.min(base, topePesos) : base;
  if (topePesos && base > topePesos) {
    notas.push(`La base se topó en ${topeUf} UF ($${topePesos.toLocaleString('es-CL')}).`);
  }
  if (!uf) notas.push('Sin el valor de la UF no se pudo aplicar el tope de 90 UF.');

  // Años de servicio: cada año y la fracción superior a seis meses, con tope
  // de 11 años (art. 163).
  const meses = mesesEntre(ingreso, fechaTermino);
  const aniosEnteros = Math.floor(meses / 12);
  const mesesSobrantes = meses % 12;
  const aniosCobrables = Math.min(aniosEnteros + (mesesSobrantes > 6 ? 1 : 0),
                                  valor(p, 'tope_ias_anios', 11));

  const ias = def.ias ? baseTopada * aniosCobrables : 0;
  if (def.ias && aniosEnteros >= valor(p, 'tope_ias_anios', 11)) {
    notas.push(`La indemnización por años de servicio está topada en ${valor(p, 'tope_ias_anios', 11)} años.`);
  }
  if (def.ias && meses < 12) {
    notas.push('Con menos de un año de servicio no corresponde indemnización por años de servicio.');
  }

  const avisoPrevio = def.aviso && !avisoDado ? baseTopada : 0;
  if (def.aviso && !avisoDado) {
    notas.push('Se agrega el mes de aviso previo (art. 162): el aviso se da con 30 días de '
      + 'anticipación o se paga esa indemnización.');
  }

  // Feriado proporcional: los días hábiles pendientes, pagados con la
  // remuneración íntegra. Los días hábiles se llevan a días corridos porque el
  // feriado se paga incluyendo los inhábiles que quedan dentro (art. 73).
  const diasPendientes = Math.max(0, Number(saldo?.saldo) || 0);
  const diasCorridosFeriado = Math.round(diasPendientes * 7 / 5 * 100) / 100;
  const feriado = Math.round(base / 30 * diasCorridosFeriado);
  if (diasPendientes > 0) {
    notas.push(`El feriado proporcional son ${diasPendientes} días hábiles pendientes, que se `
      + `pagan como ${diasCorridosFeriado} días corridos (art. 73 inc. final).`);
  }
  if (saldo?.sin_fecha_ingreso) {
    notas.push('La ficha no tiene fecha de ingreso: el feriado proporcional no se pudo calcular.');
  }

  const total = ias + avisoPrevio + feriado;

  return {
    causal, causal_glosa: def.glosa,
    ingreso, termino: fechaTermino,
    meses_servicio: meses,
    anios_cobrables: aniosCobrables,
    base, base_topada: baseTopada, tope_pesos: topePesos,
    lineas: [
      { glosa: `Indemnización por años de servicio (${aniosCobrables} ${aniosCobrables === 1 ? 'año' : 'años'})`,
        monto: ias, aplica: def.ias },
      { glosa: 'Indemnización sustitutiva del aviso previo', monto: avisoPrevio, aplica: def.aviso },
      { glosa: `Feriado proporcional (${diasPendientes} días hábiles)`, monto: feriado, aplica: true },
    ],
    total,
    notas,
    por_confirmar: sinConfirmar(p, ['tope_ias_uf', 'uf']),
    advertencia: 'Es una estimación. No reemplaza el finiquito, que se ratifica ante ministro '
      + 'de fe y se paga dentro de 10 días hábiles desde la separación (art. 177 CT).',
  };
}

// ---------------------------------------------------------------- panel
const DIAS_AVISO = 45;

/**
 * Lo que hay que mirar hoy. El orden no es casual: primero lo que ya está
 * vencido y tiene a alguien trabajando igual, después lo que vence pronto, y
 * al final lo que falta cargar.
 */
export async function panelRrhh(env) {
  const hoy = hoyISO();
  const limite = sumarDias(hoy, DIAS_AVISO);

  const [personal, documentos, contratos, ausencias, tipos] = await Promise.all([
    buscar(env, 'v_personal?select=*&activo=is.true&order=nombre.asc'),
    buscar(env, 'v_documentos?select=*&trabajador_activo=is.true&vigente=is.true'
      + `&fecha_vencimiento=not.is.null&fecha_vencimiento=lte.${limite}`
      + '&order=fecha_vencimiento.asc'),
    buscar(env, 'contratos?select=*,trabajadores(nombre,rut,activo)&estado=eq.vigente'),
    buscar(env, `ausencias?select=*,trabajadores(nombre)&estado=in.(solicitada,aprobada)`
      + `&hasta=gte.${hoy}&desde=lte.${sumarDias(hoy, 30)}&order=desde.asc`),
    buscar(env, 'tipos_documento?select=*&activo=is.true&obligatorio=is.true'),
  ]);

  const activos = personal.filter((t) => t.activo);

  // Documentos vencidos y por vencer, ya separados: son dos urgencias
  // distintas y mezclarlas hace que la segunda tape a la primera.
  const vencidos = documentos.filter((d) => d.estado === 'vencido');
  const porVencer = documentos.filter((d) => d.estado === 'por_vencer');

  // Contratos a plazo que se vencen. Es la alerta más cara de todas: pasado un
  // día, el contrato es indefinido.
  const plazoPorVencer = contratos
    .filter((c) => c.fecha_termino && c.fecha_termino <= limite && c.trabajadores?.activo)
    .map((c) => ({
      contrato_id: c.id, trabajador_id: c.trabajador_id,
      trabajador: c.trabajadores?.nombre, tipo: c.tipo,
      fecha_termino: c.fecha_termino,
      dias: Math.round((Date.parse(c.fecha_termino) - Date.parse(hoy)) / 86400000),
    }))
    .sort((a, b) => a.fecha_termino.localeCompare(b.fecha_termino));

  // Resoluciones de turnos excepcionales. Vencida, el 4x4 deja de estar
  // autorizado aunque el turno siga saliendo igual todas las semanas.
  const resoluciones = contratos
    .filter((c) => c.resolucion_vence && c.resolucion_vence <= limite && c.trabajadores?.activo)
    .map((c) => ({
      contrato_id: c.id, trabajador: c.trabajadores?.nombre,
      resolucion: c.resolucion_dt, vence: c.resolucion_vence,
      dias: Math.round((Date.parse(c.resolucion_vence) - Date.parse(hoy)) / 86400000),
    }));

  // Quién no tiene contrato cargado. Sin contrato no hay nada: ni sueldo que
  // calcular, ni causal que invocar, ni papel que mostrar.
  const sinContrato = activos.filter((t) => t.sin_contrato)
    .map((t) => ({ id: t.id, nombre: t.nombre, rut: formatearRut(t.rut), cargo: t.cargo }));

  // Qué papel obligatorio le falta a quién. Se arma con el catálogo, así que
  // agregar una exigencia nueva no requiere tocar este código.
  const porTrabajador = new Map();
  const todosDocs = await buscar(env,
    'v_documentos?select=trabajador_id,tipo,estado&trabajador_activo=is.true&vigente=is.true');
  for (const d of todosDocs) {
    if (!porTrabajador.has(d.trabajador_id)) porTrabajador.set(d.trabajador_id, new Set());
    // Cuenta como "lo tiene" aunque esté vencido: lo vencido ya sale arriba, en
    // su propia lista y en rojo. Si además apareciera acá como faltante, la
    // misma credencial estaría en dos listas y ninguna de las dos se creería.
    porTrabajador.get(d.trabajador_id).add(d.tipo);
  }
  const faltantes = [];
  for (const t of activos) {
    const tiene = porTrabajador.get(t.id) || new Set();
    const faltan = tipos
      .filter((td) => td.aplica_a === 'todos'
        || (td.aplica_a === 'guardia' && ['guardia', 'nochero', 'rondin', 'supervisor'].includes(t.cargo))
        || (td.aplica_a === 'conductor' && t.cargo === 'conductor'))
      .filter((td) => !tiene.has(td.codigo))
      .map((td) => td.nombre);
    if (faltan.length) {
      faltantes.push({ id: t.id, nombre: t.nombre, cargo: t.cargo, faltan });
    }
  }

  const fichasIncompletas = activos
    .filter((t) => !t.fecha_ingreso || !t.afp || !t.salud_sistema)
    .map((t) => ({
      id: t.id, nombre: t.nombre,
      falta: [!t.fecha_ingreso && 'fecha de ingreso', !t.afp && 'AFP',
              !t.salud_sistema && 'sistema de salud'].filter(Boolean),
    }));

  const p = await parametros(env, hoy);

  return {
    hoy,
    dias_aviso: DIAS_AVISO,
    dotacion: {
      activos: activos.length,
      total: personal.length,
      por_cargo: activos.reduce((a, t) => { a[t.cargo] = (a[t.cargo] || 0) + 1; return a; }, {}),
      con_contrato: activos.filter((t) => !t.sin_contrato).length,
    },
    vencidos,
    por_vencer: porVencer,
    plazo_por_vencer: plazoPorVencer,
    resoluciones,
    sin_contrato: sinContrato,
    faltantes,
    fichas_incompletas: fichasIncompletas,
    ausencias_vigentes: ausencias,
    parametros_por_confirmar: Object.values(p).filter((x) => x.por_confirmar)
      .map((x) => ({ codigo: x.codigo, glosa: x.glosa, valor: Number(x.valor),
                     unidad: x.unidad, base_legal: x.base_legal, vigente_desde: x.vigente_desde })),
  };
}

// ---------------------------------------------------------------- ficha completa
export async function fichaCompleta(env, id) {
  const t = await primero(env, `trabajadores?select=*,instalaciones(nombre)&id=eq.${id}`);
  if (!t) return null;

  const [contratos, documentos, ausencias, cargas] = await Promise.all([
    buscar(env, `contratos?select=*,instalaciones(nombre)&trabajador_id=eq.${id}&order=fecha_inicio.desc`),
    buscar(env, `v_documentos?select=*&trabajador_id=eq.${id}&order=fecha_vencimiento.asc.nullslast,creado_en.desc`),
    buscar(env, `ausencias?select=*&trabajador_id=eq.${id}&order=desde.desc`),
    // Si la migración de cargas no se aplicó, la ficha se abre igual y la
    // sección avisa: nadie aplica las migraciones solo desde el 14-10-2026.
    buscar(env, `cargas_familiares?select=*&trabajador_id=eq.${id}&order=desde.desc`)
      .catch(() => null),
  ]);

  // La clave derivada no sale nunca, ni siquiera hacia la pantalla de RRHH.
  const { clave, ...ficha } = t;

  return {
    ficha: { ...ficha, rut: formatearRut(t.rut), rut_plano: t.rut,
             instalacion: t.instalaciones?.nombre ?? null },
    contratos,
    contrato_vigente: contratos.find((c) => c.estado === 'vigente') || null,
    documentos,
    ausencias,
    cargas,
    feriado: saldoFeriado(t, ausencias),
  };
}

// ----------------------------------------------------------- cargas familiares
const PARENTESCOS = ['hijo', 'conyuge', 'madre', 'nieto', 'hermano', 'otro'];

export async function crearCarga(env, quien, cuerpo) {
  const t = await primero(env, `trabajadores?select=id,nombre&id=eq.${entero(cuerpo.trabajador_id)}`);
  if (!t) return { error: 'Esa persona no está en el registro', status: 404 };

  const nombre = limpio(cuerpo.nombre, 120);
  if (!nombre) return { error: 'Falta el nombre de la carga', status: 400 };

  const desde = fechaO(cuerpo.desde);
  if (!desde) return { error: 'Falta desde cuándo corresponde', status: 400 };
  const hasta = fechaO(cuerpo.hasta);
  if (hasta && hasta < desde) return { error: 'El hasta es anterior al desde', status: 400 };

  const fila = {
    trabajador_id: t.id,
    nombre,
    rut: limpio(cuerpo.rut, 15) || null,
    parentesco: PARENTESCOS.includes(cuerpo.parentesco) ? cuerpo.parentesco : 'hijo',
    fecha_nacimiento: fechaO(cuerpo.fecha_nacimiento),
    desde,
    hasta,
    acreditada: siNo(cuerpo.acreditada),
    invalidez: siNo(cuerpo.invalidez),
    notas: limpio(cuerpo.notas, 300) || null,
    creado_por: quien,
  };

  const [creada] = await insertar(env, 'cargas_familiares', fila);
  await anotar(env, quien, 'carga_familiar', creada.id, 'cargó una carga familiar',
    `${t.nombre} · ${nombre}${fila.acreditada ? '' : ' (sin acreditar, no se paga todavía)'}`);
  return { carga: creada };
}

export async function editarCarga(env, quien, id, cuerpo) {
  const c = await primero(env,
    `cargas_familiares?select=*,trabajadores(nombre)&id=eq.${id}`);
  if (!c) return { error: 'Esa carga no existe', status: 404 };

  const campos = {};
  if ('nombre' in cuerpo) {
    const n = limpio(cuerpo.nombre, 120);
    if (!n) return { error: 'Falta el nombre de la carga', status: 400 };
    campos.nombre = n;
  }
  if ('rut' in cuerpo) campos.rut = limpio(cuerpo.rut, 15) || null;
  if ('parentesco' in cuerpo && PARENTESCOS.includes(cuerpo.parentesco)) {
    campos.parentesco = cuerpo.parentesco;
  }
  if ('fecha_nacimiento' in cuerpo) campos.fecha_nacimiento = fechaO(cuerpo.fecha_nacimiento);
  if ('desde' in cuerpo) {
    const d = fechaO(cuerpo.desde);
    if (!d) return { error: 'Falta desde cuándo corresponde', status: 400 };
    campos.desde = d;
  }
  // El hasta es lo que más se usa: un hijo que cumple 18 deja de ser carga ese
  // día, se escribe acá y la liquidación deja de contarlo sola.
  if ('hasta' in cuerpo) campos.hasta = fechaO(cuerpo.hasta);
  if ('acreditada' in cuerpo) campos.acreditada = siNo(cuerpo.acreditada);
  if ('invalidez' in cuerpo) campos.invalidez = siNo(cuerpo.invalidez);
  if ('notas' in cuerpo) campos.notas = limpio(cuerpo.notas, 300) || null;

  if (!Object.keys(campos).length) return { error: 'No hay nada que cambiar', status: 400 };

  const desde = campos.desde ?? c.desde;
  const hasta = 'hasta' in campos ? campos.hasta : c.hasta;
  if (hasta && hasta < desde) return { error: 'El hasta es anterior al desde', status: 400 };

  await actualizar(env, `cargas_familiares?id=eq.${c.id}`, campos);
  await anotar(env, quien, 'carga_familiar', c.id, 'editó una carga familiar',
    `${c.trabajadores?.nombre || ''} · ${campos.nombre || c.nombre}`);
  return { ok: true };
}

export { limpio, entero, decimal, fechaO, siNo, valor, sinConfirmar };
