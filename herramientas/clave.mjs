/**
 * Restablecer la contraseña de una cuenta cuando nadie puede entrar.
 *
 * El sistema no guarda contraseñas: guarda su derivación con PBKDF2-SHA256, en
 * el formato `pbkdf2$sha256$100000$<sal>$<derivada>` que arma `hashear()` en
 * `src/sesion.js`. Por eso no se puede "poner una clave" con un update a mano:
 * un texto suelto en la columna `clave` no lo acepta nadie y deja la cuenta
 * peor que antes. Este script arma la derivación con el mismo algoritmo y
 * escribe el SQL para pegar en el editor de Supabase.
 *
 * Es la salida de emergencia, no el camino normal:
 *  - la oficina cambia su contraseña desde el propio panel;
 *  - la de un guardia la vuelve al RUT Joaquín, desde Trabajadores.
 * Esto es para cuando ya nadie puede entrar a ninguna de las dos partes.
 *
 * Uso:
 *   node herramientas/clave.mjs jgarridoh
 *   node herramientas/clave.mjs --guardia jperezg
 *
 * Sin clave, la inventa él y la escribe en esta consola. Es lo preferible: una
 * clave que se teclea en un chat o en un correo queda ahí para siempre, y esta
 * no tiene por qué salir de la pantalla de quien la va a entregar.
 *
 * Se le puede dar una a mano como segundo argumento, pero sea cual sea es
 * temporal: la cuenta queda obligada a cambiarla al entrar.
 */

import { pbkdf2Sync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// El mismo techo que impone Cloudflare Workers. Un hash generado acá con más
// iteraciones que esas no se puede verificar en producción: el Worker se
// niega en vez de adivinar, y la cuenta queda sin poder entrar.
const ITERACIONES = 100000;

function hashear(clave) {
  const sal = randomBytes(16);
  const derivada = pbkdf2Sync(clave, sal, ITERACIONES, 32, 'sha256');
  return `pbkdf2$sha256$${ITERACIONES}$${sal.toString('base64')}$${derivada.toString('base64')}`;
}

/** Comprueba el hash recién armado, para no entregar un SQL que no sirve. */
function verificar(clave, guardada) {
  const [, , iter, sal, esperada] = guardada.split('$');
  const derivada = pbkdf2Sync(clave, Buffer.from(sal, 'base64'), Number(iter), 32, 'sha256');
  const a = Buffer.from(esperada, 'base64');
  return a.length === derivada.length && timingSafeEqual(a, derivada);
}

/**
 * Una clave temporal que se pueda dictar por teléfono sin repetirla tres veces:
 * una palabra corriente, un guion y cuatro dígitos. Sin ceros ni unos, que por
 * teléfono se confunden con la o y con la ele.
 */
function claveInventada() {
  const palabras = ['Turno', 'Ronda', 'Faena', 'Parque', 'Bitacora', 'Garita', 'Relevo', 'Puesto'];
  const palabra = palabras[randomInt(palabras.length)];
  let digitos = '';
  for (let i = 0; i < 4; i++) digitos += randomInt(2, 10);
  return `${palabra}-${digitos}`;
}

const argumentos = process.argv.slice(2);
const guardia = argumentos.includes('--guardia');
const [usuario, claveDada] = argumentos.filter((a) => a !== '--guardia');

if (!usuario) {
  console.error('Uso: node herramientas/clave.mjs [--guardia] <usuario> ["<clave temporal>"]');
  console.error('Sin clave, se inventa una y se muestra acá.');
  process.exit(1);
}

const clave = claveDada || claveInventada();

// Las exigencias de la oficina son ocho caracteres con letras y números
// (`revisarClaveNueva`). Acá se avisa y no se impide: esta clave es de un solo
// uso y la cuenta tiene que cambiarla al entrar igual.
if (!guardia && (clave.length < 8 || !/[a-zA-Z]/.test(clave) || !/[0-9]/.test(clave))) {
  console.error('Aviso: esa clave no cumple lo que el panel exige (8 caracteres, letras y números).');
  console.error('       Sirve para entrar, pero la persona tendrá que elegir otra que sí cumpla.\n');
}

const tabla = guardia ? 'trabajadores' : 'usuarios';
const hash = hashear(clave);

if (!verificar(clave, hash)) {
  console.error('El hash generado no se verifica contra sí mismo. No use este SQL.');
  process.exit(1);
}

const sql = `-- Restablece la clave de ${usuario} en ${tabla}.
-- Clave temporal: ${clave}
-- La cuenta queda obligada a cambiarla al entrar, y desbloqueada.
update ${tabla}
   set clave              = '${hash}',
       debe_cambiar_clave = true,
       intentos_fallidos  = 0,
       bloqueado_hasta    = null
 where usuario = '${usuario.toLowerCase()}'
returning usuario, nombre, activo, debe_cambiar_clave;`;

if (!claveDada) {
  console.log(`Clave temporal para ${usuario}:  ${clave}`);
  console.log('Entréguesela a la persona. Tendrá que cambiarla apenas entre.\n');
}

console.log(sql);
console.log(`\n-- Si devuelve 0 filas, ese usuario no existe en ${tabla}.`);
console.log('-- Para ver los que sí existen:');
console.log(`--   select usuario, nombre, activo from ${tabla} order by usuario;`);
