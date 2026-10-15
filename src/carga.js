/**
 * Carga masiva.
 *
 * El problema que resuelve: la empresa ya tiene la gente en planillas. Pedirle
 * a RRHH que teclee cien fichas una por una para empezar a usar el sistema es
 * pedirle que no lo use.
 *
 * Tres decisiones que lo gobiernan todo:
 *
 *  1. **Primero se mira, después se escribe.** Toda carga pasa dos veces: la
 *     primera en seco, que no toca nada y devuelve fila por fila qué iba a
 *     pasar; la segunda, si la persona lo aprueba, escribe. Una carga de cien
 *     filas que se descubre mala después de escrita no se deshace con un
 *     botón.
 *
 *  2. **Nunca falla entera.** Una celda mal escrita en la fila 47 no puede
 *     botar las otras 99. Se hace lo que se puede y se devuelve lo omitido con
 *     el motivo y el número de fila, que es lo que la persona necesita para ir
 *     a corregir su planilla. Es la misma regla de `lote.js`.
 *
 *  3. **El RUT es la llave.** No el nombre, que se escribe de cinco maneras.
 *     Si el RUT ya está, se actualiza esa ficha; si no, se crea. Así la misma
 *     planilla se puede volver a subir corregida sin duplicar a nadie.
 *
 * Por qué va de a 25 filas: crear una cuenta implica derivar la clave con
 * PBKDF2, que es caro a propósito. Cien de golpe se pasan del tiempo de CPU
 * que un Worker tiene por petición. La pantalla parte la planilla sola y
 * muestra el avance, que además es mejor que una barra quieta.
 */

import { buscar, insertar, actualizar, anotar } from './datos.js';
import { normalizarRut, dvCorrecto, formatearRut } from './rut.js';
import { hashear } from './sesion.js';
import { usuarioPara, CARGOS } from './asistencia.js';
import { diasHabiles, diasCorridos } from './feriados.js';
import { esFecha } from './fechas.js';
import { camposFicha, TIPOS_CONTRATO, JORNADAS, TIPOS_AUSENCIA, parametros } from './rrhh.js';

export const POR_TANDA = 25;
const MAX_FILAS = 200;

// ---------------------------------------------------------------- columnas
/**
 * Qué columna es cuál.
 *
 * Los encabezados se comparan sin tildes, sin mayúsculas y sin espacios, y
 * cada campo acepta varios nombres: la planilla que ya existe dice "Rut" o
 * "R.U.T." o "rut trabajador", y obligar a renombrar columnas antes de subir
 * es el tipo de trámite que hace que nadie suba nada.
 */
const PLANTILLAS = {
  trabajadores: {
    rotulo: 'Fichas de trabajadores',
    nota: 'Si el RUT ya está cargado, se actualiza esa ficha. Si no, se crea la persona '
        + 'y su cuenta del libro de asistencia (usuario automático, clave: su RUT).',
    columnas: [
      { campo: 'rut', nombre: 'RUT', requerido: true, ejemplo: '12.345.678-9',
        alias: ['rut', 'ruttrabajador', 'rutempleado', 'run'] },
      { campo: 'nombres', nombre: 'Nombres', requerido: 'al crear', ejemplo: 'Juan Pablo',
        alias: ['nombres', 'nombre', 'nombrespila'] },
      { campo: 'apellido_paterno', nombre: 'Apellido paterno', requerido: 'al crear', ejemplo: 'Pérez',
        alias: ['apellidopaterno', 'paterno', 'apellido1', 'primerapellido'] },
      { campo: 'apellido_materno', nombre: 'Apellido materno', ejemplo: 'Soto',
        alias: ['apellidomaterno', 'materno', 'apellido2', 'segundoapellido'] },
      { campo: 'fecha_nacimiento', nombre: 'Fecha de nacimiento', ejemplo: '1988-03-14',
        alias: ['fechanacimiento', 'fechadenacimiento', 'nacimiento', 'fechanac'] },
      { campo: 'sexo', nombre: 'Sexo (F/M/X)', ejemplo: 'M', alias: ['sexo', 'genero'] },
      { campo: 'nacionalidad', nombre: 'Nacionalidad', ejemplo: 'Chilena', alias: ['nacionalidad'] },
      { campo: 'estado_civil', nombre: 'Estado civil', ejemplo: 'Casado', alias: ['estadocivil'] },
      { campo: 'telefono', nombre: 'Teléfono', ejemplo: '+56 9 1234 5678',
        alias: ['telefono', 'fono', 'celular', 'telefonocelular'] },
      { campo: 'email', nombre: 'Correo', ejemplo: 'juan@correo.cl',
        alias: ['email', 'correo', 'correoelectronico', 'mail'] },
      { campo: 'direccion', nombre: 'Dirección', ejemplo: 'Av. Siempre Viva 742',
        alias: ['direccion', 'domicilio'] },
      { campo: 'comuna', nombre: 'Comuna', ejemplo: 'Paine', alias: ['comuna'] },
      { campo: 'region', nombre: 'Región', ejemplo: 'Metropolitana', alias: ['region'] },
      { campo: 'cargo', nombre: 'Cargo', ejemplo: 'guardia',
        alias: ['cargo', 'funcion', 'puesto'] },
      { campo: 'instalacion', nombre: 'Instalación', ejemplo: 'PMGD San Ramón',
        alias: ['instalacion', 'faena', 'parque', 'lugar', 'obra'] },
      { campo: 'fecha_ingreso', nombre: 'Fecha de ingreso', ejemplo: '2024-06-15',
        alias: ['fechaingreso', 'fechadeingreso', 'ingreso', 'fechacontratacion'] },
      { campo: 'afp', nombre: 'AFP', ejemplo: 'Modelo', alias: ['afp', 'prevision'] },
      { campo: 'salud_sistema', nombre: 'Salud (fonasa/isapre)', ejemplo: 'fonasa',
        alias: ['saludsistema', 'salud', 'sistemasalud', 'prevision salud'] },
      { campo: 'salud_isapre', nombre: 'Isapre', ejemplo: 'Consalud', alias: ['isapre', 'saludisapre'] },
      { campo: 'salud_plan_uf', nombre: 'Plan de isapre (UF)', ejemplo: '3,5',
        alias: ['planuf', 'saludplanuf', 'planisapre', 'planisapreuf'] },
      { campo: 'banco', nombre: 'Banco', ejemplo: 'BancoEstado', alias: ['banco'] },
      { campo: 'cuenta_tipo', nombre: 'Tipo de cuenta', ejemplo: 'Cuenta RUT',
        alias: ['cuentatipo', 'tipocuenta', 'tipodecuenta'] },
      { campo: 'cuenta_numero', nombre: 'N° de cuenta', ejemplo: '12345678',
        alias: ['cuentanumero', 'numerocuenta', 'ndecuenta', 'cuenta'] },
      { campo: 'emergencia_nombre', nombre: 'Contacto de emergencia', ejemplo: 'María Soto',
        alias: ['emergencianombre', 'contactoemergencia', 'emergencia'] },
      { campo: 'emergencia_telefono', nombre: 'Teléfono de emergencia', ejemplo: '+56 9 8765 4321',
        alias: ['emergenciatelefono', 'telefonoemergencia', 'fonoemergencia'] },
      { campo: 'emergencia_parentesco', nombre: 'Parentesco', ejemplo: 'Cónyuge',
        alias: ['emergenciaparentesco', 'parentesco'] },
      { campo: 'talla_uniforme', nombre: 'Talla de uniforme', ejemplo: 'L',
        alias: ['tallauniforme', 'talla'] },
      { campo: 'talla_zapato', nombre: 'Talla de zapato', ejemplo: '42',
        alias: ['tallazapato', 'zapato', 'calzado'] },
      { campo: 'anios_previos', nombre: 'Años previos acreditados', ejemplo: '0',
        alias: ['aniosprevios', 'anosprevios', 'aniosanteriores'] },
      { campo: 'feriado_saldo_inicial', nombre: 'Saldo de feriado (días hábiles)', ejemplo: '12,5',
        alias: ['feriadosaldoinicial', 'saldoferiado', 'vacacionespendientes', 'diasferiado'] },
      { campo: 'feriado_saldo_al', nombre: 'Saldo de feriado al', ejemplo: '2026-10-01',
        alias: ['feriadosaldoal', 'saldoferiadoal', 'feriadoal'] },
      { campo: 'observaciones', nombre: 'Observaciones', ejemplo: '',
        alias: ['observaciones', 'observacion', 'notas', 'comentarios'] },
    ],
  },

  contratos: {
    rotulo: 'Contratos',
    nota: 'La persona tiene que estar cargada. Un contrato nuevo cierra el anterior, '
        + 'con fecha del día antes.',
    columnas: [
      { campo: 'rut', nombre: 'RUT', requerido: true, ejemplo: '12.345.678-9',
        alias: ['rut', 'ruttrabajador', 'run'] },
      { campo: 'tipo', nombre: 'Tipo (indefinido/plazo_fijo/por_obra)', requerido: true,
        ejemplo: 'indefinido', alias: ['tipo', 'tipocontrato', 'tipodecontrato'] },
      { campo: 'fecha_inicio', nombre: 'Fecha de inicio', requerido: true, ejemplo: '2024-06-15',
        alias: ['fechainicio', 'desde', 'inicio', 'fechadeinicio'] },
      { campo: 'fecha_termino', nombre: 'Fecha de término', ejemplo: '',
        alias: ['fechatermino', 'hasta', 'termino', 'fechadetermino', 'vencimiento'] },
      { campo: 'cargo', nombre: 'Cargo', requerido: true, ejemplo: 'guardia',
        alias: ['cargo', 'funcion', 'puesto'] },
      { campo: 'instalacion', nombre: 'Instalación', ejemplo: 'PMGD San Ramón',
        alias: ['instalacion', 'faena', 'parque', 'lugar'] },
      { campo: 'jornada_tipo', nombre: 'Jornada', ejemplo: 'art38_2',
        alias: ['jornadatipo', 'jornada', 'tipojornada'] },
      { campo: 'horas_semanales', nombre: 'Horas semanales', ejemplo: '42',
        alias: ['horassemanales', 'horas', 'horassemana'] },
      { campo: 'turno', nombre: 'Turno', ejemplo: '4x4 de 12 horas',
        alias: ['turno', 'sistematurno', 'rol'] },
      { campo: 'resolucion_dt', nombre: 'Resolución DT', ejemplo: '1234/2025',
        alias: ['resoluciondt', 'resolucion', 'nresolucion'] },
      { campo: 'resolucion_vence', nombre: 'Resolución vence', ejemplo: '2028-03-31',
        alias: ['resolucionvence', 'vencimientoresolucion'] },
      { campo: 'sueldo_base', nombre: 'Sueldo base', requerido: true, ejemplo: '600000',
        alias: ['sueldobase', 'sueldo', 'sueldobaseimponible', 'basico'] },
      { campo: 'gratificacion', nombre: 'Gratificación (legal_25/convencional/sin)',
        ejemplo: 'legal_25', alias: ['gratificacion', 'gratif'] },
      { campo: 'colacion', nombre: 'Colación', ejemplo: '60000',
        alias: ['colacion', 'asignacioncolacion'] },
      { campo: 'movilizacion', nombre: 'Movilización', ejemplo: '50000',
        alias: ['movilizacion', 'asignacionmovilizacion', 'locomocion'] },
      { campo: 'bono_imponible_glosa', nombre: 'Bono imponible (glosa)', ejemplo: 'Bono zona',
        alias: ['bonoglosa', 'bonoimponibleglosa', 'bono'] },
      { campo: 'bono_imponible_monto', nombre: 'Bono imponible (monto)', ejemplo: '0',
        alias: ['bonomonto', 'bonoimponiblemonto', 'montobono'] },
      { campo: 'firmado', nombre: '¿Firmado? (si/no)', ejemplo: 'si',
        alias: ['firmado', 'contratofirmado'] },
    ],
  },

  documentos: {
    rotulo: 'Documentos',
    nota: 'El código del tipo tiene que ser uno de los del catálogo (hoja «Listas»). '
        + 'Si el tipo vence y no se pone fecha, se propone con la validez del catálogo.',
    columnas: [
      { campo: 'rut', nombre: 'RUT', requerido: true, ejemplo: '12.345.678-9',
        alias: ['rut', 'ruttrabajador', 'run'] },
      { campo: 'tipo', nombre: 'Tipo (código)', requerido: true, ejemplo: 'os10_credencial',
        alias: ['tipo', 'tipodocumento', 'codigo', 'documento'] },
      { campo: 'numero', nombre: 'Número o folio', ejemplo: 'A-12345',
        alias: ['numero', 'folio', 'ndocumento', 'ncredencial'] },
      { campo: 'fecha_emision', nombre: 'Fecha de emisión', ejemplo: '2025-04-20',
        alias: ['fechaemision', 'emision', 'fecha'] },
      { campo: 'fecha_vencimiento', nombre: 'Fecha de vencimiento', ejemplo: '2027-04-20',
        alias: ['fechavencimiento', 'vencimiento', 'vence', 'validohasta'] },
      { campo: 'glosa', nombre: 'Glosa', ejemplo: '', alias: ['glosa', 'descripcion', 'detalle'] },
      { campo: 'enlace', nombre: 'Enlace al archivo', ejemplo: 'https://drive.google.com/...',
        alias: ['enlace', 'link', 'url', 'archivo', 'carpeta'] },
      { campo: 'observacion', nombre: 'Observación', ejemplo: '',
        alias: ['observacion', 'observaciones', 'nota'] },
    ],
  },

  ausencias: {
    rotulo: 'Ausencias y feriados',
    nota: 'Los días hábiles se calculan solos (lunes a viernes, descontando feriados). '
        + 'Si la columna viene escrita, manda lo escrito.',
    columnas: [
      { campo: 'rut', nombre: 'RUT', requerido: true, ejemplo: '12.345.678-9',
        alias: ['rut', 'ruttrabajador', 'run'] },
      { campo: 'tipo', nombre: 'Tipo', requerido: true, ejemplo: 'feriado',
        alias: ['tipo', 'tipoausencia', 'motivo tipo'] },
      { campo: 'desde', nombre: 'Desde', requerido: true, ejemplo: '2026-02-02',
        alias: ['desde', 'fechadesde', 'inicio', 'fechainicio'] },
      { campo: 'hasta', nombre: 'Hasta', requerido: true, ejemplo: '2026-02-13',
        alias: ['hasta', 'fechahasta', 'termino', 'fechatermino'] },
      { campo: 'dias_habiles', nombre: 'Días hábiles', ejemplo: '',
        alias: ['diashabiles', 'habiles', 'dias'] },
      { campo: 'folio', nombre: 'Folio', ejemplo: '', alias: ['folio', 'numero', 'nlicencia'] },
      { campo: 'motivo', nombre: 'Motivo', ejemplo: '', alias: ['motivo', 'detalle', 'observacion'] },
      { campo: 'estado', nombre: 'Estado', ejemplo: 'aprobada', alias: ['estado'] },
    ],
  },
};

export const tipos = () => Object.keys(PLANTILLAS);

/** La plantilla, para que la pantalla arme el Excel y explique cada columna. */
export const plantilla = (tipo) => PLANTILLAS[tipo] || null;
export const plantillas = () => PLANTILLAS;

// ---------------------------------------------------------------- lectura
const sinTildes = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

const clave = (s) => sinTildes(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Empareja los encabezados de la planilla con los campos.
 * Devuelve { mapa: {encabezado -> campo}, sobran: [...] }.
 */
export function emparejar(tipo, encabezados) {
  const def = PLANTILLAS[tipo];
  if (!def) return null;
  const porAlias = new Map();
  for (const c of def.columnas) {
    porAlias.set(clave(c.nombre), c.campo);
    porAlias.set(clave(c.campo), c.campo);
    for (const a of c.alias || []) porAlias.set(clave(a), c.campo);
  }
  const mapa = {};
  const sobran = [];
  for (const e of encabezados) {
    const campo = porAlias.get(clave(e));
    if (campo && !Object.values(mapa).includes(campo)) mapa[e] = campo;
    else if (!campo) sobran.push(e);
  }
  const faltan = def.columnas
    .filter((c) => c.requerido === true && !Object.values(mapa).includes(c.campo))
    .map((c) => c.nombre);
  return { mapa, sobran, faltan };
}

/**
 * Normaliza una fecha venida de una planilla.
 *
 * Excel entrega las fechas de tres maneras según cómo estaba formateada la
 * celda, y las tres llegan acá: número de serie, texto dd/mm/aaaa o ya en ISO.
 * Si no se aceptan las tres, media planilla queda sin fecha de ingreso y nadie
 * entiende por qué.
 */
export function aFecha(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Serie de Excel: día 1 = 1900-01-01, con el error del año 1900 bisiesto.
    if (v < 1 || v > 80000) return null;
    // Se trunca el día: una celda con hora («15-06-2024 14:30») sigue siendo el
    // 15. Redondear la mandaría al 16. La pantalla, de todos modos, manda las
    // fechas ya escritas como texto; esto es el respaldo.
    const ms = Math.floor(v - 25569) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const t = String(v).trim();
  if (esFecha(t)) return t;
  let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    const f = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return esFecha(f) ? f : null;
  }
  // dd/mm/aaaa y dd-mm-aaaa, que es como se escribe acá.
  m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (m) {
    const anio = m[3].length === 2 ? `20${m[3]}` : m[3];
    const f = `${anio}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return esFecha(f) ? f : null;
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const aTexto = (v) => {
  const t = typeof v === 'string' ? v.trim() : (v === null || v === undefined ? '' : String(v));
  return t === '' ? null : t;
};

const aNumero = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // "$ 600.000" y "600.000" y "600,5": el punto es separador de miles acá.
  const t = String(v).replace(/[^\d,.-]/g, '');
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/\./g, ''));
  return Number.isFinite(n) ? n : null;
};

const aSiNo = (v) => {
  const t = clave(v);
  if (['si', 'sí', 'x', 'true', 'verdadero', '1', 'ok'].includes(t)) return true;
  if (['no', 'false', 'falso', '0', ''].includes(t)) return false;
  return null;
};

// ---------------------------------------------------------------- carga
/**
 * Valida (y opcionalmente escribe) una tanda de filas.
 *
 * `filas` son objetos ya mapeados a campos por la pantalla. Devuelve el
 * resultado fila por fila, con el número de fila de la planilla, para que
 * quien la subió sepa exactamente dónde ir a corregir.
 */
export async function cargar(env, quien, { tipo, filas, confirmar = false, desde_fila = 2 }) {
  const def = PLANTILLAS[tipo];
  if (!def) return { error: 'Ese tipo de carga no existe', status: 400 };
  if (!Array.isArray(filas) || !filas.length) {
    return { error: 'No llegó ninguna fila', status: 400 };
  }
  if (filas.length > MAX_FILAS) {
    return { error: `Son demasiadas filas de una vez (máximo ${MAX_FILAS}). `
      + 'La pantalla parte la planilla sola; si está cargando por otro medio, pártala.', status: 400 };
  }
  if (confirmar && filas.length > POR_TANDA) {
    return { error: `Al escribir, el máximo por tanda es ${POR_TANDA} filas.`, status: 400 };
  }

  const manejador = { trabajadores: cargarTrabajadores, contratos: cargarContratos,
                      documentos: cargarDocumentos, ausencias: cargarAusencias }[tipo];
  const r = await manejador(env, quien, filas, confirmar, desde_fila);

  if (confirmar) {
    const escritas = r.resultados.filter(
      (x) => x.accion === 'crear' || x.accion === 'actualizar').length;
    await anotar(env, quien, 'carga_rrhh', null, `cargó ${escritas} ${def.rotulo.toLowerCase()}`,
      `${escritas} de ${filas.length} filas`);
  }
  return {
    tipo, confirmar,
    resumen: resumir(r.resultados),
    resultados: r.resultados,
    ...(r.extra || {}),
  };
}

const resumir = (resultados) => ({
  total: resultados.length,
  nuevos: resultados.filter((x) => x.accion === 'crear').length,
  actualiza: resultados.filter((x) => x.accion === 'actualizar').length,
  errores: resultados.filter((x) => x.estado === 'error').length,
});

/** Lee el RUT de una fila y dice qué está mal, si algo lo está. */
function rutDeFila(fila) {
  const crudo = aTexto(fila.rut);
  if (!crudo) return { error: 'Falta el RUT' };
  const rut = normalizarRut(crudo);
  if (!rut) return { error: `«${crudo}» no tiene forma de RUT` };
  if (!dvCorrecto(rut)) return { error: `El dígito verificador de ${formatearRut(rut)} no calza` };
  return { rut };
}

// ---------------------------------------------------------------- trabajadores
/**
 * Deja todas las filas de una inserción con exactamente las mismas claves.
 *
 * PostgREST rechaza un lote cuyas filas no tengan las mismas columnas ("All
 * object keys must match"): inserta con un solo INSERT y necesita una lista de
 * columnas única. Como cada fila de la planilla trae las celdas que trae, sin
 * esto una carga de veinte personas falla entera porque una no puso comuna.
 *
 * `defectos` existe porque rellenar con null no sirve para las columnas que
 * son NOT NULL con valor por defecto: ahí hay que poner el defecto, no nulo.
 */
function conMismasClaves(filas, defectos = {}) {
  const claves = [...new Set(filas.flatMap((f) => Object.keys(f)))];
  return filas.map((f) => Object.fromEntries(claves.map((k) => {
    const v = f[k];
    if (k in defectos && (v === null || v === undefined)) return [k, defectos[k]];
    return [k, v === undefined ? null : v];
  })));
}

// Columnas de la ficha que la base no acepta nulas.
const DEFECTOS_FICHA = { anios_previos: 0, jubilado: false, discapacidad: false,
                         cargo: 'guardia' };

async function cargarTrabajadores(env, quien, filas, confirmar, desdeFila) {
  // Todo lo que hace falta para decidir, en dos consultas: el Worker tiene un
  // tope de peticiones salientes y una por fila lo revienta con 30 personas.
  const [existentes, instalaciones, usuariosOficina] = await Promise.all([
    buscar(env, 'trabajadores?select=id,rut,nombre,usuario,activo'),
    buscar(env, 'instalaciones?select=id,nombre'),
    buscar(env, 'usuarios?select=usuario'),
  ]);
  const porRut = new Map(existentes.map((t) => [t.rut, t]));
  const usados = new Set([...existentes.map((t) => t.usuario),
                          ...usuariosOficina.map((u) => u.usuario)]);
  const porInstalacion = new Map(instalaciones.map((i) => [clave(i.nombre), i.id]));

  const resultados = [];
  const aCrear = [];
  const aActualizar = [];
  const vistos = new Set();
  const instalacionesNuevas = new Set();

  filas.forEach((fila, i) => {
    const n = desdeFila + i;
    const { rut, error } = rutDeFila(fila);
    if (error) return resultados.push({ n, estado: 'error', motivo: error });

    // La misma persona dos veces en la planilla: la segunda pisaría a la
    // primera en silencio, y quedaría cargada la que estaba más abajo.
    if (vistos.has(rut)) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut),
        motivo: 'El RUT se repite en la planilla. Deje una sola fila por persona.' });
    }
    vistos.add(rut);

    const previo = porRut.get(rut);
    const campos = camposFicha(normalizarFila(fila, 'trabajadores'));

    // La instalación se resuelve por nombre y, si no existe, se crea: es el
    // mismo criterio que ya usan Servicios y Extras.
    const inst = aTexto(fila.instalacion);
    if (inst) {
      const id = porInstalacion.get(clave(inst));
      if (id) campos.instalacion_id = id;
      else instalacionesNuevas.add(inst);
    }

    const avisos = [];
    const cargo = aTexto(fila.cargo);
    if (cargo) {
      const c = clave(cargo);
      const valido = CARGOS.find((x) => clave(x) === c);
      if (valido) {
        campos.cargo = valido;
      } else {
        // Dejarlo pasar en silencio es cargar a alguien como guardia porque su
        // planilla decía "vigilante". Se carga igual, pero queda dicho.
        avisos.push(`El cargo «${cargo}» no está en la lista`
          + (previo ? ': se deja el que ya tenía.' : ': queda como guardia.'));
        if (!previo) campos.cargo = 'guardia';
      }
    }

    if (previo) {
      // Lo vacío no borra lo que ya está: una planilla parcial se sube para
      // completar, no para vaciar fichas.
      for (const k of Object.keys(campos)) {
        if (campos[k] === null || campos[k] === undefined) delete campos[k];
      }
      if (!Object.keys(campos).length) {
        return resultados.push({ n, estado: 'sin_cambios', accion: 'ninguna',
          rut: formatearRut(rut), nombre: previo.nombre, motivo: 'La fila no trae nada nuevo' });
      }
      aActualizar.push({ id: previo.id, campos });
      return resultados.push({ n, estado: avisos.length ? 'ojo' : 'ok', accion: 'actualizar',
        rut: formatearRut(rut), nombre: previo.nombre, avisos,
        detalle: `Se actualizan: ${Object.keys(campos).join(', ')}` });
    }

    const nombres = aTexto(fila.nombres);
    const paterno = aTexto(fila.apellido_paterno);
    if (!nombres || !paterno) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut),
        motivo: 'Es una persona nueva y faltan los nombres o el apellido paterno' });
    }
    const materno = aTexto(fila.apellido_materno);
    const base = usuarioPara(nombres, paterno, materno);
    if (!base) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut),
        motivo: 'Con ese nombre no se puede armar un usuario' });
    }
    let usuario = base;
    let k = 2;
    while (usados.has(usuario)) usuario = `${base}${k++}`;
    usados.add(usuario);

    const nombre = [nombres, paterno, materno].filter(Boolean).join(' ');
    aCrear.push({ rut, nombres, paterno, materno, nombre, usuario, campos });
    resultados.push({ n, estado: avisos.length ? 'ojo' : 'ok', accion: 'crear',
      rut: formatearRut(rut), nombre, avisos,
      detalle: `Entrará como «${usuario}», con su RUT de clave` });
  });

  const extra = {
    instalaciones_nuevas: [...instalacionesNuevas],
    nota_instalaciones: instalacionesNuevas.size
      ? 'No están en el catálogo. La ficha se carga igual, pero queda sin instalación '
        + 'asignada. El catálogo lo mantiene operaciones, en la pestaña Instalaciones: '
        + 'pídale que las cree y vuelva a subir la misma planilla, que no duplica a nadie.'
      : null,
  };

  if (!confirmar) return { resultados, extra };

  // Escribir: una sola inserción para los nuevos y un PATCH por cada ficha que
  // cambia. No hay forma de actualizar filas distintas con valores distintos
  // en una sola petición, pero la tanda es de 25 y eso cabe de sobra.
  if (aCrear.length) {
    const filasNuevas = [];
    for (const c of aCrear) {
      filasNuevas.push({
        ...c.campos,
        // Lo de abajo manda sobre lo que venga de la planilla: el nombre
        // completo, el usuario y la clave los arma el sistema, no la celda.
        rut: c.rut, nombres: c.nombres, apellido_paterno: c.paterno,
        apellido_materno: c.materno, nombre: c.nombre, usuario: c.usuario,
        clave: await hashear(c.rut),          // la clave es el RUT, guardada derivada
        debe_cambiar_clave: true,
        cargo: c.campos.cargo || 'guardia',
        creado_por: quien,
      });
    }
    await insertar(env, 'trabajadores', conMismasClaves(filasNuevas, DEFECTOS_FICHA));
  }
  for (const u of aActualizar) {
    await actualizar(env, `trabajadores?id=eq.${u.id}`, u.campos);
  }
  return { resultados, extra };
}

/** Pasa los valores crudos de la planilla a los tipos que espera cada campo. */
function normalizarFila(fila, tipo) {
  const def = PLANTILLAS[tipo];
  const out = {};
  for (const c of def.columnas) {
    if (!(c.campo in fila)) continue;
    const v = fila[c.campo];
    if (/^fecha_|_al$|_vence$|^desde$|^hasta$/.test(c.campo)) out[c.campo] = aFecha(v);
    else if (/_uf$|_monto$|^sueldo_|^colacion$|^movilizacion$|_saldo_inicial$|^anios_|^horas_|^dias_/
             .test(c.campo)) out[c.campo] = aNumero(v);
    else if (c.campo === 'firmado') out[c.campo] = aSiNo(v);
    else out[c.campo] = aTexto(v);
  }
  // sexo y salud vienen escritos de cualquier manera.
  if (out.sexo) {
    const s = clave(out.sexo);
    out.sexo = s.startsWith('f') ? 'F' : s.startsWith('m') ? 'M' : s.startsWith('x') ? 'X' : null;
  }
  if (out.salud_sistema) {
    const s = clave(out.salud_sistema);
    out.salud_sistema = s.includes('isapre') ? 'isapre' : s.includes('fonasa') ? 'fonasa' : null;
  }
  return out;
}

// ---------------------------------------------------------------- contratos
async function cargarContratos(env, quien, filas, confirmar, desdeFila) {
  const [trabajadores, instalaciones, vigentes] = await Promise.all([
    buscar(env, 'trabajadores?select=id,rut,nombre,fecha_ingreso'),
    buscar(env, 'instalaciones?select=id,nombre'),
    buscar(env, 'contratos?select=id,trabajador_id,fecha_inicio&estado=eq.vigente'),
  ]);
  const porRut = new Map(trabajadores.map((t) => [t.rut, t]));
  const porInstalacion = new Map(instalaciones.map((i) => [clave(i.nombre), i.id]));
  const vigentePorTrab = new Map(vigentes.map((c) => [c.trabajador_id, c]));
  const p = await parametros(env);
  const imm = p.imm ? Number(p.imm.valor) : 0;
  const maxHoras = p.jornada_semanal ? Number(p.jornada_semanal.valor) : 44;

  const resultados = [];
  const aCrear = [];
  const aCerrar = [];
  const vistos = new Set();

  filas.forEach((fila, i) => {
    const n = desdeFila + i;
    const { rut, error } = rutDeFila(fila);
    if (error) return resultados.push({ n, estado: 'error', motivo: error });

    const t = porRut.get(rut);
    if (!t) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut),
        motivo: 'Esa persona no está cargada. Suba primero la planilla de fichas.' });
    }
    if (vistos.has(rut)) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut), nombre: t.nombre,
        motivo: 'Dos contratos para la misma persona en una planilla. Súbalos de a uno.' });
    }
    vistos.add(rut);

    const f = normalizarFila(fila, 'contratos');
    const tipo = TIPOS_CONTRATO.find((x) => clave(x) === clave(f.tipo || 'indefinido'))
      || 'indefinido';
    const jornada = JORNADAS.find((x) => clave(x) === clave(f.jornada_tipo || '')) || 'art38_2';

    if (!f.fecha_inicio) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut), nombre: t.nombre,
        motivo: 'Falta la fecha de inicio, o no se entendió el formato' });
    }
    if (!f.cargo) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut), nombre: t.nombre,
        motivo: 'Falta el cargo' });
    }
    if (f.sueldo_base === null) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut), nombre: t.nombre,
        motivo: 'Falta el sueldo base' });
    }
    if (tipo !== 'indefinido' && !f.fecha_termino) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut), nombre: t.nombre,
        motivo: 'Un contrato a plazo fijo o por obra tiene que llevar fecha de término' });
    }
    if (f.fecha_termino && f.fecha_termino < f.fecha_inicio) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut), nombre: t.nombre,
        motivo: 'La fecha de término es anterior a la de inicio' });
    }

    const previo = vigentePorTrab.get(t.id);
    if (previo && previo.fecha_inicio > f.fecha_inicio) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut), nombre: t.nombre,
        motivo: `Ya hay un contrato vigente que empieza el ${previo.fecha_inicio}, después de esta fecha` });
    }

    const avisos = [];
    if (imm && jornada !== 'parcial' && f.sueldo_base < imm) {
      avisos.push(`El sueldo base queda bajo el ingreso mínimo ($${imm.toLocaleString('es-CL')})`);
    }
    if (f.horas_semanales && jornada !== 'art22_excluido' && f.horas_semanales > maxHoras + 0.01) {
      avisos.push(`La jornada ordinaria vigente es de ${maxHoras} horas`);
    }
    if (jornada === 'excepcional' && !f.resolucion_dt) {
      avisos.push('Sistema excepcional sin número de resolución de la Dirección del Trabajo');
    }

    const instNombre = aTexto(fila.instalacion);
    const instalacionId = instNombre ? porInstalacion.get(clave(instNombre)) ?? null : null;
    if (instNombre && !instalacionId) {
      avisos.push(`La instalación «${instNombre}» no está en el catálogo: quedará sin asignar`);
    }

    if (previo) aCerrar.push({ id: previo.id, hasta: f.fecha_inicio });
    aCrear.push({
      trabajador_id: t.id, tipo, fecha_inicio: f.fecha_inicio, fecha_termino: f.fecha_termino,
      cargo: f.cargo, instalacion_id: instalacionId, jornada_tipo: jornada,
      horas_semanales: f.horas_semanales, turno: f.turno,
      resolucion_dt: f.resolucion_dt, resolucion_vence: f.resolucion_vence,
      sueldo_base: Math.round(f.sueldo_base),
      gratificacion: ['legal_25', 'convencional', 'sin'].includes(clave(f.gratificacion || ''))
        ? clave(f.gratificacion) : 'legal_25',
      colacion: Math.round(f.colacion || 0), movilizacion: Math.round(f.movilizacion || 0),
      bono_imponible_glosa: f.bono_imponible_glosa,
      bono_imponible_monto: Math.round(f.bono_imponible_monto || 0),
      firmado: f.firmado === true, estado: 'vigente', creado_por: quien,
      _sin_fecha_ingreso: !t.fecha_ingreso,
    });
    resultados.push({ n, estado: avisos.length ? 'ojo' : 'ok', accion: 'crear',
      rut: formatearRut(rut), nombre: t.nombre,
      detalle: `${tipo} desde ${f.fecha_inicio}`
        + (previo ? ' · cierra el contrato anterior' : ''),
      avisos });
  });

  if (!confirmar) return { resultados };

  for (const c of aCerrar) {
    const diaAntes = new Date(Date.parse(c.hasta + 'T00:00:00Z') - 86400000)
      .toISOString().slice(0, 10);
    await actualizar(env, `contratos?id=eq.${c.id}`, {
      estado: 'terminado', termino_fecha: diaAntes, termino_causal: 'reemplazado',
      termino_detalle: 'Reemplazado por un contrato cargado desde una planilla',
    });
  }
  if (aCrear.length) {
    const sinIngreso = aCrear.filter((c) => c._sin_fecha_ingreso);
    await insertar(env, 'contratos',
      conMismasClaves(aCrear.map(({ _sin_fecha_ingreso, ...c }) => c)));
    // Quien no tenía fecha de ingreso la toma del contrato más antiguo que se
    // le cargó: sin ella no hay feriado ni antigüedad que calcular.
    for (const c of sinIngreso) {
      await actualizar(env, `trabajadores?id=eq.${c.trabajador_id}`,
        { fecha_ingreso: c.fecha_inicio, cargo: c.cargo });
    }
  }
  return { resultados };
}

// ---------------------------------------------------------------- documentos
async function cargarDocumentos(env, quien, filas, confirmar, desdeFila) {
  const [trabajadores, tipos] = await Promise.all([
    buscar(env, 'trabajadores?select=id,rut,nombre'),
    buscar(env, 'tipos_documento?select=*&activo=is.true'),
  ]);
  const porRut = new Map(trabajadores.map((t) => [t.rut, t]));
  const porTipo = new Map();
  for (const td of tipos) {
    porTipo.set(clave(td.codigo), td);
    porTipo.set(clave(td.nombre), td);     // también por el nombre visible
  }

  const resultados = [];
  const aCrear = [];

  filas.forEach((fila, i) => {
    const n = desdeFila + i;
    const { rut, error } = rutDeFila(fila);
    if (error) return resultados.push({ n, estado: 'error', motivo: error });

    const t = porRut.get(rut);
    if (!t) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut),
        motivo: 'Esa persona no está cargada' });
    }

    const f = normalizarFila(fila, 'documentos');
    const td = f.tipo ? porTipo.get(clave(f.tipo)) : null;
    if (!td) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut), nombre: t.nombre,
        motivo: `El tipo «${f.tipo ?? ''}» no está en el catálogo. Vea la hoja «Listas».` });
    }

    let vence = f.fecha_vencimiento;
    let propuesto = false;
    if (!vence && td.vence && td.meses_validez && f.fecha_emision) {
      vence = sumarMeses(f.fecha_emision, td.meses_validez);
      propuesto = true;
    }
    if (vence && f.fecha_emision && vence < f.fecha_emision) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut), nombre: t.nombre,
        motivo: 'El vencimiento es anterior a la emisión' });
    }
    if (f.enlace && !/^https?:\/\//i.test(f.enlace)) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut), nombre: t.nombre,
        motivo: 'El enlace tiene que empezar con http:// o https://' });
    }

    const hoy = new Date().toISOString().slice(0, 10);
    const avisos = [];
    if (vence && vence < hoy) avisos.push(`Ya está vencido (${vence})`);
    if (td.vence && !vence) avisos.push('Es un documento que vence y no trae fecha de vencimiento');

    aCrear.push({
      trabajador_id: t.id, tipo: td.codigo, glosa: f.glosa, numero: f.numero,
      fecha_emision: f.fecha_emision, fecha_vencimiento: vence,
      enlace: f.enlace, observacion: f.observacion, creado_por: quien,
    });
    resultados.push({ n, estado: avisos.length ? 'ojo' : 'ok', accion: 'crear',
      rut: formatearRut(rut), nombre: t.nombre,
      detalle: td.nombre + (vence ? ` · vence ${vence}${propuesto ? ' (propuesto)' : ''}` : ''),
      avisos });
  });

  if (confirmar && aCrear.length) {
    await insertar(env, 'documentos_trabajador', conMismasClaves(aCrear));
  }
  return { resultados };
}

function sumarMeses(fecha, meses) {
  const [a, m, d] = fecha.split('-').map(Number);
  const total = (m - 1) + meses;
  const anio = a + Math.floor(total / 12);
  const mes = (total % 12) + 1;
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${anio}-${String(mes).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- ausencias
async function cargarAusencias(env, quien, filas, confirmar, desdeFila) {
  const trabajadores = await buscar(env, 'trabajadores?select=id,rut,nombre');
  const porRut = new Map(trabajadores.map((t) => [t.rut, t]));

  // Lo ya cargado, para no duplicar un feriado que alguien sube dos veces.
  const ids = [...new Set(filas.map((f) => normalizarRut(f.rut)).filter(Boolean))]
    .map((r) => porRut.get(r)?.id).filter(Boolean);
  const yaHay = ids.length
    ? await buscar(env, `ausencias?select=trabajador_id,desde,hasta,tipo,estado`
        + `&trabajador_id=in.(${ids.join(',')})&estado=in.(solicitada,aprobada)`)
    : [];

  const resultados = [];
  const aCrear = [];

  filas.forEach((fila, i) => {
    const n = desdeFila + i;
    const { rut, error } = rutDeFila(fila);
    if (error) return resultados.push({ n, estado: 'error', motivo: error });

    const t = porRut.get(rut);
    if (!t) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut),
        motivo: 'Esa persona no está cargada' });
    }

    const f = normalizarFila(fila, 'ausencias');
    const tipo = TIPOS_AUSENCIA.find((x) => clave(x) === clave(f.tipo || ''));
    if (!tipo) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut), nombre: t.nombre,
        motivo: `El tipo «${f.tipo ?? ''}» no es uno de los válidos. Vea la hoja «Listas».` });
    }
    if (!f.desde || !f.hasta) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut), nombre: t.nombre,
        motivo: 'Faltan las fechas, o no se entendió el formato' });
    }
    if (f.hasta < f.desde) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut), nombre: t.nombre,
        motivo: 'El hasta es anterior al desde' });
    }

    const choque = yaHay.find((a) => a.trabajador_id === t.id
      && a.desde <= f.hasta && a.hasta >= f.desde)
      || aCrear.find((a) => a.trabajador_id === t.id && a.desde <= f.hasta && a.hasta >= f.desde);
    if (choque) {
      return resultados.push({ n, estado: 'error', rut: formatearRut(rut), nombre: t.nombre,
        motivo: `Se cruza con una ausencia del ${choque.desde} al ${choque.hasta}` });
    }

    const calculados = diasHabiles(f.desde, f.hasta);
    const habiles = f.dias_habiles === null || f.dias_habiles === undefined
      ? calculados : f.dias_habiles;
    const estado = ['solicitada', 'aprobada', 'rechazada', 'anulada']
      .includes(clave(f.estado || '')) ? clave(f.estado) : 'aprobada';

    aCrear.push({
      trabajador_id: t.id, tipo, desde: f.desde, hasta: f.hasta,
      dias_habiles: habiles, dias_corridos: diasCorridos(f.desde, f.hasta),
      folio: f.folio, motivo: f.motivo, estado,
      con_goce: tipo !== 'permiso_sin_goce',
      aprobada_por: estado === 'aprobada' ? quien : null, creado_por: quien,
    });
    resultados.push({ n, estado: 'ok', accion: 'crear', rut: formatearRut(rut), nombre: t.nombre,
      detalle: `${tipo} del ${f.desde} al ${f.hasta} · ${habiles} días hábiles`
        + (habiles !== calculados ? ` (el cálculo daba ${calculados})` : ''),
      avisos: habiles !== calculados
        ? [`Los días hábiles escritos (${habiles}) no coinciden con el cálculo (${calculados})`] : [] });
  });

  if (confirmar && aCrear.length) await insertar(env, 'ausencias', conMismasClaves(aCrear));
  return { resultados };
}
