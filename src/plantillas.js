/**
 * Armado del texto de un documento a partir de su plantilla.
 *
 * Todo esto corre en el servidor y una sola vez: al generar el documento. Lo
 * que sale queda congelado en `documentos_generados.cuerpo` y nadie lo vuelve
 * a armar. La pantalla muestra ese texto, el PDF imprime ese texto y la
 * persona firma ese texto.
 *
 * Que el armado no se repita es lo que hace que la firma signifique algo: si
 * la pantalla armara el documento por su cuenta para mostrarlo, tendríamos dos
 * versiones del mismo contrato y ninguna forma de saber cuál se firmó. Es el
 * mismo error que costó una tarde con el subtotal de la cotización, pero en un
 * documento que se firma.
 */

import { formatearRut } from './rut.js';

// ------------------------------------------------------------ números en letras
const UNIDADES = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete',
                  'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce',
                  'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve'];
const DECENAS = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta',
                 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos',
                  'quinientos', 'seiscientos', 'setecientos', 'ochocientos',
                  'novecientos'];

/** 0–999 en letras. `apocope` convierte «uno» en «un», que es lo que pide ir
 *  delante de un sustantivo: «un millón», «veintiún mil». */
function hasta999(n, apocope) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  const partes = [];
  if (c) partes.push(CENTENAS[c]);
  if (resto) {
    if (resto < 20) {
      partes.push(apocope && resto === 1 ? 'un' : UNIDADES[resto]);
    } else if (resto < 30) {
      // Los veinti- van pegados: veintiuno, veintidós, veintitrés.
      const u = resto - 20;
      const tildadas = { 2: 'veintidós', 3: 'veintitrés', 6: 'veintiséis' };
      partes.push(u === 0 ? 'veinte'
        : u === 1 ? (apocope ? 'veintiún' : 'veintiuno')
        : tildadas[u] || 'veinti' + UNIDADES[u]);
    } else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      partes.push(u ? `${DECENAS[d]} y ${apocope && u === 1 ? 'un' : UNIDADES[u]}`
                    : DECENAS[d]);
    }
  }
  return partes.join(' ');
}

/**
 * Un monto en pesos, escrito como va en un contrato: «Quinientos cincuenta y
 * tres mil quinientos cincuenta y tres pesos».
 *
 * Va con mayúscula inicial porque en los tres contratos del gerente aparece
 * así, entre paréntesis, después de la cifra.
 */
export function enPalabras(monto) {
  const n = Math.round(Math.abs(Number(monto) || 0));
  if (n === 0) return 'Cero pesos';

  const millones = Math.floor(n / 1e6);
  const miles = Math.floor((n % 1e6) / 1000);
  const resto = n % 1000;
  const partes = [];

  if (millones === 1) partes.push('un millón');
  else if (millones > 1) partes.push(`${hasta999(millones, true)} millones`);
  // «mil» va solo: no se dice «un mil quinientos».
  if (miles === 1) partes.push('mil');
  else if (miles > 1) partes.push(`${hasta999(miles, true)} mil`);
  if (resto) partes.push(hasta999(resto, false));

  let texto = partes.join(' ');

  // «uno» delante de un sustantivo se apocopa: son «veintiún pesos», no
  // «veintiuno pesos». Y un monto exacto en millones lleva «de»: «dos millones
  // de pesos». Las dos son las formas con que se escribe un monto en un
  // contrato, y la segunda la escribiría mal cualquiera que lea «dos millones
  // pesos» y piense que al sistema le falta una palabra.
  texto = texto.replace(/veintiuno$/, 'veintiún').replace(/(^|\s)uno$/, '$1un');
  const exactoEnMillones = millones >= 1 && n % 1e6 === 0;
  texto += exactoEnMillones ? ' de pesos' : (n === 1 ? ' peso' : ' pesos');

  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

// -------------------------------------------------------------------- formato
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
               'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** «2026-10-04» -> «04 de octubre de 2026». Se parte el texto en vez de usar
 *  `new Date`, que interpretaría la fecha en UTC y la correría un día. */
export function fechaLarga(iso) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(iso || ''))) return '';
  const [a, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${String(d).padStart(2, '0')} de ${MESES[m - 1]} de ${a}`;
}

/** Miles con punto, como se escriben los pesos en Chile. */
export const pesos = (n) =>
  new Intl.NumberFormat('es-CL').format(Math.round(Number(n) || 0));

// -------------------------------------------------------------------- armado
//
// Tres marcas, y ninguna más. Un motor de plantillas con lógica adentro
// termina siendo un lenguaje que hay que aprender para corregir un contrato, y
// el que va a corregirlos es RRHH, no un programador.
//
//   {{campo}}             el valor; si falta, una línea de guiones a completar
//   {{#campo}}…{{/campo}} el trozo entero solo si el campo tiene valor
//   {{=bloque}}           el bloque intercambiable que se eligió
const FALTA = '_______________';

/** Lo que cuenta como «sin valor»: null, vacío y el cero de un monto. Un
 *  contrato no lleva una línea que diga «Asignación de Colación: $ 0». */
const vacio = (v) => v === null || v === undefined || v === '' || v === 0 || v === '0';

/**
 * Arma el texto. `faltan`, si se le pasa un Set, se llena con el nombre de cada
 * campo que quedó sin valor.
 *
 * Se recoge acá y no se deduce después del texto porque del texto solo se puede
 * contar cuántos huecos hay, no de qué son: `faltantes()` cuenta líneas de
 * guiones y con eso la pantalla solo sabía decir «faltan 11 campos», que deja a
 * RRHH buscándolos a ojo entre tres pantallas distintas.
 */
export function armar(cuerpo, datos, bloque = '', faltan = null) {
  let t = String(cuerpo || '');

  // Los condicionales primero: si se reemplazaran los campos antes, un bloque
  // que se va a borrar igual habría dejado sus «_______» a la vista.
  // Dos pasadas por si hay uno dentro de otro, que es el caso de la resolución
  // de la Dirección del Trabajo y su fecha de vencimiento.
  for (let i = 0; i < 2; i++) {
    t = t.replace(/\{\{#([a-z_0-9]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
      (_, campo, dentro) => (vacio(datos[campo]) ? '' : dentro));
  }

  t = t.replace(/\{\{=([a-z_0-9]+)\}\}/g, (_, campo) => {
    if (bloque) return bloque;
    if (faltan) faltan.add(campo);
    return FALTA;
  });
  t = t.replace(/\{\{([a-z_0-9]+)\}\}/g, (_, campo) => {
    if (!vacio(datos[campo])) return String(datos[campo]);
    if (faltan) faltan.add(campo);
    return FALTA;
  });

  // Un condicional que se fue deja su línea en blanco. Tres saltos seguidos o
  // más se dejan en dos: separan párrafos, no abren huecos en la hoja.
  return t.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Los campos que quedaron sin completar. La pantalla los muestra antes de
 *  generar: un contrato con «_______» adentro no se manda a firmar. */
export const faltantes = (texto) => (texto.match(/_{5,}/g) || []).length;

/**
 * De dónde sale cada campo, para poder decir no solo qué falta sino **dónde se
 * arregla**. Decirle a RRHH «faltan 11 campos» la deja buscándolos a ojo entre
 * la ficha, el contrato y el catálogo de instalaciones.
 *
 * Los `_palabras` llevan el mismo rótulo que su monto a propósito: salen de la
 * misma cifra y nombrarlos aparte sería decir dos veces que falta el sueldo.
 * Lo mismo `ciudad` y `ciudad_jurisdiccion`, que salen las dos de la ciudad
 * donde se firma.
 *
 * Un campo que no esté acá se muestra con su propio nombre: una plantilla
 * nueva que alguien olvide agregar tiene que salir fea, no desaparecer.
 */
export const DONDE = {
  empresa:     'Datos de la empresa',
  ficha:       'Ficha de la persona',
  contrato:    'Contrato vigente',
  instalacion: 'Instalación, en Operaciones',
  documento:   'Este mismo formulario',
  bloque:      'Funciones del cargo',
};

export const CAMPOS = {
  // La empresa — se editan en Documentos, en «Datos de la empresa».
  razon_social:         ['empresa', 'Razón social'],
  empresa_rut:          ['empresa', 'RUT de la empresa'],
  empresa_domicilio:    ['empresa', 'Domicilio de la empresa'],
  representante:        ['empresa', 'Representante legal'],
  representante_rut:    ['empresa', 'Cédula del representante'],
  representante_correo: ['empresa', 'Correo del representante'],
  ciudad:               ['empresa', 'Ciudad donde se firma'],
  ciudad_jurisdiccion:  ['empresa', 'Ciudad donde se firma'],

  // La persona — se editan en Fichas.
  trabajador:      ['ficha', 'Nombre'],
  rut:             ['ficha', 'RUT'],
  correo:          ['ficha', 'Correo'],
  nacimiento:      ['ficha', 'Fecha de nacimiento'],
  nacionalidad:    ['ficha', 'Nacionalidad'],
  domicilio:       ['ficha', 'Dirección'],
  comuna:          ['ficha', 'Comuna'],
  ciudad_trabajador: ['ficha', 'Región'],
  banco:           ['ficha', 'Banco'],
  cuenta_tipo:     ['ficha', 'Tipo de cuenta'],
  cuenta_numero:   ['ficha', 'Número de cuenta'],
  fecha_ingreso:   ['ficha', 'Fecha de ingreso'],

  // El contrato — se editan con «Corregir» en el contrato vigente de la ficha.
  cargo:            ['contrato', 'Cargo'],
  desde_funcion:    ['contrato', 'Fecha de inicio'],
  desde_sueldo:     ['contrato', 'Fecha de inicio'],
  turno_glosa:      ['contrato', 'Turno'],
  vigencia_texto:   ['contrato', 'Tipo de contrato y fecha de término'],
  resolucion_dt:    ['contrato', 'Resolución de la Dirección del Trabajo'],
  resolucion_vence: ['contrato', 'Vencimiento de la resolución'],
  sueldo:           ['contrato', 'Sueldo base'],
  sueldo_palabras:  ['contrato', 'Sueldo base'],
  movilizacion:     ['contrato', 'Movilización'],
  movilizacion_palabras: ['contrato', 'Movilización'],
  colacion:         ['contrato', 'Colación'],
  colacion_palabras: ['contrato', 'Colación'],
  asignacion_glosa: ['contrato', 'Glosa de la asignación'],
  asignacion_monto: ['contrato', 'Monto de la asignación'],
  asignacion_palabras: ['contrato', 'Monto de la asignación'],
  bono_imponible_glosa: ['contrato', 'Glosa del bono imponible'],
  bono_imponible_monto: ['contrato', 'Monto del bono imponible'],
  bono_imponible_palabras: ['contrato', 'Monto del bono imponible'],
  gratificacion_glosa: ['contrato', 'Gratificación'],

  // La instalación — su dirección de calle la mantiene operaciones.
  lugar_trabajo: ['instalacion', 'Dirección del lugar de trabajo'],

  // El arriendo: nada de esto vive en una tabla, lo escribe quien lo genera.
  arrendador:           ['documento', 'Arrendador'],
  arrendador_rut:       ['documento', 'RUT del arrendador'],
  arrendador_domicilio: ['documento', 'Domicilio del arrendador'],
  patente:    ['documento', 'Patente'],
  marca:      ['documento', 'Marca'],
  modelo:     ['documento', 'Modelo'],
  anio:       ['documento', 'Año'],
  color:      ['documento', 'Color'],
  motor:      ['documento', 'N° de motor'],
  chasis:     ['documento', 'N° de chasis'],
  kilometraje: ['documento', 'Kilometraje'],
  combustible: ['documento', 'Combustible'],
  desde:      ['documento', 'Desde'],
  hasta:      ['documento', 'Hasta'],
  renta:      ['documento', 'Renta mensual'],
  renta_palabras: ['documento', 'Renta mensual'],
  dia_pago:   ['documento', 'Día de pago'],
  aviso_dias: ['documento', 'Días de aviso'],

  bloque:     ['bloque', 'Funciones del cargo'],
  funciones:  ['bloque', 'Funciones del cargo'],
};

/**
 * Los campos que faltan, con su rótulo y dónde se arreglan, sin repetir.
 * Se ordena por `donde` para poder agruparlos en la pantalla.
 */
export function explicarFaltantes(faltan) {
  const vistos = new Set();
  const orden = Object.keys(DONDE);
  return [...faltan]
    .map((campo) => {
      const [donde, rotulo] = CAMPOS[campo] || ['documento', campo];
      return { campo, donde, rotulo };
    })
    .filter((x) => {
      const llave = `${x.donde}|${x.rotulo}`;
      if (vistos.has(llave)) return false;
      vistos.add(llave);
      return true;
    })
    .sort((a, b) => orden.indexOf(a.donde) - orden.indexOf(b.donde)
                    || a.rotulo.localeCompare(b.rotulo));
}

/** SHA-256 en hexadecimal. Es lo que amarra una firma a un texto: si alguna vez
 *  no calza con el del documento, es que el texto cambió después de firmado. */
export async function hash(texto) {
  const bytes = new TextEncoder().encode(texto);
  const resumen = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(resumen)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------ datos de un contrato
//
// Arma el objeto con el que se rellena la plantilla laboral. Cada campo sale de
// una sola parte —la ficha, el contrato o `datos_empresa`— y ninguno se escribe
// a mano en la pantalla: lo que el contrato dice del trabajador tiene que ser
// lo mismo que dice su ficha, o la liquidación del mes siguiente no va a cuadrar.
export function datosLaborales({ trabajador, contrato, instalacion, empresa, hoy }) {
  const e = (codigo) => empresa[codigo]?.valor || '';

  const lugar = instalacion
    ? [instalacion.direccion, instalacion.comuna && `comuna de ${instalacion.comuna}`,
       instalacion.region && `Región ${instalacion.region}`]
      .filter(Boolean).join(', ') || instalacion.nombre
    : null;

  const d = {
    // La empresa
    razon_social: e('razon_social'),
    empresa_rut: e('rut'),
    empresa_domicilio: e('domicilio'),
    representante: e('representante'),
    representante_rut: e('representante_rut'),
    representante_correo: e('representante_correo'),
    ciudad: e('ciudad_contrato'),
    ciudad_jurisdiccion: (e('ciudad_contrato') || '').replace(/ de Chile$/, ''),
    fecha_contrato: fechaLarga(hoy),

    // La persona, tal como está en su ficha
    trabajador: trabajador.nombre,
    // Con puntos, como va en un contrato. La ficha lo guarda normalizado
    // (7018975-5) porque así se compara; el documento lo muestra 7.018.975-5.
    rut: formatearRut(trabajador.rut),
    correo: trabajador.email,
    nacimiento: fechaLarga(trabajador.fecha_nacimiento),
    nacionalidad: trabajador.nacionalidad || 'chilena',
    domicilio: trabajador.direccion,
    comuna: trabajador.comuna,
    ciudad_trabajador: trabajador.region,
    banco: trabajador.banco,
    cuenta_tipo: trabajador.cuenta_tipo,
    cuenta_numero: trabajador.cuenta_numero,
    fecha_ingreso: fechaLarga(trabajador.fecha_ingreso || contrato?.fecha_inicio),
  };

  if (contrato) {
    d.cargo = contrato.cargo;
    d.lugar_trabajo = lugar;
    d.desde_funcion = fechaLarga(contrato.fecha_inicio);
    d.desde_sueldo = fechaLarga(contrato.fecha_inicio);
    d.resolucion_dt = contrato.resolucion_dt;
    d.resolucion_vence = fechaLarga(contrato.resolucion_vence);

    // El turno sale del contrato. El 4x4 está escrito a mano en los contratos
    // del gerente; acá se arma con lo que diga la ficha del contrato, para que
    // un 7x7 no salga diciendo 4x4.
    d.turno_glosa = contrato.turno
      ? `Los turnos serán rotativos en la modalidad ${contrato.turno}, conforme a las `
        + 'necesidades operativas de la empresa y respetando la normativa laboral vigente.'
      : '';

    for (const [campo, monto] of [
      ['sueldo', contrato.sueldo_base],
      ['movilizacion', contrato.movilizacion],
      ['colacion', contrato.colacion],
      ['asignacion_monto', contrato.asignacion_monto],
      ['bono_imponible_monto', contrato.bono_imponible_monto],
    ]) {
      d[campo] = monto ? pesos(monto) : null;
      // El nombre del campo en palabras sigue al del monto: `sueldo` ->
      // `sueldo_palabras`, `asignacion_monto` -> `asignacion_palabras`.
      d[campo.replace(/_monto$/, '') + '_palabras'] = monto ? enPalabras(monto) : null;
    }
    d.asignacion_glosa = contrato.asignacion_glosa || 'Asignación';
    d.bono_imponible_glosa = contrato.bono_imponible_glosa || 'Bono';

    d.gratificacion_glosa = contrato.gratificacion === 'legal_25'
      ? 'Gratificación: el empleador pagará al trabajador, a título de gratificación legal '
        + '(conforme a lo dispuesto en el artículo 50 del Código del Trabajo), una suma '
        + 'equivalente al 25 % de las remuneraciones devengadas por éste en el respectivo '
        + 'año, con un límite máximo del equivalente a 4,75 ingresos mínimos. Esta '
        + 'gratificación se pagará mes a mes, por duodécimos, en forma conjunta con el '
        + 'sueldo mensual respectivo.'
      : contrato.gratificacion === 'convencional'
        ? 'Gratificación: el empleador pagará al trabajador una gratificación convencional '
          + `de $ ${pesos(contrato.gratificacion_monto)} `
          + `(${enPalabras(contrato.gratificacion_monto)}) mensuales.`
        : 'Las partes dejan constancia de que no se ha pactado gratificación.';

    // La vigencia dice cosas distintas según el tipo, y decirlas mal es caro:
    // un indefinido al que se le deja fecha de término sigue saliendo en la
    // alerta de plazos por vencer, y un plazo fijo sin fecha es un indefinido
    // que nadie se dio cuenta de que lo era.
    // Sin el ordinal: el contrato la numera SEXTO y el anexo TERCERO, así que
    // el número lo pone la plantilla y acá va solo la frase. Llevarlo adentro
    // hacía que el anexo dijera «SEXTO» en su tercera cláusula.
    d.vigencia_texto = contrato.tipo === 'indefinido'
      ? 'El presente contrato es de duración indefinida.'
      : contrato.tipo === 'por_obra'
        ? 'El presente contrato durará mientras se extienda la obra o faena para la '
          + `que se contrata, y se estima su término para el ${fechaLarga(contrato.fecha_termino)}.`
        : `El presente contrato tendrá una vigencia hasta el ${fechaLarga(contrato.fecha_termino)}.`;
  }

  return d;
}

/** Lo mismo para el arriendo: la empresa sale de la base y el resto lo escribe
 *  quien genera el documento, porque el vehículo y el arrendador no están en
 *  ninguna tabla del sistema. */
export function datosArriendo({ empresa, hoy, campos }) {
  const e = (codigo) => empresa[codigo]?.valor || '';
  const d = {
    razon_social: e('razon_social'),
    empresa_rut: e('rut'),
    empresa_domicilio: e('domicilio'),
    representante: e('representante'),
    representante_rut: e('representante_rut'),
    ciudad: e('ciudad_contrato'),
    ciudad_jurisdiccion: (e('ciudad_contrato') || '').replace(/ de Chile$/, ''),
    fecha_contrato: fechaLarga(hoy),
    ...campos,
  };

  d.desde = fechaLarga(campos.desde) || campos.desde;
  d.hasta = fechaLarga(campos.hasta) || campos.hasta;
  d.renta = campos.renta ? pesos(campos.renta) : null;
  d.renta_palabras = campos.renta ? enPalabras(campos.renta) : null;
  d.aviso_dias = campos.aviso_dias || 30;
  d.dia_pago = campos.dia_pago || 5;

  // Las cuatro que el gerente no ha confirmado. Mientras no las confirme, el
  // contrato **dice que no están pactadas** en vez de inventar una cifra: una
  // garantía o una multa que nadie acordó comprometen plata de la empresa.
  d.renovacion_glosa = campos.renovable
    ? 'Si ninguna de las partes manifiesta su voluntad de ponerle término con la '
      + 'anticipación pactada, el contrato se entenderá renovado por períodos iguales '
      + 'y sucesivos.'
    : 'Vencido el plazo, el contrato terminará sin necesidad de desahucio ni aviso previo.';

  // Sin línea de guiones a propósito: un contrato con un hueco adentro no se
  // puede firmar, y el armado se niega a generar uno así. Lo que falta se dice
  // con palabras —que no se ha pactado— y queda además en lo por confirmar.
  d.mantencion_glosa = campos.mantencion_glosa
    || 'Las partes dejan constancia de que no han acordado a cargo de quién quedan las '
       + 'mantenciones periódicas ni las reparaciones mayores, y que deberán acordarlo '
       + 'por escrito antes de la entrega del vehículo.';

  d.seguro_glosa = campos.seguro_glosa
    || 'Las partes dejan constancia de que, además del SOAP, no se ha pactado la '
       + 'contratación de seguros adicionales (por confirmar antes de firmar).';

  d.atraso_glosa = campos.atraso_glosa
    || 'Las partes no han pactado multa por atraso en la restitución.';

  d.garantia_glosa = campos.garantia
    ? `La Arrendataria entrega en este acto, a título de garantía, la suma de $ ${pesos(campos.garantia)} `
      + `(${enPalabras(campos.garantia)}), que le será restituida dentro de los 10 días `
      + 'siguientes a la restitución del vehículo, deducido lo que corresponda por daños '
      + 'o multas pendientes.'
    : 'Las partes no han pactado garantía.';

  return d;
}
