/**
 * Restablece la contraseña de una cuenta de la oficina.
 *
 *   node supabase/restablecer-clave.mjs vtorres
 *
 * Las cuentas de la oficina no tienen botón de restablecer: el único cambio de
 * clave que existe exige saber la actual, a propósito, porque nadie —tampoco
 * yo— puede ver una clave guardada. Cuando alguien la olvida, el camino es
 * este: ponerle una temporal y obligarlo a elegir la suya al entrar.
 *
 * Lo que hace:
 *   1. Inventa una clave temporal corta y legible, para dictarla por teléfono.
 *   2. La deriva con PBKDF2-SHA256, exactamente como lo hace el Worker.
 *   3. Deja el SQL listo para pegar en el SQL Editor de Supabase.
 *
 * La clave temporal **se imprime una sola vez, en su terminal**, y no queda en
 * ningún archivo: el SQL lleva solo la derivación, de la que no se vuelve.
 * Entréguesela a la persona y dígale que entre ese mismo día; el sistema no la
 * va a dejar ver nada hasta que elija una propia.
 *
 * Esto NO se corre contra la base: solo escribe el archivo. Pegarlo en Supabase
 * es el paso suyo.
 */
import { writeFile } from 'node:fs/promises';
import { claveCorrecta, hashear } from '../src/sesion.js';

const usuario = process.argv[2];
if (!usuario || !/^[a-z0-9_.-]{3,40}$/.test(usuario)) {
  console.error('Uso: node supabase/restablecer-clave.mjs <usuario>');
  console.error('Las cuentas de la oficina son jgarridoh, sgarridob, jgarridob y vtorres.');
  process.exit(1);
}

/* Sin 0/O ni 1/l/I: esta clave se dicta en voz alta o se manda por WhatsApp, y
   un cero que alguien lee como una O deja a la persona afuera creyendo que el
   sistema falla. Lleva letras y números porque son más fáciles de dictar que
   los símbolos, y da lo mismo que sea simple: dura un solo ingreso. */
const LETRAS = 'abcdefghijkmnpqrstuvwxyz';
const NUMEROS = '23456789';
const alAzar = (abc, n) => Array.from(crypto.getRandomValues(new Uint8Array(n)))
  .map((b) => abc[b % abc.length]).join('');
const temporal = `${alAzar(LETRAS, 4)}${alAzar(NUMEROS, 3)}${alAzar(LETRAS, 3)}`;

const hash = await hashear(temporal);

// Se comprueba con el verificador del propio Worker, no con uno escrito acá:
// un hash que la plataforma no sepa leer deja la cuenta sin poder entrar nunca.
if (!(await claveCorrecta(temporal, hash))) {
  console.error('El hash generado no pasa la verificación del Worker. No se escribió nada.');
  process.exit(1);
}

const archivo = `supabase/restablecer-${usuario}.sql`;
await writeFile(archivo, `-- Restablece la contraseña de «${usuario}» y la deja con cambio
-- obligatorio al entrar. Generado el ${new Date().toISOString().slice(0, 10)}.
--
-- La clave temporal no está acá: se imprimió una sola vez al generar esto.
-- Si se perdió, vuelva a correr el generador en vez de buscarla.
--
-- Además desbloquea la cuenta y pone los intentos fallidos en cero: quien
-- olvidó su clave normalmente ya la erró cinco veces y está bloqueado, y
-- restablecer sin eso lo deja igual de afuera por quince minutos.

update usuarios
   set clave              = '${hash}',
       debe_cambiar_clave = true,
       intentos_fallidos  = 0,
       bloqueado_hasta    = null
 where usuario = '${usuario}'
returning usuario, nombre, rol, debe_cambiar_clave;

-- Tiene que devolver UNA fila. Si devuelve cero, ese usuario no existe: revise
-- cómo está escrito con
--   select usuario, nombre, rol from usuarios order by usuario;
`, 'utf8');

console.log(`
  Cuenta:          ${usuario}
  Clave temporal:  ${temporal}

  Esto es lo único que la muestra. Anótela ahora y entréguesela a la persona.

  Falta pegar el SQL en el editor de Supabase:
    pbcopy < "${process.cwd()}/${archivo}"
    https://supabase.com/dashboard/project/hjoljdjjsobweqbvlijr/sql/new
`);
