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

import { buscar, primero, actualizar } from './datos.js';

// Cloudflare Workers no admite más de 100.000 iteraciones de PBKDF2. Es el
// techo de la plataforma, no una elección: lo que falta de costo de cálculo se
// compensa con el bloqueo de la cuenta a los 5 intentos fallidos, que es lo que
// de verdad frena un ataque por fuerza bruta contra un servicio en línea.
const ITERACIONES = 100000;
const MAX_ITERACIONES_PLATAFORMA = 100000;
const MAX_INTENTOS = 5;

/**
 * Cuánto dura el bloqueo por intentos fallidos.
 *
 * 29-10-2026: bajó de 15 a 5 minutos, por un reporte de Joaquín. Lo que pasa
 * de verdad es esto: el guardia cambia su clave, no la guarda en el llavero
 * del teléfono, a la semana siguiente la tecléa mal cinco veces y queda
 * afuera. No es un ataque, es alguien que se olvidó de su clave en la caseta
 * de un parque, de noche.
 *
 * Cinco minutos siguen haciendo lo que el bloqueo tiene que hacer —frenar al
 * que prueba claves ajenas, que es el compañero marcando la entrada por el
 * que no llegó— porque lo que lo frena no es la espera sino que a los cinco
 * intentos deje de poder probar. Quince minutos no frenaban a nadie más:
 * frenaban al dueño de la cuenta.
 *
 * Lo que de verdad arregla el caso es lo otro: que el aviso diga a quién
 * pedirle, y que la oficina tenga el botón para devolvérsela.
 */
const BLOQUEO_MINUTOS = 5;

// Dos ámbitos. La oficina entra en adm.seggarridos.com y los guardias en
// asistencia.seggarridos.com: son dominios distintos y el navegador ya separa
// sus cookies, pero el nombre distinto evita además que se pisen cuando las
// dos páginas se prueban en el mismo localhost.
//
// La sesión del guardia dura más que la de la oficina porque tiene que cubrir
// un turno entero: si se le cierra a mitad de las doce horas, el que queda sin
// marcar la salida es él.
const COOKIES = { oficina: 'sesion', asistencia: 'asistencia' };
const DURACION = { oficina: 60 * 60 * 10, asistencia: 60 * 60 * 16 };

const nombreCookie = (ambito) => COOKIES[ambito] || COOKIES.oficina;
export const duracionSesion = (ambito) => DURACION[ambito] || DURACION.oficina;

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
  if (iteraciones > MAX_ITERACIONES_PLATAFORMA) {
    // Un hash guardado con más iteraciones de las que la plataforma puede
    // calcular no se puede verificar: hay que regenerarlo.
    throw new Error(
      `La contraseña guardada usa ${iteraciones} iteraciones y aquí el máximo ` +
      `es ${MAX_ITERACIONES_PLATAFORMA}. Hay que regenerar las contraseñas.`);
  }
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

export async function crearSesion(usuario, env, ambito = 'oficina') {
  const cuerpo = JSON.stringify({
    u: usuario.usuario,
    a: ambito,
    exp: Math.floor(Date.now() / 1000) + duracionSesion(ambito),
  });
  const payload = b64(texto.encode(cuerpo));
  return `${payload}.${await firmar(payload, env.SESION_SECRETO)}`;
}

export async function leerSesion(request, env, ambito = 'oficina') {
  const cookies = request.headers.get('cookie') || '';
  const m = cookies.match(new RegExp(`(?:^|;\\s*)${nombreCookie(ambito)}=([^;]+)`));
  if (!m) return null;

  const [payload, firma] = decodeURIComponent(m[1]).split('.');
  if (!payload || !firma) return null;
  if (!igualesEnTiempoConstante(firma, await firmar(payload, env.SESION_SECRETO))) return null;

  let datos;
  try {
    datos = JSON.parse(new TextDecoder().decode(deB64(payload)));
  } catch { return null; }
  if (!datos.u || !datos.exp || datos.exp < Math.floor(Date.now() / 1000)) return null;
  // Una cookie de guardia no sirve para entrar a la oficina ni al revés,
  // aunque la firma sea válida: el ámbito va firmado junto con el nombre.
  if ((datos.a || 'oficina') !== ambito) return null;
  return datos.u;
}

/**
 * `seguro` sale del protocolo de la petición: en producción (https) la cookie
 * va marcada Secure; en pruebas locales por http se omite, porque si no el
 * navegador o el cliente no la devuelven y no se puede probar nada.
 */
export function cookieSesion(valor, segundos, seguro = true, ambito = 'oficina') {
  const partes = [
    `${nombreCookie(ambito)}=${valor}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${segundos}`,
  ];
  if (seguro) partes.splice(3, 0, 'Secure');
  return partes.join('; ');
}

export const cookieBorrada = (seguro = true, ambito = 'oficina') =>
  cookieSesion('', 0, seguro, ambito);

// ---------------------------------------------------------------- ingreso
/**
 * A quién llamar cuando la cuenta quedó bloqueada.
 *
 * Vive acá y no en quien llama porque el bloqueo es de este archivo: el que
 * decide dejar a alguien afuera es el que tiene que decirle cómo volver. Un
 * «Cuenta bloqueada» a secas es lo que terminaba en una llamada al gerente a
 * cualquier hora, porque el guardia no sabía a quién más preguntarle.
 *
 * Solo se consulta cuando alguien ya quedó bloqueado, así que no le cuesta
 * nada a los ingresos normales. Y si algo de esto falla —la tabla, el
 * teléfono, la red— el aviso sale sin la ayuda en vez de no salir: lo que no
 * puede pasar es que un error acá se coma el motivo del rechazo.
 */
async function aQuienPedirle(env, tabla) {
  try {
    // Al guardia lo desbloquea quien tenga el módulo `personal` —gerencia y
    // operaciones—; a una cuenta de oficina, gerencia desde Sistema → Usuarios.
    const filtroRol = tabla === 'trabajadores'
      ? 'rol=in.(gerencia,operaciones)' : 'rol=eq.gerencia';
    const [gente, fono] = await Promise.all([
      buscar(env, `usuarios?select=nombre&activo=is.true&${filtroRol}&order=nombre.asc`),
      primero(env, 'datos_empresa?select=valor&codigo=eq.telefono_oficina').catch(() => null),
    ]);

    const nombres = (gente || []).map((g) => g.nombre).filter(Boolean);
    if (!nombres.length) return '';
    const lista = nombres.length === 1
      ? nombres[0]
      : `${nombres.slice(0, -1).join(', ')} o ${nombres[nombres.length - 1]}`;
    const telefono = fono?.valor ? ` (${fono.valor})` : '';
    return ` Si no se acuerda de su clave, pídale a ${lista}${telefono} que se la devuelva.`;
  } catch {
    return '';
  }
}

/**
 * Verifica usuario y contraseña, contando intentos fallidos.
 * Devuelve { usuario } o { error, status }.
 *
 * `opciones.tabla` permite usar lo mismo para las cuentas de la oficina
 * (`usuarios`) y para los trabajadores (`trabajadores`), que entran con su RUT
 * en asistencia.seggarridos.com. El bloqueo por intentos fallidos es lo único
 * que frena de verdad un ataque por fuerza bruta, y no da tenerlo en una tabla
 * y olvidarlo en la otra: por eso hay una sola copia de este código.
 *
 * `opciones.prepararClave` normaliza lo tecleado antes de compararlo. Para el
 * guardia eso significa que da lo mismo si escribe el RUT con puntos o sin
 * ellos: se compara siempre contra la misma forma.
 */
export async function ingresar(env, nombreUsuario, clave, opciones = {}) {
  const {
    tabla = 'usuarios',
    prepararClave = (c) => c,
    rotuloClave = 'su contraseña',
  } = opciones;

  const u = typeof nombreUsuario === 'string' ? nombreUsuario.trim().toLowerCase() : '';
  if (!u || typeof clave !== 'string' || !clave) {
    return { error: `Escriba su usuario y ${rotuloClave}`, status: 400 };
  }
  clave = prepararClave(clave);

  const cuenta = await primero(env,
    `${tabla}?select=*&usuario=eq.${encodeURIComponent(u)}`);

  // Mismo mensaje exista o no la cuenta: no se confirma qué usuarios hay.
  const generico = {
    error: tabla === 'trabajadores'
      ? 'Usuario o RUT incorrectos' : 'Usuario o contraseña incorrectos',
    status: 401,
  };
  if (!cuenta || !cuenta.activo) {
    // Se gasta un tiempo parecido al de una verificación real.
    await derivar(clave, crypto.getRandomValues(new Uint8Array(16)), ITERACIONES);
    return generico;
  }

  if (cuenta.bloqueado_hasta && new Date(cuenta.bloqueado_hasta) > new Date()) {
    const faltan = Math.ceil((new Date(cuenta.bloqueado_hasta) - new Date()) / 60000);
    return {
      error: `Cuenta bloqueada por intentos fallidos. Reintente en ${faltan} minuto${faltan > 1 ? 's' : ''}.`
             + await aQuienPedirle(env, tabla),
      status: 429,
    };
  }

  if (!(await claveCorrecta(clave, cuenta.clave))) {
    const intentos = (cuenta.intentos_fallidos || 0) + 1;
    const campos = { intentos_fallidos: intentos };
    if (intentos >= MAX_INTENTOS) {
      campos.bloqueado_hasta = new Date(Date.now() + BLOQUEO_MINUTOS * 60000).toISOString();
      campos.intentos_fallidos = 0;
    }
    await actualizar(env, `${tabla}?usuario=eq.${encodeURIComponent(u)}`, campos);
    if (campos.bloqueado_hasta) {
      return {
        error: `Demasiados intentos. Cuenta bloqueada por ${BLOQUEO_MINUTOS} minutos.`
               + await aQuienPedirle(env, tabla),
        status: 429,
      };
    }
    return generico;
  }

  await actualizar(env, `${tabla}?usuario=eq.${encodeURIComponent(u)}`, {
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
