/**
 * Archivos de los documentos de RRHH, en Supabase Storage.
 *
 * Dos decisiones gobiernan este archivo.
 *
 * **El bucket es privado y el archivo entra y sale solo por el Worker.** No se
 * entregan URLs firmadas, ni siquiera de vida corta. Acá adentro hay contratos,
 * exámenes médicos y finiquitos: una URL firmada se puede copiar y pegar en un
 * WhatsApp, y sigue funcionando hasta que vence aunque quien la copió ya no
 * tenga sesión. Pasar los bytes por el Worker cuesta un poco de ancho de banda
 * y a cambio deja una sola puerta, la misma que ya decide quién ve qué. Para
 * una oficina de cinco personas y archivos de pocos megas, el cambio conviene.
 *
 * **Lo que se sube se revisa por dentro, no por lo que dice el navegador.** El
 * `content-type` lo elige el cliente y puede mentir; los primeros bytes de un
 * archivo, no. Importa porque después ese archivo se devuelve para verlo en
 * una pestaña: un HTML disfrazado de PDF se ejecutaría en el mismo dominio que
 * la sesión. Por eso se miran los bytes mágicos, se guarda el tipo que el
 * servidor dedujo —nunca el que vino— y la respuesta va con `nosniff` y con su
 * propia política de contenido.
 */

const BUCKET = 'documentos-rrhh';

/** 10 MB. Una foto de un contrato desde un teléfono pesa uno o dos. */
export const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Lo que se acepta, con sus bytes mágicos. La clave es el tipo que el servidor
 * va a guardar y devolver; `firma` es cómo se reconoce de verdad.
 */
const TIPOS = [
  { tipo: 'application/pdf', ext: 'pdf',  firma: (b) => coincide(b, [0x25, 0x50, 0x44, 0x46]) },
  { tipo: 'image/jpeg',      ext: 'jpg',  firma: (b) => coincide(b, [0xFF, 0xD8, 0xFF]) },
  { tipo: 'image/png',       ext: 'png',  firma: (b) => coincide(b, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) },
  // WebP y HEIC son contenedores: la marca no está al principio sino después
  // del tamaño, en el byte 8.
  { tipo: 'image/webp', ext: 'webp',
    firma: (b) => coincide(b, [0x52, 0x49, 0x46, 0x46]) && coincide(b, [0x57, 0x45, 0x42, 0x50], 8) },
  { tipo: 'image/heic', ext: 'heic',
    firma: (b) => coincide(b, [0x66, 0x74, 0x79, 0x70], 4)
                  && ['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(texto(b, 8, 4)) },
  // Excel (27-10-2026). Entró por los estados de pago: el F30-1 se pide en la
  // DT con un archivo que genera Previred, y lo que se guarda y se reparte por
  // instalación es ese Excel. Un .xlsx es un zip, así que estos bytes mágicos
  // prueban que es un zip y nada más; va al final para que un PDF o una imagen
  // se reconozcan primero, y **nunca se abre en el navegador**: se devuelve
  // como adjunto con `nosniff`, así que lo peor que puede pasar es que alguien
  // se baje un zip que él mismo subió.
  { tipo: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx',
    firma: (b) => coincide(b, [0x50, 0x4B, 0x03, 0x04]) || coincide(b, [0x50, 0x4B, 0x05, 0x06]) },
];

export const TIPOS_ACEPTADOS = TIPOS.map((t) => t.tipo);

const coincide = (bytes, firma, desde = 0) =>
  firma.every((b, i) => bytes[desde + i] === b);

const texto = (bytes, desde, largo) =>
  String.fromCharCode(...bytes.slice(desde, desde + largo));

/** Qué es de verdad este archivo, o null si no es ninguno de los aceptados. */
export function reconocer(bytes) {
  if (!bytes || bytes.length < 12) return null;
  return TIPOS.find((t) => t.firma(bytes)) || null;
}

/**
 * Nombre de archivo sin nada que pueda hacer daño.
 *
 * Un nombre con `../` dentro podría apuntar fuera de la carpeta, y uno con
 * salto de línea o comillas rompe la cabecera donde después se manda.
 */
export function limpiarNombre(nombre) {
  return String(nombre ?? '')
    .replace(/[\r\n"\\]/g, ' ')
    .replace(/[/\\]/g, '-')
    .trim()
    .slice(0, 120);
}

/** Lo mismo, pero asegurando la extensión que corresponde a lo que el archivo
 *  resultó ser. Se usa al subir; al bajar no, porque el nombre guardado ya la
 *  trae y volver a agregarla deja cosas como «credencial.pdf.bin». */
export function nombreSeguro(nombre, extension) {
  const base = limpiarNombre(nombre) || `documento.${extension}`;
  return base.toLowerCase().endsWith('.' + extension) ? base : `${base}.${extension}`;
}

/**
 * El `content-disposition` de una descarga.
 *
 * Van las dos formas a propósito: `filename` con solo ASCII, para el navegador
 * que no entiende la otra, y `filename*` codificado en UTF-8, que es la forma
 * correcta de mandar un nombre con acentos. Con una sola, «Pérez» llega roto
 * en alguno de los dos lados.
 */
export function comoAdjunto(nombre) {
  const limpio = limpiarNombre(nombre) || 'documento';
  const ascii = limpio.replace(/[^\x20-\x7E]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(limpio)}`;
}

/** Ruta dentro del bucket. Lleva algo al azar para que no sea adivinable. */
export function rutaPara(trabajadorId, documentoId, extension) {
  const azar = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${trabajadorId}/${documentoId}-${azar}.${extension}`;
}

// ---------------------------------------------------------------- transporte
// `SUPABASE_STORAGE` existe por lo mismo que `SUPABASE_REST` en datos.js: para
// que las pruebas locales apunten a un Storage simulado en vez de a la nube.
const raiz = (env) =>
  (env.SUPABASE_STORAGE
    ? env.SUPABASE_STORAGE.replace(/\/+$/, '')
    : env.SUPABASE_URL.replace(/\/+$/, '') + '/storage/v1');

export class ErrorArchivo extends Error {
  constructor(mensaje, status) {
    super(mensaje);
    this.status = status;
  }
}

/**
 * Storage sí quiere la clave en `Authorization`, al revés que PostgREST.
 *
 * En datos.js la clave nueva (`sb_secret_…`) va solo en `apikey`, porque
 * PostgREST intenta leer el Authorization como un JWT y la rechaza. Storage no
 * hace eso: espera el token ahí. Se mandan las dos cabeceras, que es lo que
 * hace la propia librería de Supabase, y así funciona con las claves viejas y
 * con las nuevas.
 */
function cabeceras(env, extra = {}) {
  if (!(env.SUPABASE_URL || env.SUPABASE_STORAGE) || !env.SUPABASE_SERVICE_KEY) {
    throw new ErrorArchivo('Falta configurar la conexión a Supabase', 500);
  }
  const clave = env.SUPABASE_SERVICE_KEY.trim();
  return { apikey: clave, authorization: 'Bearer ' + clave, ...extra };
}

async function fallar(r, queSeHacia) {
  const detalle = await r.text().catch(() => '');
  if (r.status === 401 || r.status === 403) {
    throw new ErrorArchivo(
      `Supabase Storage rechazó la clave al ${queSeHacia}. Revise que el secreto ` +
      'SUPABASE_SERVICE_KEY sea la clave de servicio (secret) y que el bucket ' +
      `«${BUCKET}» exista: lo crea la migración 20261015200000_archivos_rrhh.sql.`, 502);
  }
  if (r.status === 404) {
    throw new ErrorArchivo(
      `No se encontró el archivo ni el bucket «${BUCKET}» al ${queSeHacia}. ` +
      'Puede que falte correr la migración que lo crea.', 502);
  }
  throw new ErrorArchivo(
    `Supabase Storage respondió ${r.status} al ${queSeHacia}${detalle ? ': ' + detalle.slice(0, 200) : ''}`,
    502);
}

/**
 * Una llamada a Storage, con el error traducido a algo que se pueda leer.
 *
 * Si Storage no contesta, `fetch` tira un error de red seco —«Network
 * connection lost»— que en pantalla no dice nada. Quien lo lee necesita saber
 * que el archivo no se perdió, que el problema es Storage y no su archivo, y
 * que puede volver a intentar.
 */
async function pedir(env, ruta, opciones, queSeHacia) {
  let r;
  try {
    r = await fetch(`${raiz(env)}/${ruta}`, opciones);
  } catch (e) {
    throw new ErrorArchivo(
      `No se pudo conectar con Supabase Storage al ${queSeHacia}. ` +
      'El documento no se tocó: vuelva a intentar en un momento. ' +
      `(${e.message})`, 503);
  }
  if (!r.ok) await fallar(r, queSeHacia);
  return r;
}

export async function subir(env, ruta, bytes, tipo) {
  await pedir(env, `object/${BUCKET}/${ruta}`, {
    method: 'POST',
    headers: cabeceras(env, { 'content-type': tipo, 'cache-control': 'no-store' }),
    body: bytes,
  }, 'subir el archivo');
}

export async function bajar(env, ruta) {
  const r = await pedir(env, `object/${BUCKET}/${ruta}`,
    { headers: cabeceras(env) }, 'abrir el archivo');
  return r.body;
}

/**
 * Borra, y no se queja si ya no estaba.
 *
 * Un archivo que no existe es justamente el estado al que se quiere llegar.
 * Hacer fallar el borrado por eso dejaría la fila apuntando para siempre a un
 * archivo fantasma que nadie puede quitar.
 */
export async function borrar(env, ruta) {
  let r;
  try {
    r = await fetch(`${raiz(env)}/object/${BUCKET}/${ruta}`, {
      method: 'DELETE', headers: cabeceras(env),
    });
  } catch (e) {
    throw new ErrorArchivo(
      `No se pudo conectar con Supabase Storage al borrar el archivo. (${e.message})`, 503);
  }
  if (!r.ok && r.status !== 404) await fallar(r, 'borrar el archivo');
}

/** ¿Está el bucket? Lo usa el diagnóstico; no dice nada del contenido. */
export async function bucketListo(env) {
  try {
    const r = await fetch(`${raiz(env)}/bucket/${BUCKET}`, { headers: cabeceras(env) });
    return r.ok;
  } catch {
    return false;
  }
}

export const NOMBRE_BUCKET = BUCKET;
