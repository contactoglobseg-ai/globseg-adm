/**
 * Acceso a Supabase desde el Worker.
 *
 * Se usa la API REST (PostgREST) con la clave de servicio, que vive como
 * secreto del Worker y nunca en el repositorio. Esa clave salta las políticas
 * de la base a propósito: el control de quién ve qué está en el Worker, no en
 * la base, y las tablas quedan cerradas para cualquier otro acceso.
 */

// En producción basta SUPABASE_URL (la del proyecto). SUPABASE_REST existe
// solo para apuntar a una réplica local en las pruebas.
const raiz = (env) =>
  (env.SUPABASE_REST
    ? env.SUPABASE_REST.replace(/\/+$/, '')
    : env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1') + '/';

export class ErrorDatos extends Error {
  constructor(mensaje, status, detalle) {
    super(mensaje);
    this.status = status;
    this.detalle = detalle;
  }
}

async function llamar(env, ruta, { metodo = 'GET', cuerpo, prefer } = {}) {
  if (!(env.SUPABASE_URL || env.SUPABASE_REST) || !env.SUPABASE_SERVICE_KEY) {
    throw new ErrorDatos('Falta configurar la conexión a Supabase', 500);
  }
  const r = await fetch(raiz(env) + ruta, {
    method: metodo,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
    },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });

  const texto = await r.text();
  let datos = null;
  if (texto) {
    try { datos = JSON.parse(texto); } catch { datos = texto; }
  }
  if (!r.ok) {
    throw new ErrorDatos(datos?.message || datos?.hint || `La base respondió ${r.status}`,
                         r.status, datos);
  }
  return datos;
}

/** Varias filas. `ruta` ya lleva los filtros de PostgREST. */
export const buscar = (env, ruta) => llamar(env, ruta);

/** Una fila o null. */
export async function primero(env, ruta) {
  const filas = await llamar(env, ruta.includes('limit=') ? ruta : ruta + '&limit=1');
  return Array.isArray(filas) && filas.length ? filas[0] : null;
}

/** Inserta una fila o un arreglo y devuelve lo insertado. */
export const insertar = (env, tabla, filas) =>
  llamar(env, tabla, { metodo: 'POST', cuerpo: filas, prefer: 'return=representation' });

/**
 * Inserta ignorando los que choquen con una clave única.
 * `conflicto` son las columnas de la restricción, separadas por coma.
 */
export const insertarSinDuplicar = (env, tabla, filas, conflicto) =>
  llamar(env, `${tabla}?on_conflict=${conflicto}`, {
    metodo: 'POST',
    cuerpo: filas,
    prefer: 'resolution=ignore-duplicates,return=representation',
  });

/** Actualiza las filas que calcen con el filtro. */
export const actualizar = (env, ruta, campos) =>
  llamar(env, ruta, { metodo: 'PATCH', cuerpo: campos, prefer: 'return=representation' });

/** Escribe en la bitácora sin hacer fallar la operación principal. */
export async function anotar(env, quien, entidad, entidad_id, accion, detalle) {
  try {
    await insertar(env, 'bitacora', {
      quien, entidad, entidad_id: entidad_id ?? null, accion, detalle: detalle ?? null,
    });
  } catch (e) {
    // La bitácora es rastro, no parte del trámite: si falla, el trámite sigue.
    console.error('No se pudo anotar en la bitácora:', e.message);
  }
}
