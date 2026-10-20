/**
 * Ficha de ingreso que llena el propio trabajador, por enlace.
 *
 * El problema que resuelve: cuando entra gente nueva, alguien de la oficina le
 * persigue los datos por WhatsApp durante una semana y la ficha queda a medias
 * hasta después del primer turno. Acá RRHH genera un enlace, se lo manda, y la
 * persona llena su ficha sola desde el teléfono antes de empezar.
 *
 * Las cuatro reglas que sostienen todo el archivo:
 *
 * 1. EL ENLACE ES DE UN SOLO USO Y VENCE. Una vez recibida la ficha, el token
 *    deja de abrir nada. Un enlace de estos viaja por WhatsApp, que es un
 *    lugar del que no se borra nada: tiene que dejar de servir solo.
 *
 * 2. EL TOKEN SE GUARDA HASHEADO. En la base vive el HMAC-SHA256 con
 *    SESION_SECRETO, no el token. Quien tenga una copia de la base no puede
 *    usar los enlaces pendientes, porque la llave está en el Worker. En claro
 *    existe una sola vez: en la respuesta que ve quien lo genera.
 *
 * 3. LO QUE LLEGA NO ENTRA A LA FICHA. Queda guardado aparte y RRHH lo revisa
 *    contra lo que ya había. Un RUT o una AFP mal escritos por la propia
 *    persona salen después en una liquidación y en Previred, donde cuestan
 *    plata y tiempo; acá cuestan una mirada.
 *
 * 4. EL TOKEN MANDA, NO LO QUE VENGA EN EL CUERPO. Ninguna de las rutas
 *    públicas acepta un id de trabajador ni nada que apunte a otra ficha: a
 *    quién pertenece lo decide la fila que encontró el token, y punto.
 */

import { buscar, primero, insertar, actualizar, anotar } from './datos.js';
import { normalizarRut, dvCorrecto, formatearRut } from './rut.js';
import { camposFicha, editarFicha } from './rrhh.js';
import { crearTrabajador, CARGOS } from './asistencia.js';
import { hoyISO } from './fechas.js';

/** Lo que dura un enlace si nadie dice otra cosa. */
export const DIAS_POR_DEFECTO = 7;
const DIAS_MAXIMO = 30;

// ---------------------------------------------------------------- el token
const texto = new TextEncoder();

/**
 * 32 bytes al azar en base64url. No lleva nada adentro —ni el id, ni la fecha,
 * ni el nombre—: todo eso vive en la fila, y así el enlace no cuenta nada de
 * quien lo recibe a nadie que lo vea de paso.
 */
export function tokenNuevo() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * El hash con el que se busca y se guarda.
 *
 * Con llave (HMAC) y no un SHA-256 pelado: sin la llave, una copia de la base
 * no sirve ni para comprobar si un token dado es de los que están pendientes.
 *
 * Y no es PBKDF2, que es lo que se usa para las contraseñas, a propósito:
 * PBKDF2 está para estirar lo que una persona eligió y se puede adivinar. Esto
 * son 256 bits al azar, que no se adivinan probando; estirarlos solo obligaría
 * a recorrer la tabla entera en cada apertura, porque cada fila tendría su sal.
 */
export async function hashToken(token, env) {
  const llave = await crypto.subtle.importKey(
    'raw', texto.encode(env.SESION_SECRETO || ''),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firma = new Uint8Array(await crypto.subtle.sign('HMAC', llave, texto.encode(token)));
  return Array.from(firma, (b) => b.toString(16).padStart(2, '0')).join('');
}

const tokenValido = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(t);

// ---------------------------------------------------------------- campos
/**
 * Lo único que el formulario público puede escribir.
 *
 * Es una lista blanca y no un "todo menos": `camposFicha` acepta columnas que
 * acá no corresponden —el saldo de feriado inicial, los años previos
 * acreditados, el APV—, y aunque lo propuesto no se aplique solo, RRHH acepta
 * mirando. Un campo que la persona no debería poder proponer no tiene por qué
 * llegar a estar en la pantalla de revisión.
 *
 * Lo que queda fuera y se decide en la oficina: el cargo, la instalación, la
 * fecha de ingreso, el sueldo y todo lo del contrato.
 */
export const CAMPOS_INGRESO = {
  nombres:           { rotulo: 'Nombres', max: 80 },
  apellido_paterno:  { rotulo: 'Apellido paterno', max: 60 },
  apellido_materno:  { rotulo: 'Apellido materno', max: 60 },
  fecha_nacimiento:  { rotulo: 'Fecha de nacimiento', tipo: 'fecha' },
  sexo:              { rotulo: 'Sexo', opciones: ['F', 'M', 'X'] },
  nacionalidad:      { rotulo: 'Nacionalidad', max: 40 },
  estado_civil:      { rotulo: 'Estado civil', max: 30 },
  nivel_estudios:    { rotulo: 'Nivel de estudios', max: 60 },
  telefono:          { rotulo: 'Teléfono', max: 40 },
  email:             { rotulo: 'Correo', max: 120 },
  direccion:         { rotulo: 'Dirección', max: 200 },
  comuna:            { rotulo: 'Comuna', max: 60 },
  region:            { rotulo: 'Región', max: 60 },
  afp:               { rotulo: 'AFP', max: 40 },
  jubilado:          { rotulo: 'Recibe pensión', tipo: 'bool' },
  salud_sistema:     { rotulo: 'Sistema de salud', opciones: ['fonasa', 'isapre'] },
  salud_isapre:      { rotulo: 'Isapre', max: 60 },
  salud_plan_uf:     { rotulo: 'Plan pactado (UF)', tipo: 'decimal' },
  banco:             { rotulo: 'Banco', max: 60 },
  cuenta_tipo:       { rotulo: 'Tipo de cuenta', max: 30 },
  cuenta_numero:     { rotulo: 'N° de cuenta', max: 40 },
  emergencia_nombre:     { rotulo: 'Contacto de emergencia', max: 100 },
  emergencia_telefono:   { rotulo: 'Teléfono de emergencia', max: 40 },
  emergencia_parentesco: { rotulo: 'Parentesco', max: 40 },
  talla_uniforme:    { rotulo: 'Talla de uniforme', max: 20 },
  talla_zapato:      { rotulo: 'Talla de zapato', max: 10 },
  licencia_conducir: { rotulo: 'Licencia de conducir', max: 20 },
  discapacidad:      { rotulo: 'Acredita discapacidad', tipo: 'bool' },
  observaciones:     { rotulo: 'Algo que debamos saber', max: 1000 },
};

/** Los que son de la persona y no de la ficha de RRHH. */
const CAMPOS_NOMBRE = ['nombres', 'apellido_paterno', 'apellido_materno'];

const limpio = (v, max) => {
  const t = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return t ? t.slice(0, max) : null;
};
const siNo = (v) => v === true || v === 'true' || v === 'si' || v === 'sí' || v === 1;

/**
 * Pasa lo que llegó por la lista blanca y lo deja en su forma final.
 *
 * Devuelve `{ datos, error }`. Lo que no calza con su tipo se descarta en vez
 * de hacer fallar el envío entero: quien está llenando esto es la persona que
 * empieza el lunes, desde un teléfono, y perder quince campos buenos por uno
 * mal escrito es exactamente la razón por la que hoy nadie manda nada.
 * Lo que sí detiene el envío es lo que no se puede inventar: el nombre y el
 * RUT, de los que sale su cuenta.
 */
export function revisarEnvio(cuerpo, ficha) {
  const datos = {};
  for (const [campo, def] of Object.entries(CAMPOS_INGRESO)) {
    if (!(campo in cuerpo)) continue;
    const v = cuerpo[campo];
    if (def.tipo === 'bool') { datos[campo] = siNo(v); continue; }
    if (def.tipo === 'fecha') {
      const t = limpio(v, 10);
      if (t && /^\d{4}-\d{2}-\d{2}$/.test(t)) datos[campo] = t;
      continue;
    }
    if (def.tipo === 'decimal') {
      const n = Number(String(v ?? '').replace(',', '.').replace(/[^\d.]/g, ''));
      if (Number.isFinite(n) && n > 0 && n < 100) datos[campo] = Math.round(n * 1000) / 1000;
      continue;
    }
    const t = limpio(v, def.max || 100);
    if (!t) continue;
    if (def.opciones && !def.opciones.includes(t)) continue;
    datos[campo] = t;
  }

  if (!datos.nombres || !datos.apellido_paterno) {
    return { error: 'Escriba su nombre y su apellido paterno' };
  }

  const rut = normalizarRut(cuerpo.rut);
  if (!rut) return { error: 'El RUT no tiene forma de RUT. Escríbalo como 12.345.678-9.' };
  if (!dvCorrecto(rut)) {
    return { error: `El dígito verificador de ${formatearRut(rut)} no calza. Revíselo.` };
  }
  // Si la oficina ya sabía de quién era el enlace, no sirve para cargar a otro.
  if (ficha.rut_esperado && ficha.rut_esperado !== rut) {
    return { error: 'Este enlace está a nombre de otra persona. Pida el suyo a la oficina.' };
  }
  datos.rut = rut;

  if (datos.email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(datos.email)) {
    return { error: 'Ese correo no se entiende. Revíselo o déjelo en blanco.' };
  }
  if (datos.fecha_nacimiento) {
    const hoy = hoyISO();
    const anios = (Date.parse(hoy) - Date.parse(datos.fecha_nacimiento)) / 31557600000;
    if (!(anios > 15 && anios < 90)) {
      return { error: 'Revise la fecha de nacimiento: no calza con una edad de trabajo.' };
    }
  }
  // Decir "isapre" sin decir cuál deja la liquidación sin la cotización real.
  if (datos.salud_sistema === 'isapre' && !datos.salud_isapre) {
    return { error: 'Si está en isapre, escriba cuál.' };
  }
  return { datos };
}

// ---------------------------------------------------------------- oficina
const faltaTabla = (e) => /fichas_ingreso/.test(e?.message || '');

const NO_HAY_TABLA = {
  error: 'La ficha de ingreso por enlace todavía no está creada en la base. '
    + 'Falta aplicar la migración 20261020120000_ficha_ingreso.sql: revise '
    + '/api/diagnostico y COMO-APLICAR-MIGRACIONES.md.',
  status: 503,
};

/**
 * La fila como la ve la oficina. El hash del token y la huella de la IP no
 * salen nunca de acá: no le sirven a ninguna pantalla y son justamente las dos
 * columnas que no conviene andar paseando.
 */
const sinSecretos = (f) => {
  const { token_hash, recibido_huella, ...resto } = f;
  return resto;
};

/** El estado que se muestra. "Vencida" no se guarda: se cumple sola. */
export function estadoVisible(f, ahora = Date.now()) {
  if (f.estado === 'pendiente' && Date.parse(f.vence_en) <= ahora) return 'vencida';
  return f.estado;
}

/**
 * Genera el enlace.
 *
 * `base` es el origen desde el que lo está pidiendo la oficina, así que el
 * enlace sale apuntando al mismo lugar donde está trabajando: en producción a
 * adm.seggarridos.com y en las pruebas al localhost, sin tener nada escrito a
 * mano en ninguna parte.
 *
 * El token va en el fragmento (#) y no en la ruta ni en el query: el navegador
 * no manda el fragmento al servidor, así que no queda en los registros de
 * acceso ni se escapa en el Referer. La página lo lee y lo manda en el cuerpo.
 */
export async function crearEnlace(env, quien, cuerpo, base) {
  const dias = Math.min(Math.max(Math.round(Number(cuerpo.dias)) || DIAS_POR_DEFECTO, 1),
                        DIAS_MAXIMO);

  let trabajador = null;
  if (cuerpo.trabajador_id) {
    trabajador = await primero(env,
      `trabajadores?select=id,nombre,rut&id=eq.${Math.round(Number(cuerpo.trabajador_id)) || 0}`);
    if (!trabajador) return { error: 'Esa persona no está en el registro', status: 404 };
  }

  const nombre = trabajador?.nombre || limpio(cuerpo.nombre_referencia, 120);
  if (!nombre) {
    return { error: 'Escriba a nombre de quién va el enlace, para después saber de quién es', status: 400 };
  }

  // Para alguien que ya está cargado, el RUT del enlace es el suyo y no se
  // pregunta: así el formulario no puede terminar creando a otra persona.
  let rutEsperado = trabajador ? trabajador.rut : null;
  if (!rutEsperado && cuerpo.rut) {
    rutEsperado = normalizarRut(cuerpo.rut);
    if (!rutEsperado) return { error: 'Ese RUT no tiene forma de RUT', status: 400 };
    if (!dvCorrecto(rutEsperado)) {
      return { error: `El dígito verificador de ${formatearRut(rutEsperado)} no calza`, status: 400 };
    }
  }

  const token = tokenNuevo();
  const fila = {
    trabajador_id: trabajador?.id ?? null,
    token_hash: await hashToken(token, env),
    nombre_referencia: nombre,
    rut_esperado: rutEsperado,
    vence_en: new Date(Date.now() + dias * 86400000).toISOString(),
    enviado_a: limpio(cuerpo.enviado_a, 120),
    nota: limpio(cuerpo.nota, 300),
    creado_por: quien,
  };

  let creado;
  try {
    [creado] = await insertar(env, 'fichas_ingreso', fila);
  } catch (e) {
    if (faltaTabla(e)) return NO_HAY_TABLA;
    throw e;
  }

  await anotar(env, quien, 'ficha_ingreso', creado.id, 'generó un enlace de ficha de ingreso',
    `${nombre} · vence ${fila.vence_en.slice(0, 10)}`);

  // El token en claro sale una sola vez, acá. No se guarda en ninguna parte,
  // así que si se pierde hay que generar otro enlace: es lo mismo que pasa
  // con una contraseña, y por la misma razón.
  return { ficha: { ...sinSecretos(creado), estado_visible: 'pendiente' }, token, dias,
           enlace: `${base}/ficha#${token}` };
}

export async function listarEnlaces(env) {
  let filas;
  try {
    filas = await buscar(env,
      'fichas_ingreso?select=id,trabajador_id,nombre_referencia,rut_esperado,estado,'
      + 'vence_en,enviado_a,nota,creado_por,creado_en,recibido_en,revisado_por,revisado_en,'
      + 'trabajadores(nombre,activo)&order=creado_en.desc&limit=200');
  } catch (e) {
    if (faltaTabla(e)) return { fichas: [], sin_tabla: true, aviso: NO_HAY_TABLA.error };
    throw e;
  }
  const ahora = Date.now();
  return {
    fichas: filas.map((f) => ({
      ...f,
      rut_esperado: f.rut_esperado ? formatearRut(f.rut_esperado) : null,
      estado_visible: estadoVisible(f, ahora),
    })),
  };
}

/** Cómo se muestra un valor en la comparación. */
function comoTexto(campo, v) {
  if (v === null || v === undefined || v === '') return '';
  const def = CAMPOS_INGRESO[campo];
  if (def?.tipo === 'bool') return v === true || v === 'true' ? 'Sí' : 'No';
  if (campo === 'sexo') return { F: 'Femenino', M: 'Masculino', X: 'Otro' }[v] || String(v);
  if (campo === 'salud_sistema') return v === 'isapre' ? 'Isapre' : 'Fonasa';
  return String(v);
}

/**
 * Lo que llegó, puesto al lado de lo que ya había.
 *
 * Esto es la pantalla de revisión: sin la comparación, aceptar una ficha es
 * apretar un botón a ciegas, y el día que alguien escriba mal su RUT nadie se
 * va a dar cuenta hasta la primera liquidación.
 */
export function comparar(datos, trabajador) {
  const t = trabajador || {};
  const filas = [];
  for (const [campo, def] of Object.entries(CAMPOS_INGRESO)) {
    if (!(campo in datos)) continue;
    const propuesto = comoTexto(campo, datos[campo]);
    const actual = comoTexto(campo, t[campo]);
    if (!propuesto && !actual) continue;
    filas.push({
      campo, rotulo: def.rotulo, actual, propuesto,
      cambia: propuesto !== actual,
      // Un dato que llega donde no había nada es lo que se estaba buscando;
      // uno que pisa algo distinto es lo que hay que mirar dos veces.
      pisa: !!actual && propuesto !== actual,
    });
  }
  return filas;
}

export async function detalleEnlace(env, id) {
  let f;
  try {
    f = await primero(env, `fichas_ingreso?select=*&id=eq.${Math.round(Number(id)) || 0}`);
  } catch (e) {
    if (faltaTabla(e)) return NO_HAY_TABLA;
    throw e;
  }
  if (!f) return { error: 'Ese enlace no existe', status: 404 };

  const datos = f.datos || {};
  // Si el enlace no estaba amarrado a nadie, se busca por RUT: la misma regla
  // que la carga masiva. El nombre se escribe distinto cada vez; el RUT no.
  let trabajador = null;
  if (f.trabajador_id) {
    trabajador = await primero(env, `trabajadores?select=*&id=eq.${f.trabajador_id}`);
  } else if (datos.rut) {
    trabajador = await primero(env,
      `trabajadores?select=*&rut=eq.${encodeURIComponent(datos.rut)}`);
  }
  if (trabajador) delete trabajador.clave;

  return {
    ficha: { ...sinSecretos(f), estado_visible: estadoVisible(f),
             rut_esperado: f.rut_esperado ? formatearRut(f.rut_esperado) : null },
    rut: datos.rut ? formatearRut(datos.rut) : null,
    comparacion: comparar(datos, trabajador),
    trabajador: trabajador
      ? { id: trabajador.id, nombre: trabajador.nombre, rut: formatearRut(trabajador.rut),
          usuario: trabajador.usuario, activo: trabajador.activo, cargo: trabajador.cargo }
      : null,
    // Enganchar una ficha a alguien que ya existe con otro RUT sería cambiarle
    // la clave de asistencia sin decirlo, así que se avisa y no se toca.
    rut_distinto: !!(trabajador && datos.rut && trabajador.rut !== datos.rut),
    cargos: CARGOS,
  };
}

export async function anularEnlace(env, quien, id, motivo) {
  const f = await primero(env, `fichas_ingreso?select=*&id=eq.${Math.round(Number(id)) || 0}`);
  if (!f) return { error: 'Ese enlace no existe', status: 404 };
  if (f.estado === 'aceptada') {
    return { error: 'Esa ficha ya se aceptó: anularla no desharía lo que se escribió', status: 409 };
  }
  await actualizar(env, `fichas_ingreso?id=eq.${f.id}`, {
    estado: 'anulada', revisado_por: quien, revisado_en: new Date().toISOString(),
    nota_revision: limpio(motivo, 300),
  });
  await anotar(env, quien, 'ficha_ingreso', f.id, 'anuló un enlace de ficha de ingreso',
    f.nombre_referencia);
  return { ok: true };
}

/**
 * RRHH acepta lo que llegó: recién acá se escribe en `trabajadores`.
 *
 * `cuerpo.campos` deja elegir qué se aplica. Si no viene, se aplica todo lo
 * que cambia: el caso normal es que esté bien y aceptarlo campo por campo
 * sería un trámite que nadie va a hacer.
 */
export async function aceptarFicha(env, quien, id, cuerpo) {
  const d = await detalleEnlace(env, id);
  if (d.error) return d;
  const f = d.ficha;

  if (f.estado !== 'recibida') {
    return { error: f.estado === 'aceptada'
      ? 'Esa ficha ya se aceptó'
      : 'Esa ficha todavía no llega: no hay nada que aceptar', status: 409 };
  }

  const datos = f.datos || {};
  const elegidos = Array.isArray(cuerpo.campos) && cuerpo.campos.length
    ? new Set(cuerpo.campos.filter((c) => c in CAMPOS_INGRESO))
    : new Set(d.comparacion.filter((x) => x.cambia).map((x) => x.campo));

  let trabajador = d.trabajador;
  let creado = false;

  if (!trabajador) {
    // Nadie con ese RUT: se crea, con su cuenta del libro de asistencia, igual
    // que si lo diera de alta la oficina. El cargo lo pone RRHH acá, porque es
    // lo único de esto que no decide la persona.
    const r = await crearTrabajador(env, quien, {
      nombres: datos.nombres,
      apellido_paterno: datos.apellido_paterno,
      apellido_materno: datos.apellido_materno,
      rut: datos.rut,
      telefono: datos.telefono,
      cargo: CARGOS.includes(cuerpo.cargo) ? cuerpo.cargo : 'guardia',
      instalacion_id: cuerpo.instalacion_id,
    });
    if (r.error) return r;
    trabajador = { id: r.trabajador.id, nombre: r.trabajador.nombre };
    creado = true;
  } else if (d.rut_distinto) {
    return {
      error: `El RUT que escribió (${d.rut}) no es el que tiene cargado `
        + `${trabajador.nombre} (${trabajador.rut}). El RUT es su clave del libro de `
        + 'asistencia, así que no se cambia desde acá: corríjalo en su ficha si '
        + 'corresponde, o anule el enlace y genere uno nuevo.',
      status: 409,
    };
  }

  // Solo las columnas de la ficha: el nombre va aparte porque no pasa por
  // `camposFicha`, que es de RRHH y no toca la identidad de la persona.
  const paraFicha = {};
  for (const campo of elegidos) {
    if (CAMPOS_NOMBRE.includes(campo)) continue;
    if (campo in datos) paraFicha[campo] = datos[campo];
  }
  // `camposFicha` se llama acá solo para saber si queda algo que escribir:
  // `editarFicha` lo vuelve a hacer con el cuerpo crudo y devuelve error si no
  // queda nada, que acá no es un error sino una ficha que no cambió nada.
  if (Object.keys(camposFicha(paraFicha)).length) {
    const r = await editarFicha(env, quien, trabajador.id, paraFicha);
    if (r.error) return r;
  }

  // El nombre, solo si lo eligieron y solo para alguien que ya existía: al
  // recién creado se lo acaba de poner esta misma ficha.
  if (!creado) {
    const nombre = {};
    for (const campo of CAMPOS_NOMBRE) {
      if (elegidos.has(campo) && campo in datos) nombre[campo] = datos[campo];
    }
    if (Object.keys(nombre).length) {
      const actual = await primero(env,
        `trabajadores?select=nombres,apellido_paterno,apellido_materno&id=eq.${trabajador.id}`);
      const junto = { ...actual, ...nombre };
      // El usuario no se recalcula: la bitácora y las marcas de asistencia ya
      // quedaron escritas con el que tenía, y cambiarlo le quitaría la cuenta.
      await actualizar(env, `trabajadores?id=eq.${trabajador.id}`, {
        ...nombre,
        nombre: [junto.nombres, junto.apellido_paterno, junto.apellido_materno]
          .filter(Boolean).join(' '),
      });
    }
  }

  await actualizar(env, `fichas_ingreso?id=eq.${f.id}`, {
    estado: 'aceptada',
    trabajador_id: trabajador.id,
    revisado_por: quien,
    revisado_en: new Date().toISOString(),
    nota_revision: limpio(cuerpo.nota_revision, 300),
  });

  await anotar(env, quien, 'ficha_ingreso', f.id,
    creado ? 'aceptó la ficha de ingreso y creó al trabajador' : 'aceptó la ficha de ingreso',
    `${trabajador.nombre} · ${[...elegidos].join(', ') || 'sin cambios'}`.slice(0, 900));

  return { ok: true, trabajador_id: trabajador.id, creado, aplicados: [...elegidos] };
}

// ---------------------------------------------------------------- público
/**
 * Lo mismo para las tres formas de fallar: vencido, ya usado, o nunca existió.
 *
 * Es a propósito que no se distingan. Decir "este enlace ya se usó" confirma
 * que ese token existió, y decir "venció" confirma hasta cuándo: son dos
 * datos que quien tiene el enlace correcto no necesita, y quien lo está
 * probando sí.
 */
export const NO_SIRVE = {
  error: 'Este enlace no sirve. Puede que haya vencido, que ya se haya usado o '
    + 'que esté incompleto. Pídale uno nuevo a la oficina.',
  status: 404,
};

/** Busca la ficha del token. Null si no sirve, por el motivo que sea. */
async function fichaDelToken(env, token) {
  if (!tokenValido(token)) return null;
  const f = await primero(env,
    `fichas_ingreso?select=*&token_hash=eq.${await hashToken(token, env)}`);
  if (!f) return null;
  if (f.estado !== 'pendiente') return null;          // de un solo uso
  if (Date.parse(f.vence_en) <= Date.now()) return null;
  return f;
}

/**
 * Abre el formulario. Lo único que devuelve de la ficha es a nombre de quién
 * va: el que la abre tiene que reconocerse, y nada más. Lo que la empresa ya
 * sepa de esa persona no se muestra —el enlace pudo irse a un número
 * equivocado—, así que lo que llega es lo que la persona escribe de cero.
 */
export async function abrir(env, token) {
  let f;
  try {
    f = await fichaDelToken(env, token);
  } catch (e) {
    if (faltaTabla(e)) return NO_HAY_TABLA;
    throw e;
  }
  if (!f) return NO_SIRVE;

  const afps = await buscar(env, 'afps?select=nombre&activa=is.true&order=nombre.asc')
    .catch(() => []);
  return {
    nombre_referencia: f.nombre_referencia,
    rut_fijo: f.rut_esperado ? formatearRut(f.rut_esperado) : null,
    vence_en: f.vence_en,
    afps: afps.map((a) => a.nombre),
  };
}

/** Recibe la ficha. Después de esto el enlace deja de servir. */
export async function recibir(env, token, cuerpo, huella) {
  let f;
  try {
    f = await fichaDelToken(env, token);
  } catch (e) {
    if (faltaTabla(e)) return NO_HAY_TABLA;
    throw e;
  }
  if (!f) return NO_SIRVE;

  const r = revisarEnvio(cuerpo, f);
  if (r.error) return { error: r.error, status: 400 };

  // La condición `estado=eq.pendiente` va en el filtro y no solo en la
  // comprobación de arriba: dos envíos a la vez con el mismo token entrarían
  // los dos, y el segundo pisaría al primero. Así el segundo no actualiza
  // nada y se le contesta que el enlace ya no sirve.
  const filas = await actualizar(env,
    `fichas_ingreso?id=eq.${f.id}&estado=eq.pendiente`, {
      estado: 'recibida',
      datos: r.datos,
      recibido_en: new Date().toISOString(),
      recibido_huella: huella || null,
    });
  if (!Array.isArray(filas) || !filas.length) return NO_SIRVE;

  // En la bitácora, `quien` es siempre una cuenta del sistema. Esto no lo hizo
  // ninguna, así que se dice tal cual en vez de poner un nombre que se podría
  // confundir con un usuario de la oficina.
  await anotar(env, '(enlace de ingreso)', 'ficha_ingreso', f.id,
    'llenó su ficha de ingreso',
    `${r.datos.nombres} ${r.datos.apellido_paterno} · ${formatearRut(r.datos.rut)}`);
  return { ok: true, nombre: r.datos.nombres };
}

/** Cuántas esperan revisión. El panel de RRHH lo muestra arriba. */
export async function porRevisar(env) {
  try {
    const filas = await buscar(env,
      'fichas_ingreso?select=id,nombre_referencia,recibido_en&estado=eq.recibida'
      + '&order=recibido_en.asc');
    return filas;
  } catch (e) {
    // Sin la migración aplicada el panel sigue andando: esto es una lista de
    // más, no el panel.
    if (faltaTabla(e)) return [];
    throw e;
  }
}
