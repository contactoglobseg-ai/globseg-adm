/**
 * Cuentas y sesiones.
 *
 * Reglas que se sostienen en todo el archivo:
 *  - La contraseña nunca se guarda ni se escribe en un registro: solo su
 *    derivación con PBKDF2-SHA256.
 *  - La comparación es de tiempo constante, para no filtrar por demora si el
 *    hash empieza igual.
 *  - La cookie de sesión va firmada; el navegador no puede alterarla ni leerla
 *    desde JavaScript.
 */

import { primero, actualizar } from './datos.js';

const ITERACIONES = 210000;
const DURACION_SESION = 60 * 60 * 10;      // 10 horas
const MAX_INTENTOS = 5;
const BLOQUEO_MINUTOS = 15;
const COOKIE = 'sesion';

const texto = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const deB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Compara sin revelar en cuántos caracteres coincidía.
function igualesEnTiempoConstante(a, b) {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

// ---------------------------------------------------------------- contraseñas
async function derivar(clave, sal, iteraciones) {
  const material = await crypto.subtle.importKey(
    'raw', texto.encode(clave), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iteraciones },
    material, 256);
  return b64(bits);
}

export async function hashear(clave) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const derivada = await derivar(clave, sal, ITERACIONES);
  return `pbkdf2$sha256$${ITERACIONES}$${b64(sal)}$${derivada}`;
}

export async function claveCorrecta(clave, guardada) {
  if (!guardada) return false;
  const partes = guardada.split('$');
  if (partes.length !== 5 || partes[0] !== 'pbkdf2' || partes[1] !== 'sha256') return false;
  const iteraciones = Number(partes[2]);
  if (!Number.isInteger(iteraciones) || iteraciones < 1000) return false;
  const derivada = await derivar(clave, deB64(partes[3]), iteraciones);
  return igualesEnTiempoConstante(derivada, partes[4]);
}

/** Exigencias mínimas. Devuelve null si está bien, o el motivo del rechazo. */
export function revisarClaveNueva(clave, usuario) {
  if (typeof clave !== 'string' || clave.length < 8) {
    return 'La contraseña debe tener al menos 8 caracteres';
  }
  if (clave.length > 200) return 'La contraseña es demasiado larga';
  if (!/[a-zA-Z]/.test(clave) || !/[0-9]/.test(clave)) {
    return 'La contraseña debe mezclar letras y números';
  }
  if (usuario && clave.toLowerCase().includes(usuario.toLowerCase())) {
    return 'La contraseña no puede contener su nombre de usuario';
  }
  const obvias = ['123321', '12345678', 'password', 'contrasena', 'qwerty123', 'globseg123'];
  if (obvias.includes(clave.toLowerCase())) return 'Esa contraseña es demasiado fácil de adivinar';
  return null;
}

// ---------------------------------------------------------------- sesión
async function firmar(datos, secreto) {
  const llave = await crypto.subtle.importKey(
    'raw', texto.encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', llave, texto.encode(datos)));
}

export async function crearSesion(usuario, env) {
  const cuerpo = JSON.stringify({
    u: usuario.usuario,
    exp: Math.floor(Date.now() / 1000) + DURACION_SESION,
  });
  const payload = b64(texto.encode(cuerpo));
  return `${payload}.${await firmar(payload, env.SESION_SECRETO)}`;
}

export async function leerSesion(request, env) {
  const cookies = request.headers.get('cookie') || '';
  const m = cookies.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;

  const [payload, firma] = decodeURIComponent(m[1]).split('.');
  if (!payload || !firma) return null;
  if (!igualesEnTiempoConstante(firma, await firmar(payload, env.SESION_SECRETO))) return null;

  let datos;
  try {
    datos = JSON.parse(new TextDecoder().decode(deB64(payload)));
  } catch { return null; }
  if (!datos.u || !datos.exp || datos.exp < Math.floor(Date.now() / 1000)) return null;
  return datos.u;
}

/**
 * `seguro` sale del protocolo de la petición: en producción (https) la cookie
 * va marcada Secure; en pruebas locales por http se omite, porque si no el
 * navegador o el cliente no la devuelven y no se puede probar nada.
 */
export function cookieSesion(valor, segundos, seguro = true) {
  const partes = [
    `${COOKIE}=${valor}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${segundos}`,
  ];
  if (seguro) partes.splice(3, 0, 'Secure');
  return partes.join('; ');
}

export const cookieBorrada = (seguro = true) => cookieSesion('', 0, seguro);

// ---------------------------------------------------------------- ingreso
/**
 * Verifica usuario y contraseña, contando intentos fallidos.
 * Devuelve { usuario } o { error, status }.
 */
export async function ingresar(env, nombreUsuario, clave) {
  const u = typeof nombreUsuario === 'string' ? nombreUsuario.trim().toLowerCase() : '';
  if (!u || typeof clave !== 'string' || !clave) {
    return { error: 'Escriba su usuario y su contraseña', status: 400 };
  }

  const cuenta = await primero(env,
    `usuarios?select=*&usuario=eq.${encodeURIComponent(u)}`);

  // Mismo mensaje exista o no la cuenta: no se confirma qué usuarios hay.
  const generico = { error: 'Usuario o contraseña incorrectos', status: 401 };
  if (!cuenta || !cuenta.activo) {
    // Se gasta un tiempo parecido al de una verificación real.
    await derivar(clave, crypto.getRandomValues(new Uint8Array(16)), ITERACIONES);
    return generico;
  }

  if (cuenta.bloqueado_hasta && new Date(cuenta.bloqueado_hasta) > new Date()) {
    const faltan = Math.ceil((new Date(cuenta.bloqueado_hasta) - new Date()) / 60000);
    return { error: `Cuenta bloqueada por intentos fallidos. Reintente en ${faltan} minuto${faltan > 1 ? 's' : ''}.`, status: 429 };
  }

  if (!(await claveCorrecta(clave, cuenta.clave))) {
    const intentos = (cuenta.intentos_fallidos || 0) + 1;
    const campos = { intentos_fallidos: intentos };
    if (intentos >= MAX_INTENTOS) {
      campos.bloqueado_hasta = new Date(Date.now() + BLOQUEO_MINUTOS * 60000).toISOString();
      campos.intentos_fallidos = 0;
    }
    await actualizar(env, `usuarios?usuario=eq.${encodeURIComponent(u)}`, campos);
    if (campos.bloqueado_hasta) {
      return { error: `Demasiados intentos. Cuenta bloqueada por ${BLOQUEO_MINUTOS} minutos.`, status: 429 };
    }
    return generico;
  }

  await actualizar(env, `usuarios?usuario=eq.${encodeURIComponent(u)}`, {
    intentos_fallidos: 0, bloqueado_hasta: null, ultimo_ingreso: new Date().toISOString(),
  });
  return { usuario: cuenta };
}

/** Cambia la contraseña verificando antes la actual. */
export async function cambiarClave(env, cuenta, actual, nueva) {
  if (!(await claveCorrecta(actual, cuenta.clave))) {
    return { error: 'La contraseña actual no es correcta', status: 400 };
  }
  const motivo = revisarClaveNueva(nueva, cuenta.usuario);
  if (motivo) return { error: motivo, status: 400 };
  if (await claveCorrecta(nueva, cuenta.clave)) {
    return { error: 'La contraseña nueva tiene que ser distinta de la actual', status: 400 };
  }
  await actualizar(env, `usuarios?usuario=eq.${encodeURIComponent(cuenta.usuario)}`, {
    clave: await hashear(nueva), debe_cambiar_clave: false,
  });
  return { ok: true };
}
