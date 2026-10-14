/**
 * Libro de asistencia.
 *
 * Dos mundos que se tocan lo menos posible:
 *   - El guardia entra en asistencia.seggarridos.com, con su usuario y su RUT,
 *     y lo único que puede hacer es marcar su entrada y su salida.
 *   - La oficina entra en adm.seggarridos.com y ahí crea trabajadores y lee el
 *     libro. No marca por nadie.
 *
 * El libro no se edita. Una marca registrada queda como está: eso es lo que
 * hace que sirva de respaldo frente a un reclamo, igual que el libro de papel
 * que nadie puede rehacer después.
 */

import { buscar, primero, insertar, actualizar, anotar } from './datos.js';
import { ingresar, hashear } from './sesion.js';
import { normalizarRut, dvCorrecto, formatearRut } from './rut.js';

/**
 * Un turno abierto por más de estas horas ya no se cierra con una salida: es
 * una salida que no se marcó. Marcarla veinte horas después escribiría una
 * jornada que no ocurrió, y el libro dejaría de ser cierto. Queda abierta,
 * visible en la oficina como «sin salida», y el guardia empieza turno nuevo.
 */
const MAX_TURNO_HORAS = 20;

/** Dos apretones seguidos del mismo botón son el mismo apretón. */
const SEGUNDOS_REPETIDA = 90;

// ---------------------------------------------------------------- hora local
/**
 * El día del turno se cuenta en hora de Chile, no en UTC. Sin esto, todo lo
 * marcado después de las 21:00 aparecería al día siguiente en el libro.
 */
const ZONA = 'America/Santiago';

function conZona(opciones, respaldo) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, ...opciones });
  } catch {
    // Si la plataforma no conoce la zona, se usa el huso de Chile continental
    // en horario de verano. Es un respaldo para no caerse, no la regla.
    return respaldo;
  }
}

// Las dos reciben lo que venga: un Date o lo que la base devuelve, que es
// texto. Darle el texto directo a Intl revienta con «Invalid time value».
const comoFecha = (d) => (d instanceof Date ? d : new Date(d));

export function fechaChile(valor = new Date()) {
  const d = comoFecha(valor);
  const f = conZona({ year: 'numeric', month: '2-digit', day: '2-digit' }, null);
  if (f) return f.format(d);
  return new Date(d.getTime() - 3 * 3600000).toISOString().slice(0, 10);
}

export function horaChile(valor = new Date()) {
  const d = comoFecha(valor);
  const f = conZona({ hour: '2-digit', minute: '2-digit', hour12: false }, null);
  if (f) return f.format(d);
  return new Date(d.getTime() - 3 * 3600000).toISOString().slice(11, 16);
}

const horasEntre = (a, b) => (new Date(b) - new Date(a)) / 3600000;

// ---------------------------------------------------------------- nombre de usuario
const sinTildes = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z]/g, '');

/**
 * Inicial del primer nombre + apellido paterno completo + inicial del materno.
 * Es la regla que ya usa la oficina: José Garrido Huinca -> jgarridoh.
 */
export function usuarioPara(nombres, paterno, materno) {
  const n = sinTildes(String(nombres ?? '').trim().split(/\s+/)[0]);
  const p = sinTildes(paterno);
  const m = sinTildes(String(materno ?? '').trim().split(/\s+/)[0]);
  if (!n || !p) return null;
  return n[0] + p + (m ? m[0] : '');
}

/**
 * El usuario tiene que ser único entre los trabajadores y también entre las
 * cuentas de la oficina: dos personas con el mismo usuario en pantallas
 * distintas es una confusión esperando ocurrir, y la bitácora guarda el
 * usuario, no la tabla de donde salió.
 */
export async function usuarioLibre(env, base) {
  for (let i = 0; i < 50; i++) {
    const intento = i === 0 ? base : base + (i + 1);
    const [t, o] = await Promise.all([
      primero(env, `trabajadores?select=id&usuario=eq.${encodeURIComponent(intento)}`),
      primero(env, `usuarios?select=email&usuario=eq.${encodeURIComponent(intento)}`),
    ]);
    if (!t && !o) return intento;
  }
  return null;
}

// ---------------------------------------------------------------- trabajadores
const limpio = (v, max) => {
  const t = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return t ? t.slice(0, max) : null;
};

const CARGOS = ['guardia', 'supervisor', 'nochero', 'rondin'];

async function instalacionValida(env, id) {
  if (id === null || id === undefined || id === '') return null;
  const n = Math.round(Number(id));
  if (!Number.isFinite(n)) return null;
  const i = await primero(env, `instalaciones?select=id&id=eq.${n}`);
  return i ? n : null;
}

/** Ficha pública de un trabajador: nunca sale la derivación de la clave. */
export const fichaTrabajador = (t) => ({
  id: t.id,
  rut: formatearRut(t.rut),
  nombre: t.nombre,
  nombres: t.nombres,
  apellido_paterno: t.apellido_paterno,
  apellido_materno: t.apellido_materno,
  usuario: t.usuario,
  telefono: t.telefono,
  cargo: t.cargo,
  instalacion_id: t.instalacion_id,
  instalacion: t.instalaciones?.nombre ?? null,
  activo: t.activo,
  bloqueado: !!(t.bloqueado_hasta && new Date(t.bloqueado_hasta) > new Date()),
  ultimo_ingreso: t.ultimo_ingreso,
});

export async function crearTrabajador(env, quien, cuerpo) {
  const nombres = limpio(cuerpo.nombres, 80);
  const paterno = limpio(cuerpo.apellido_paterno, 60);
  const materno = limpio(cuerpo.apellido_materno, 60);
  if (!nombres || !paterno) {
    return { error: 'Faltan el nombre y el apellido paterno', status: 400 };
  }

  const rut = normalizarRut(cuerpo.rut);
  if (!rut) return { error: 'El RUT no tiene forma de RUT', status: 400 };
  if (!dvCorrecto(rut)) {
    // Un RUT mal tecleado deja a esa persona sin poder entrar nunca, porque el
    // RUT es su contraseña. Se avisa acá, frente a quien lo está escribiendo.
    return { error: `El dígito verificador de ${formatearRut(rut)} no calza. Revíselo.`, status: 400 };
  }

  const repetido = await primero(env, `trabajadores?select=nombre,usuario&rut=eq.${rut}`);
  if (repetido) {
    return { error: `Ese RUT ya está cargado: ${repetido.nombre} (${repetido.usuario})`, status: 409 };
  }

  const base = usuarioPara(nombres, paterno, materno);
  if (!base) return { error: 'Con ese nombre no se puede armar un usuario', status: 400 };
  const usuario = await usuarioLibre(env, base);
  if (!usuario) return { error: 'No se pudo encontrar un usuario libre', status: 409 };

  const cargo = CARGOS.includes(cuerpo.cargo) ? cuerpo.cargo : 'guardia';
  const fila = {
    rut,
    nombres,
    apellido_paterno: paterno,
    apellido_materno: materno,
    nombre: [nombres, paterno, materno].filter(Boolean).join(' '),
    usuario,
    clave: await hashear(rut),          // la clave es el RUT, pero guardado derivado
    telefono: limpio(cuerpo.telefono, 40),
    cargo,
    instalacion_id: await instalacionValida(env, cuerpo.instalacion_id),
    creado_por: quien,
  };

  const [creado] = await insertar(env, 'trabajadores', fila);
  await anotar(env, quien, 'trabajador', creado.id,
    'creó al trabajador', `${creado.nombre} · usuario ${creado.usuario}`);
  return { trabajador: fichaTrabajador(creado) };
}

export async function editarTrabajador(env, quien, id, cuerpo) {
  const t = await primero(env, `trabajadores?select=*&id=eq.${id}`);
  if (!t) return { error: 'Ese trabajador no existe', status: 404 };

  const campos = {};
  const notas = [];

  if ('telefono' in cuerpo) campos.telefono = limpio(cuerpo.telefono, 40);
  if ('cargo' in cuerpo && CARGOS.includes(cuerpo.cargo)) campos.cargo = cuerpo.cargo;
  if ('instalacion_id' in cuerpo) {
    campos.instalacion_id = await instalacionValida(env, cuerpo.instalacion_id);
  }
  if ('activo' in cuerpo) {
    campos.activo = cuerpo.activo === true || cuerpo.activo === 'true';
    notas.push(campos.activo ? 'reactivado' : 'dado de baja');
  }

  // Desbloquear: un guardia que se equivocó cinco veces no puede quedarse
  // fuera de su turno esperando quince minutos si tiene al jefe al lado.
  if (cuerpo.desbloquear === true) {
    campos.intentos_fallidos = 0;
    campos.bloqueado_hasta = null;
    notas.push('desbloqueado');
  }

  // La clave vuelve al RUT. Es lo único que se puede hacer con ella: nadie,
  // tampoco la oficina, puede ver la que está guardada.
  if (cuerpo.restablecer_clave === true) {
    campos.clave = await hashear(t.rut);
    campos.intentos_fallidos = 0;
    campos.bloqueado_hasta = null;
    notas.push('clave vuelta al RUT');
  }

  if (!Object.keys(campos).length) return { error: 'No hay nada que cambiar', status: 400 };

  const [actualizado] = await actualizar(env, `trabajadores?id=eq.${t.id}`, campos);
  await anotar(env, quien, 'trabajador', t.id,
    notas.length ? notas.join(', ') : 'editó la ficha', t.nombre);
  return { trabajador: fichaTrabajador(actualizado) };
}

export async function listarTrabajadores(env) {
  const filas = await buscar(env,
    'trabajadores?select=*,instalaciones(nombre)&order=activo.desc,nombre.asc');
  return filas.map(fichaTrabajador);
}

// ---------------------------------------------------------------- ingreso del guardia
export const ingresoGuardia = (env, usuario, clave) =>
  ingresar(env, usuario, clave, {
    tabla: 'trabajadores',
    prepararClave: (c) => normalizarRut(c) || String(c ?? '').trim(),
    rotuloClave: 'su RUT',
  });

export async function trabajadorDeSesion(env, usuario) {
  const t = await primero(env,
    `trabajadores?select=*,instalaciones(nombre)&activo=is.true&usuario=eq.${encodeURIComponent(usuario)}`);
  return t || null;
}

// ---------------------------------------------------------------- marcas
/** La última marca de este trabajador, sea cual sea. */
const ultimaMarca = (env, trabajadorId) => primero(env,
  `marcas?select=*&trabajador_id=eq.${trabajadorId}&order=cuando.desc`);

/** Esa última marca, solo si todavía cuenta como un turno abierto. */
function turnoAbierto(ultima, ahora) {
  if (!ultima || ultima.tipo !== 'entrada') return null;
  if (horasEntre(ultima.cuando, ahora) > MAX_TURNO_HORAS) return null;
  return ultima;
}

const numeroONulo = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

/**
 * Estado con el que se pinta la pantalla del guardia: qué le toca apretar,
 * qué lleva marcado hoy y cuántas horas van.
 */
export async function estadoGuardia(env, trabajador) {
  const ahora = new Date();
  const abierta = turnoAbierto(await ultimaMarca(env, trabajador.id), ahora);
  const fecha = abierta ? abierta.fecha : fechaChile(ahora);

  const marcas = await buscar(env,
    `marcas?select=*,instalaciones(nombre)&trabajador_id=eq.${trabajador.id}` +
    `&fecha=eq.${fecha}&order=cuando.asc`);

  const instalaciones = await buscar(env,
    'instalaciones?select=id,nombre&activa=is.true&order=nombre.asc');

  return {
    trabajador: {
      nombre: trabajador.nombre,
      usuario: trabajador.usuario,
      cargo: trabajador.cargo,
      instalacion_id: trabajador.instalacion_id,
      instalacion: trabajador.instalaciones?.nombre ?? null,
    },
    fecha,
    hora: horaChile(ahora),
    siguiente: abierta ? 'salida' : 'entrada',
    desde: abierta ? abierta.cuando : null,
    horas_en_turno: abierta ? Number(horasEntre(abierta.cuando, ahora).toFixed(2)) : 0,
    marcas: marcas.map((m) => ({
      id: m.id,
      tipo: m.tipo,
      hora: horaChile(m.cuando),
      cuando: m.cuando,
      instalacion_id: m.instalacion_id,
      instalacion: m.instalaciones?.nombre ?? null,
      con_ubicacion: m.lat !== null && m.lat !== undefined,
    })),
    instalaciones,
  };
}

export async function marcar(env, trabajador, cuerpo) {
  const ahora = new Date();
  const ultima = await ultimaMarca(env, trabajador.id);
  const abierta = turnoAbierto(ultima, ahora);
  const esperado = abierta ? 'salida' : 'entrada';
  const tipo = cuerpo.tipo === 'entrada' || cuerpo.tipo === 'salida' ? cuerpo.tipo : esperado;

  // Primero el doble toque, antes de decidir si lo pedido corresponde: dos
  // apretones seguidos del mismo botón son el mismo apretón. Pasa siempre con
  // la señal mala del parque, cuando la primera respuesta no llega y la
  // persona vuelve a apretar. Se devuelve la marca que ya existe en vez de
  // retarlo por algo que hizo bien.
  if (ultima && ultima.tipo === tipo &&
      Math.abs(ahora - new Date(ultima.cuando)) < SEGUNDOS_REPETIDA * 1000) {
    return { marca: ultima, repetida: true, hora: horaChile(ultima.cuando) };
  }

  if (tipo !== esperado) {
    return {
      error: esperado === 'salida'
        ? 'Usted ya tiene una entrada marcada. Lo que corresponde ahora es la salida.'
        : 'No hay una entrada abierta. Lo que corresponde ahora es marcar la entrada.',
      esperado, status: 409,
    };
  }

  const pedida = await instalacionValida(env, cuerpo.instalacion_id);
  const instalacion_id = pedida
    ?? (abierta ? abierta.instalacion_id : null)
    ?? trabajador.instalacion_id
    ?? null;

  const lat = numeroONulo(cuerpo.lat, -90, 90);
  const lon = numeroONulo(cuerpo.lon, -180, 180);
  const tieneUbicacion = lat !== null && lon !== null;

  const [marca] = await insertar(env, 'marcas', {
    trabajador_id: trabajador.id,
    instalacion_id,
    tipo,
    cuando: ahora.toISOString(),
    // La salida se anota en el día del turno que cierra, no en el del reloj:
    // un turno de noche es una sola jornada, aunque cruce la medianoche.
    fecha: abierta ? abierta.fecha : fechaChile(ahora),
    lat: tieneUbicacion ? lat : null,
    lon: tieneUbicacion ? lon : null,
    exactitud_m: tieneUbicacion ? numeroONulo(Math.round(cuerpo.exactitud_m), 0, 100000) : null,
    nota: limpio(cuerpo.nota, 200),
  });

  await anotar(env, trabajador.usuario, 'marca', marca.id,
    `marcó ${tipo}`,
    `${horaChile(ahora)}${tieneUbicacion ? ' con ubicación' : ' sin ubicación'}`);

  return {
    marca,
    hora: horaChile(marca.cuando),
    horas_turno: tipo === 'salida' && abierta
      ? Number(horasEntre(abierta.cuando, marca.cuando).toFixed(2))
      : null,
  };
}

// ---------------------------------------------------------------- el libro
/**
 * El libro que lee la oficina: una fila por jornada, no por marca.
 *
 * Una jornada es la pareja entrada/salida de un trabajador en una fecha. Las
 * que quedaron sin salida se marcan como tales en vez de desaparecer o de
 * inventarles una hora: que falte una salida es justamente lo que la oficina
 * necesita ver.
 */
export async function libro(env, { desde, hasta, trabajador_id, instalacion_id }) {
  const filtros = [`fecha=gte.${desde}`, `fecha=lte.${hasta}`];
  if (trabajador_id) filtros.push(`trabajador_id=eq.${Math.round(Number(trabajador_id))}`);
  if (instalacion_id) filtros.push(`instalacion_id=eq.${Math.round(Number(instalacion_id))}`);

  const marcas = await buscar(env,
    'marcas?select=*,trabajadores(nombre,usuario,rut),instalaciones(nombre)&' +
    filtros.join('&') + '&order=fecha.desc,cuando.asc');

  const jornadas = new Map();
  for (const m of marcas) {
    const llave = `${m.fecha}|${m.trabajador_id}`;
    if (!jornadas.has(llave)) {
      jornadas.set(llave, {
        fecha: m.fecha,
        trabajador_id: m.trabajador_id,
        trabajador: m.trabajadores?.nombre ?? '—',
        usuario: m.trabajadores?.usuario ?? null,
        rut: m.trabajadores?.rut ? formatearRut(m.trabajadores.rut) : null,
        instalacion: m.instalaciones?.nombre ?? null,
        entrada: null, salida: null, horas: null,
        entrada_ubicada: false, salida_ubicada: false,
        marcas: 0,
      });
    }
    const j = jornadas.get(llave);
    j.marcas++;
    if (!j.instalacion && m.instalaciones?.nombre) j.instalacion = m.instalaciones.nombre;
    const ubicada = m.lat !== null && m.lat !== undefined;
    if (m.tipo === 'entrada') {
      if (!j.entrada || new Date(m.cuando) < new Date(j.entrada)) {
        j.entrada = m.cuando; j.entrada_ubicada = ubicada;
      }
    } else if (!j.salida || new Date(m.cuando) > new Date(j.salida)) {
      j.salida = m.cuando; j.salida_ubicada = ubicada;
    }
  }

  const filas = [...jornadas.values()].map((j) => ({
    ...j,
    hora_entrada: j.entrada ? horaChile(j.entrada) : null,
    hora_salida: j.salida ? horaChile(j.salida) : null,
    horas: j.entrada && j.salida
      ? Number(horasEntre(j.entrada, j.salida).toFixed(2)) : null,
    completa: !!(j.entrada && j.salida),
  })).sort((a, b) =>
    b.fecha.localeCompare(a.fecha) || a.trabajador.localeCompare(b.trabajador));

  const horas = filas.reduce((s, f) => s + (f.horas || 0), 0);
  return {
    desde, hasta,
    jornadas: filas,
    resumen: {
      jornadas: filas.length,
      sin_salida: filas.filter((f) => !f.completa).length,
      horas: Number(horas.toFixed(1)),
      trabajadores: new Set(filas.map((f) => f.trabajador_id)).size,
    },
  };
}
