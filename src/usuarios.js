/**
 * Cuentas y permisos: quién entra al sistema y qué abre.
 *
 * Hasta el 29-10-2026 esto no existía como pantalla. Los permisos estaban
 * escritos en `src/index.js` —cambiarle el acceso a alguien era editar código
 * y desplegar— y de las contraseñas solo se podían arreglar las de los
 * guardias, desde la pestaña Trabajadores. Una cuenta de oficina olvidada o
 * bloqueada no tenía ningún camino que no pasara por pegar SQL a mano.
 *
 * Dos reglas sostienen todo el archivo:
 *
 *  - **Una contraseña no se recupera, se reemplaza.** La columna `clave`
 *    guarda una derivación PBKDF2 y no el texto, así que nadie —tampoco
 *    gerencia, tampoco este código— puede ver la que está puesta. Lo que hace
 *    restablecer es escribir una temporal, mostrarla una sola vez y obligar a
 *    cambiarla al entrar.
 *
 *  - **El sistema no se deja cerrar por fuera.** Toda operación que pudiera
 *    dejar a la empresa sin ninguna cuenta capaz de administrar cuentas se
 *    rechaza antes de escribir. Es la única falla de acá que no se arregla
 *    desde acá.
 */

import { buscar, primero, insertar, actualizar, anotar } from './datos.js';
import { hashear } from './sesion.js';
import { usuarioPara, usuarioLibre, listarTrabajadores } from './asistencia.js';

/**
 * Los módulos que existen, con lo que abre cada uno dicho sin adornos. La
 * pantalla dibuja esta lista: el rótulo no se escribe por segunda vez allá.
 *
 * `corto` es para la columna «Qué abre» de la tabla, donde van los seis
 * seguidos: con los rótulos largos esa celda se come el ancho y los nombres de
 * las personas terminan partidos en tres líneas. El rótulo largo y la
 * explicación quedan donde se decide, que es en las casillas.
 */
export const MODULOS = [
  { codigo: 'facturacion', rotulo: 'Facturación y cobranza', corto: 'Facturación',
    abre: 'Panel, Calendario, Servicios, Instalaciones, Registrar extra, Bitácora y la carpeta de estados de pago.' },
  { codigo: 'cotizaciones', rotulo: 'Cotizaciones', corto: 'Cotizaciones',
    abre: 'Armar, editar y emitir cotizaciones, con el tarifario y los precios.' },
  { codigo: 'personal', rotulo: 'Guardias y libro de asistencia', corto: 'Guardias',
    abre: 'Crear cuentas de guardias, desbloquearlas, devolverles la clave al RUT y leer el libro de turnos.' },
  { codigo: 'documentos', rotulo: 'Documentos que se firman', corto: 'Documentos',
    abre: 'Generar y firmar contratos, anexos, entregas de EPP y actas. Los laborales piden además Personas.' },
  { codigo: 'rrhh', rotulo: 'Personas', corto: 'Personas',
    abre: 'Fichas, contratos, sueldos, liquidaciones, finiquitos, RUT, previsión y cuenta bancaria de cada trabajador.' },
  { codigo: 'usuarios', rotulo: 'Usuarios y permisos', corto: 'Usuarios',
    abre: 'Esta pantalla: crear cuentas, restablecer contraseñas y repartir estos mismos permisos.' },
];

export const CODIGOS = MODULOS.map((m) => m.codigo);

export const ROLES = [
  { codigo: 'gerencia',    rotulo: 'Gerencia' },
  { codigo: 'operaciones', rotulo: 'Operaciones' },
  { codigo: 'rrhh',        rotulo: 'Recursos humanos' },
  { codigo: 'prevencion',  rotulo: 'Prevención de riesgos' },
];

/**
 * Lo que decía el código antes de que esto viviera en la base. Se usa como
 * respaldo si la migración no se aplicó: en este proyecto una migración no se
 * aplica sola, y dejar al sistema sin permisos esperando que alguien pegue SQL
 * sería dejar a la oficina afuera. Mientras falte la tabla, todo funciona como
 * el 28-10-2026 y la pantalla lo dice con el nombre del archivo.
 */
const RESPALDO_ROLES = {
  gerencia:    ['facturacion', 'cotizaciones', 'personal', 'documentos', 'rrhh', 'usuarios'],
  operaciones: ['facturacion', 'personal', 'documentos', 'rrhh'],
  rrhh:        ['rrhh'],
  prevencion:  ['documentos', 'rrhh'],
};
const RESPALDO_PERSONA = { jgarridob: ['cotizaciones'] };

export const ARCHIVO_MIGRACION = 'supabase/migrations/20261029120000_usuarios_permisos.sql';

// ---------------------------------------------------------------- los permisos
/**
 * La tabla de roles se consulta en cada petición, así que se recuerda por un
 * rato. Medio minuto es el trato: un cambio de permisos tarda a lo más eso en
 * notarse en el computador de al lado —y la pantalla lo dice al guardar— a
 * cambio de no pagar una consulta por cada clic de todo el mundo. Quien hace
 * el cambio lo ve al tiro, porque guardar limpia el recuerdo de este isolate.
 */
const VIDA_CACHE_MS = 30000;
let cache = null;
let cacheHasta = 0;

export function olvidarRoles() {
  cache = null;
  cacheHasta = 0;
}

async function rolesVigentes(env) {
  if (cache && Date.now() < cacheHasta) return cache;
  try {
    const filas = await buscar(env, 'roles_permisos?select=rol,permisos,descripcion');
    const mapa = {};
    for (const f of filas) mapa[f.rol] = Array.isArray(f.permisos) ? f.permisos : [];
    // Una tabla vacía no es una tabla ausente, pero tampoco es una respuesta:
    // dejaría a todo el mundo sin nada. Se trata como si faltara.
    cache = Object.keys(mapa).length ? { mapa, enLaBase: true, filas }
                                     : { mapa: RESPALDO_ROLES, enLaBase: false, filas: [] };
  } catch {
    cache = { mapa: RESPALDO_ROLES, enLaBase: false, filas: [] };
  }
  cacheHasta = Date.now() + VIDA_CACHE_MS;
  return cache;
}

/**
 * Qué módulos abre esta persona: los de su rol más los suyos.
 *
 * `permisos_extra` puede no existir todavía como columna. En ese caso se usa
 * lo que decía el código, que para la única persona que tenía algo propio
 * —Joaquín y sus cotizaciones— dice exactamente lo mismo.
 */
export async function permisosDe(env, u) {
  const { mapa, enLaBase } = await rolesVigentes(env);
  const propios = Array.isArray(u.permisos_extra) && enLaBase
    ? u.permisos_extra
    : (RESPALDO_PERSONA[u.usuario] || []);
  return [...new Set([...(mapa[u.rol] || []), ...propios])].filter((p) => CODIGOS.includes(p));
}

/** Si esto es false, la pantalla avisa que falta pegar la migración. */
export async function tablasListas(env) {
  const { enLaBase } = await rolesVigentes(env);
  return enLaBase;
}

// ---------------------------------------------------------------- utilidades
const limpio = (v, max) => {
  const t = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return t ? t.slice(0, max) : null;
};

const correoValido = (v) =>
  typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());

/**
 * Una contraseña temporal que se pueda dictar por teléfono sin repetirla tres
 * veces: sin las letras y los números que se confunden al oírlos o al leerlos
 * (o/0, i/l/1), en tres pedazos cortos. Vive una sola vez, en la pantalla de
 * quien la generó: no se guarda, no se manda por correo y no entra a la
 * bitácora. Lo único que queda escrito es que alguien la restableció.
 */
export function claveTemporal() {
  const letras = 'abcdefghjkmnpqrstuvwxyz';
  const digitos = '23456789';
  const tomar = (alfabeto, cuantos) => {
    const azar = crypto.getRandomValues(new Uint8Array(cuantos));
    return [...azar].map((n) => alfabeto[n % alfabeto.length]).join('');
  };
  return `${tomar(letras, 4)}-${tomar(digitos, 4)}-${tomar(letras, 4)}`;
}

const ficha = (u, permisos) => ({
  usuario: u.usuario,
  nombre: u.nombre,
  email: u.email,
  rol: u.rol,
  activo: u.activo !== false,
  puede_borrar: u.puede_borrar === true,
  permisos_extra: Array.isArray(u.permisos_extra) ? u.permisos_extra : [],
  permisos,
  debe_cambiar_clave: u.debe_cambiar_clave === true,
  // Que esté bloqueada ahora, no que lo haya estado alguna vez.
  bloqueada: !!(u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()),
  bloqueado_hasta: u.bloqueado_hasta,
  intentos_fallidos: u.intentos_fallidos || 0,
  ultimo_ingreso: u.ultimo_ingreso,
  nunca_entro: !u.ultimo_ingreso,
});

// ---------------------------------------------------------------- la regla que no se salta
/**
 * Comprueba que, DESPUÉS del cambio que se está por hacer, siga existiendo al
 * menos una cuenta activa capaz de abrir esta pantalla.
 *
 * Es la única falla del sistema que no se puede arreglar desde el sistema: si
 * nadie tiene el módulo `usuarios`, nadie puede dárselo a nadie, y la salida
 * pasa a ser el SQL Editor de Supabase. Por eso se revisa antes de escribir y
 * no después, y por eso se recalcula de cero en vez de confiar en lo que la
 * pantalla mandó: el cambio puede venir de otra pestaña abierta hace una hora.
 *
 * `cambio` describe lo que se va a hacer, sin hacerlo:
 *   { usuario, rol?, permisos_extra?, activo? }  una cuenta
 *   { rol, permisos }                            un rol entero
 */
async function quedaAlguienQueAdministre(env, cambio) {
  const [cuentas, { mapa }] = await Promise.all([
    buscar(env, 'usuarios?select=usuario,rol,activo,permisos_extra'),
    rolesVigentes(env),
  ]);

  const porRol = { ...mapa };
  if (cambio.rol && cambio.permisos) porRol[cambio.rol] = cambio.permisos;

  return cuentas.some((c) => {
    const esElTocado = cambio.usuario && c.usuario === cambio.usuario;
    const activo = esElTocado && 'activo' in cambio ? cambio.activo : c.activo !== false;
    if (!activo) return false;
    const rol = esElTocado && cambio.rol ? cambio.rol : c.rol;
    const extra = esElTocado && cambio.permisos_extra
      ? cambio.permisos_extra
      : (Array.isArray(c.permisos_extra) ? c.permisos_extra : []);
    return (porRol[rol] || []).includes('usuarios') || extra.includes('usuarios');
  });
}

const SIN_ADMINISTRADOR =
  'Ese cambio dejaría al sistema sin ninguna cuenta que pueda administrar ' +
  'usuarios, y entonces nadie podría devolvérsela a nadie. Déle antes el ' +
  'módulo «Usuarios y permisos» a otra cuenta activa.';

// ---------------------------------------------------------------- listado
export async function listar(env) {
  const [cuentas, { mapa, enLaBase, filas }] = await Promise.all([
    buscar(env, 'usuarios?select=*&order=activo.desc,nombre.asc'),
    rolesVigentes(env),
  ]);

  const roles = ROLES.map((r) => {
    const fila = filas.find((f) => f.rol === r.codigo);
    return {
      ...r,
      permisos: mapa[r.codigo] || [],
      descripcion: fila?.descripcion || null,
      actualizado_por: fila?.actualizado_por || null,
      actualizado_en: fila?.actualizado_en || null,
    };
  });

  return {
    cuentas: await Promise.all(
      cuentas.map(async (c) => ficha(c, await permisosDe(env, c)))),
    roles,
    modulos: MODULOS,
    permisos_en_la_base: enLaBase,
    archivo_migracion: enLaBase ? null : ARCHIVO_MIGRACION,
  };
}

/**
 * Las cuentas de los guardias, para verlas junto a las de la oficina. Es la
 * misma lista de la pestaña Trabajadores y se lee de la misma función: una
 * segunda forma de armarla terminaría diciendo otra cosa.
 */
export async function listarGuardias(env) {
  const todos = await listarTrabajadores(env);
  return todos.map((t) => ({
    id: t.id, usuario: t.usuario, nombre: t.nombre, rut: t.rut, cargo: t.cargo,
    instalacion: t.instalacion, activo: t.activo, bloqueada: t.bloqueado,
    debe_cambiar_clave: t.debe_cambiar_clave, ultimo_ingreso: t.ultimo_ingreso,
  }));
}

// ---------------------------------------------------------------- alta
export async function crear(env, quien, cuerpo) {
  // El nombre se pide en tres pedazos y no en un campo suelto, igual que el
  // alta de un guardia. Partir «María Fernanda Soto Ruiz» adivinando dónde
  // terminan los nombres daba el usuario `mfernandas` en vez de `msotor`: en
  // Chile hay quien usa dos nombres y quien usa uno, y el sistema no tiene
  // cómo saber cuál es cuál. El usuario es con lo que esa persona entra todos
  // los días, así que no se adivina.
  const nombres = limpio(cuerpo.nombres, 80);
  const paterno = limpio(cuerpo.apellido_paterno, 60);
  const materno = limpio(cuerpo.apellido_materno, 60);
  if (!nombres || !paterno) {
    return { error: 'Faltan el nombre y el apellido paterno', status: 400 };
  }
  const nombre = [nombres, paterno, materno].filter(Boolean).join(' ');

  const email = typeof cuerpo.email === 'string' ? cuerpo.email.trim().toLowerCase() : '';
  if (!correoValido(email)) return { error: 'Ese correo no tiene forma de correo', status: 400 };

  const rol = ROLES.some((r) => r.codigo === cuerpo.rol) ? cuerpo.rol : null;
  if (!rol) return { error: 'Hay que elegir un rol', status: 400 };

  // El correo es la clave primaria de la tabla: repetirlo no crea otra cuenta,
  // pisa la que hay. Se avisa con nombre en vez de dejar que choque la base.
  const repetido = await primero(env,
    `usuarios?select=nombre,usuario&email=eq.${encodeURIComponent(email)}`);
  if (repetido) {
    return { error: `Ese correo ya tiene cuenta: ${repetido.nombre} (${repetido.usuario})`, status: 409 };
  }

  // El usuario se arma con la misma regla que el de un guardia —inicial del
  // nombre, apellido paterno, inicial del materno— y se comprueba libre contra
  // las dos tablas: la bitácora guarda el usuario, no de qué tabla salió.
  const base = limpio(cuerpo.usuario, 40)
    ? limpio(cuerpo.usuario, 40).toLowerCase().replace(/[^a-z0-9]/g, '')
    : usuarioPara(nombres, paterno, materno);
  if (!base) return { error: 'Con ese nombre no se puede armar un usuario', status: 400 };
  const usuario = await usuarioLibre(env, base);
  if (!usuario) return { error: 'No se pudo encontrar un usuario libre', status: 409 };

  const clave = claveTemporal();
  const fila = {
    email, nombre, rol, usuario,
    clave: await hashear(clave),
    debe_cambiar_clave: true,
    activo: true,
  };
  // `permisos_extra` y `creado_por` nacen con la migración nueva. Mientras no
  // esté aplicada no se mandan, porque PostgREST rechaza la fila entera por una
  // columna que no existe: la cuenta se crea igual, sin ellas.
  if (await tablasListas(env)) Object.assign(fila, { permisos_extra: [], creado_por: quien });
  await insertar(env, 'usuarios', fila);

  await anotar(env, quien, 'usuario', null, 'creó la cuenta',
    `${nombre} · usuario ${usuario} · rol ${rol}`);

  const creado = await primero(env, `usuarios?select=*&usuario=eq.${encodeURIComponent(usuario)}`);
  // La contraseña sale de acá una sola vez y no se guarda en ninguna parte.
  return { cuenta: ficha(creado, await permisosDe(env, creado)), clave_temporal: clave };
}

// ---------------------------------------------------------------- edición
export async function editar(env, quienUsuario, usuario, cuerpo) {
  const u = await primero(env,
    `usuarios?select=*&usuario=eq.${encodeURIComponent(usuario)}`);
  if (!u) return { error: 'Esa cuenta no existe', status: 404 };

  const esUnoMismo = u.usuario === quienUsuario;
  const campos = {};
  const notas = [];
  let claveTemp = null;

  if ('rol' in cuerpo && cuerpo.rol !== u.rol) {
    if (!ROLES.some((r) => r.codigo === cuerpo.rol)) {
      return { error: 'Ese rol no existe', status: 400 };
    }
    // Cambiarse el rol a uno mismo es la forma más fácil de quedarse afuera
    // sin darse cuenta: se guarda, se recarga y la pantalla ya no está.
    if (esUnoMismo) {
      return { error: 'No puede cambiarse el rol a usted mismo. Pídaselo a la otra cuenta de gerencia.', status: 400 };
    }
    campos.rol = cuerpo.rol;
    notas.push(`rol ${u.rol} → ${cuerpo.rol}`);
  }

  if ('permisos_extra' in cuerpo) {
    const pedidos = Array.isArray(cuerpo.permisos_extra) ? cuerpo.permisos_extra : [];
    const malos = pedidos.filter((p) => !CODIGOS.includes(p));
    if (malos.length) return { error: `No existe el módulo ${malos[0]}`, status: 400 };
    if (!(await tablasListas(env))) {
      return { error: `Para dar módulos a una persona falta pegar ${ARCHIVO_MIGRACION} en el SQL Editor de Supabase.`, status: 503 };
    }
    // Lo que el rol ya da no se guarda como propio: si mañana ese módulo sale
    // del rol, la persona lo conservaría sin que nadie lo haya decidido.
    const { mapa } = await rolesVigentes(env);
    const delRol = mapa[campos.rol || u.rol] || [];
    const extra = [...new Set(pedidos)].filter((p) => !delRol.includes(p)).sort();
    const antes = (Array.isArray(u.permisos_extra) ? u.permisos_extra : []).slice().sort();
    if (extra.join(',') !== antes.join(',')) {
      campos.permisos_extra = extra;
      notas.push(`módulos propios: ${extra.length ? extra.join(', ') : 'ninguno'} (antes ${antes.length ? antes.join(', ') : 'ninguno'})`);
    }
  }

  if ('activo' in cuerpo) {
    const activo = cuerpo.activo === true || cuerpo.activo === 'true';
    if (activo !== (u.activo !== false)) {
      if (!activo && esUnoMismo) {
        return { error: 'No puede darse de baja a usted mismo.', status: 400 };
      }
      campos.activo = activo;
      notas.push(activo ? 'reactivada' : 'dada de baja');
    }
  }

  if ('puede_borrar' in cuerpo) {
    const p = cuerpo.puede_borrar === true || cuerpo.puede_borrar === 'true';
    if (p !== (u.puede_borrar === true)) {
      campos.puede_borrar = p;
      notas.push(p ? 'puede eliminar registros' : 'ya no puede eliminar registros');
    }
  }

  if (cuerpo.desbloquear === true) {
    campos.intentos_fallidos = 0;
    campos.bloqueado_hasta = null;
    notas.push('desbloqueada');
  }

  if (cuerpo.restablecer_clave === true) {
    claveTemp = claveTemporal();
    campos.clave = await hashear(claveTemp);
    campos.debe_cambiar_clave = true;
    campos.intentos_fallidos = 0;
    campos.bloqueado_hasta = null;
    // La temporal no entra a la bitácora: ahí quedaría escrita en claro y
    // legible para todo el que pueda leer la bitácora.
    notas.push('contraseña restablecida');
  }

  if (!Object.keys(campos).length) return { error: 'No hay nada que cambiar', status: 400 };

  // Antes de escribir: que no quede el sistema sin quien administre.
  if ('rol' in campos || 'permisos_extra' in campos || 'activo' in campos) {
    const queda = await quedaAlguienQueAdministre(env, {
      usuario: u.usuario,
      ...( 'rol' in campos ? { rol: campos.rol } : {}),
      ...( 'permisos_extra' in campos ? { permisos_extra: campos.permisos_extra } : {}),
      ...( 'activo' in campos ? { activo: campos.activo } : {}),
    });
    if (!queda) return { error: SIN_ADMINISTRADOR, status: 400 };
  }

  const [guardado] = await actualizar(env,
    `usuarios?usuario=eq.${encodeURIComponent(u.usuario)}`, campos);
  await anotar(env, quienUsuario, 'usuario', null, notas.join(', '), u.nombre);
  olvidarRoles();

  return {
    cuenta: ficha(guardado, await permisosDe(env, guardado)),
    clave_temporal: claveTemp,
    cambios: notas,
  };
}

// ---------------------------------------------------------------- roles
export async function editarRol(env, quien, rol, permisos) {
  if (!ROLES.some((r) => r.codigo === rol)) return { error: 'Ese rol no existe', status: 400 };
  if (!Array.isArray(permisos)) return { error: 'Faltan los módulos', status: 400 };

  const malos = permisos.filter((p) => !CODIGOS.includes(p));
  if (malos.length) return { error: `No existe el módulo ${malos[0]}`, status: 400 };

  const { mapa, enLaBase } = await rolesVigentes(env);
  if (!enLaBase) {
    return { error: `Los permisos todavía no viven en la base. Hay que pegar ${ARCHIVO_MIGRACION} en el SQL Editor de Supabase.`, status: 503 };
  }

  const nuevos = [...new Set(permisos)].sort();
  const antes = (mapa[rol] || []).slice().sort();
  if (nuevos.join(',') === antes.join(',')) {
    return { error: 'Ese rol ya tiene exactamente esos módulos', status: 400 };
  }

  if (!(await quedaAlguienQueAdministre(env, { rol, permisos: nuevos }))) {
    return { error: SIN_ADMINISTRADOR, status: 400 };
  }

  await actualizar(env, `roles_permisos?rol=eq.${encodeURIComponent(rol)}`, {
    permisos: nuevos,
    actualizado_en: new Date().toISOString(),
    actualizado_por: quien,
  });

  const quitados = antes.filter((p) => !nuevos.includes(p));
  const puestos = nuevos.filter((p) => !antes.includes(p));
  await anotar(env, quien, 'rol', null, `cambió los módulos de ${rol}`,
    [puestos.length ? `agregó ${puestos.join(', ')}` : null,
     quitados.length ? `quitó ${quitados.join(', ')}` : null].filter(Boolean).join('; '));

  olvidarRoles();
  return { rol, permisos: nuevos, agregados: puestos, quitados };
}
