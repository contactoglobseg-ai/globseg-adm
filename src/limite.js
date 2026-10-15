/**
 * Límite de envíos del formulario público (POST /api/contacto).
 *
 * Es la única ruta sin sesión que escribe en la base. El CORS que tiene no
 * frena nada: un cliente que no es un navegador lo ignora por completo. Lo que
 * está en juego no es que se caiga el servicio, es la tabla `contactos`, que
 * es la bandeja de entrada comercial: si se llena de ruido, el contacto real
 * se pierde adentro.
 *
 * DÓNDE SE LLEVA LA CUENTA. Contra la propia tabla `contactos`, por `creado_en`.
 * Se descartó un namespace de KV: hay que crearlo en el panel, y mientras no
 * exista, un wrangler.jsonc que lo nombre rompe el despliegue del Worker
 * entero —el panel y el libro de asistencia incluidos—. Cambiar el riesgo de
 * una tabla con basura por el de dejar la oficina sin sistema no es negocio.
 * Contar contra la base no agrega ninguna pieza que pueda faltar; cuesta una
 * consulta por envío, y a los volúmenes de esta página eso no se nota.
 *
 * QUÉ SE GUARDA DE LA IP. Su huella, no ella: SHA-256 de la IP con el secreto
 * de sesiones de sal, recortada a 16 bytes. Alcanza para contar y no deja un
 * dato personal legible en la tabla. Con sal porque una huella pelada se
 * revierte probando las cuatro mil millones de IPv4, que no es ningún trabajo.
 * Vive dos días y después se borra (`limpiarHuellas`): el límite más largo
 * mira 24 horas, así que guardarla más tiempo no sirve para nada.
 *
 * SI LA REVISIÓN FALLA, PASA. Quien llama deja entrar el contacto cuando esto
 * tira error. Lo que se está protegiendo es no perder un cliente; negar un
 * envío bueno porque la consulta del límite falló sería causar justamente el
 * daño que el límite existe para evitar.
 */

import { buscar, actualizar } from './datos.js';

const HORA = 3600 * 1000;
const DIA = 24 * HORA;

/**
 * Los topes. Un visitante de verdad manda uno o dos (el corto de la portada y
 * el largo de Contacto), y si se equivocó, reenvía. Cinco en una hora le deja
 * espacio de sobra para equivocarse sin toparse con nada.
 *
 * El tope global es contra una botnet repartida, donde cada IP manda poco y el
 * tope por IP no la ve. Va alto a propósito: si se alcanza, un visitante real
 * queda afuera, que es el daño que se quería evitar. Sesenta en una hora es
 * muchas veces lo que esta página recibe en un día, así que llegar ahí ya
 * significa que lo que está entrando no son clientes.
 */
export const TOPES = {
  ipHora: 5,
  ipDia: 20,
  globalHora: 60,
};

/** Días que sobrevive la huella en la tabla. */
const DIAS_HUELLA = 2;

/**
 * Bloqueos ya decididos, recordados en memoria del isolate. No es la cuenta
 * —esa vive en la base—, es saltarse la consulta mientras dura un bloqueo que
 * ya se resolvió: una inundación desde la misma IP cae casi siempre en el
 * mismo isolate, así que cada intento de más deja de costar una consulta. Si
 * el isolate muere se vuelve a consultar: se pierde el ahorro, no el límite.
 */
const bloqueados = new Map();
const MAX_RECORDADOS = 500;

/** La IP de quien llama. */
export function ipDe(request) {
  // cf-connecting-ip la pone Cloudflare y el cliente no la puede falsear.
  // x-forwarded-for es solo para `wrangler dev`, donde la otra no existe; en
  // producción nunca se llega a mirar, porque la primera siempre viene.
  const ip = request.headers.get('cf-connecting-ip') ||
             (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return ip || null;
}

/** La huella con la que se cuenta. Null si no hay IP que mirar. */
export async function huellaDe(ip, env) {
  if (!ip) return null;
  // Sin SESION_SECRETO no hay sesiones y el sistema entero está caído, así que
  // no existe el caso real en que esto quede sin sal.
  const datos = new TextEncoder().encode((env.SESION_SECRETO || '') + '|' + ip);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', datos));
  return Array.from(bytes.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
}

function recordar(clave, hasta) {
  // Con tope: una botnet con muchas IP distintas haría crecer el mapa sin
  // freno dentro del isolate. Vaciarlo entero solo cuesta volver a consultar.
  if (bloqueados.size >= MAX_RECORDADOS) bloqueados.clear();
  bloqueados.set(clave, hasta);
}

const rechazo = (motivo, hasta, ahora) =>
  ({ ok: false, motivo, segundos: Math.max(1, Math.ceil((hasta - ahora) / 1000)) });

function bloquear(motivo, clave, hasta, ahora) {
  recordar(clave, hasta);
  return rechazo(motivo, hasta, ahora);
}

/**
 * ¿Se acepta este envío? Devuelve `{ ok: true }`, o el motivo del rechazo con
 * los segundos que faltan para que vuelva a haber cupo.
 */
export async function revisarLimite(env, huella) {
  const ahora = Date.now();
  const claveIp = huella ? 'ip:' + huella : null;

  for (const clave of [claveIp, 'global']) {
    if (!clave) continue;
    const hasta = bloqueados.get(clave);
    if (hasta === undefined) continue;
    if (hasta <= ahora) { bloqueados.delete(clave); continue; }
    return rechazo(clave === 'global' ? 'global' : 'ip', hasta, ahora);
  }

  if (huella) {
    // Una sola consulta cubre las dos ventanas: se piden las del último día y
    // las de la última hora se cuentan sobre lo que vino.
    const filas = await buscar(env,
      'contactos?select=creado_en' +
      `&ip_huella=eq.${encodeURIComponent(huella)}` +
      `&creado_en=gte.${new Date(ahora - DIA).toISOString()}` +
      `&order=creado_en.desc&limit=${TOPES.ipDia + 1}`);
    // De más viejo a más nuevo: así el que libera cupo es el de más atrás.
    const tiempos = filas.map(f => Date.parse(f.creado_en)).sort((a, b) => a - b);
    const enHora = tiempos.filter(t => t > ahora - HORA);
    if (enHora.length >= TOPES.ipHora) {
      return bloquear('ip', claveIp, enHora[enHora.length - TOPES.ipHora] + HORA, ahora);
    }
    if (tiempos.length >= TOPES.ipDia) {
      return bloquear('ip', claveIp, tiempos[tiempos.length - TOPES.ipDia] + DIA, ahora);
    }
  }

  const globales = await buscar(env,
    'contactos?select=creado_en' +
    `&creado_en=gte.${new Date(ahora - HORA).toISOString()}` +
    `&order=creado_en.asc&limit=${TOPES.globalHora + 1}`);
  if (globales.length >= TOPES.globalHora) {
    // Se piden los más antiguos, así que el momento calculado puede quedar
    // corto si entraron muchos más. No importa: se desbloquea, se vuelve a
    // consultar y se vuelve a bloquear. Equivocarse hacia corto deja pasar una
    // consulta de más; hacia largo dejaría a un cliente afuera sin razón.
    const t = Date.parse(globales[globales.length - TOPES.globalHora].creado_en);
    return bloquear('global', 'global', t + HORA, ahora);
  }

  return { ok: true };
}

/** Lo que se le dice al visitante. No menciona límites ni bloqueos: para él es
 *  una página que le pide esperar, y el teléfono lo agrega la portada. */
export const MENSAJES = {
  ip: 'Ya recibimos varios envíos suyos hace poco. Si nos dejó sus datos, ' +
      'lo vamos a contactar.',
  global: 'Estamos recibiendo demasiados mensajes en este momento. ' +
          'Intente de nuevo más tarde.',
};

/**
 * Borra las huellas que ya no sirven para contar.
 *
 * Corre después de un contacto aceptado y no después de uno rechazado: los
 * aceptados son pocos y reales, así que la limpieza queda acotada por el
 * propio límite, en vez de darle a un script una escritura más que provocar.
 */
export async function limpiarHuellas(env) {
  const limite = new Date(Date.now() - DIAS_HUELLA * DIA).toISOString();
  await actualizar(env,
    `contactos?ip_huella=not.is.null&creado_en=lt.${limite}`, { ip_huella: null });
}
