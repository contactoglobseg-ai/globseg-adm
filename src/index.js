/**
 * Administración Seguridad Garridos — Worker
 *
 * Identidad: cuenta propia con usuario y contraseña (ver sesion.js). La
 * contraseña nunca se guarda, solo su derivación PBKDF2, y la sesión viaja en
 * una cookie firmada, HttpOnly y SameSite=Strict.
 *
 * Datos: Supabase (Postgres). El control de quién ve qué vive acá, no en la
 * base: las tablas están cerradas y solo este Worker las abre.
 */

import { buscar, primero, insertar, insertarSinDuplicar, actualizar, anotar, ErrorDatos }
  from './datos.js';
import { ingresar, cambiarClave, crearSesion, leerSesion, cookieSesion, cookieBorrada }
  from './sesion.js';
import * as cotiz from './cotizaciones.js';
import * as lote from './lote.js';

const IVA = 0.19;

const PERMISOS = {
  gerencia:    ['facturacion', 'cotizaciones', 'personal', 'documentos', 'rrhh'],
  operaciones: ['facturacion', 'personal', 'documentos'],
  rrhh:        ['rrhh'],
  prevencion:  ['documentos'],
};

// ---------------------------------------------------------------- fechas
// YYYY-MM-DD con aritmética simple, sin zonas horarias: un periodo de
// facturación es un día de calendario, no un instante.
const hoyISO = () => new Date().toISOString().slice(0, 10);

function sumarDias(iso, dias) {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d) + dias * 86400000).toISOString().slice(0, 10);
}

function diasEntre(desde, hasta) {
  const p = (s) => { const [a, m, d] = s.split('-').map(Number); return Date.UTC(a, m - 1, d); };
  return Math.round((p(hasta) - p(desde)) / 86400000);
}

const esFecha = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

// ---------------------------------------------------------------- utilidades
const json = (datos, status = 200) =>
  new Response(JSON.stringify(datos), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const error = (mensaje, status = 400) => json({ error: mensaje }, status);

const entero = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------- identidad
async function identificar(request, env) {
  const nombre = await leerSesion(request, env);
  if (!nombre) return null;
  const u = await primero(env,
    `usuarios?select=*&activo=is.true&usuario=eq.${encodeURIComponent(nombre)}`);
  if (!u) return null;   // cuenta borrada o desactivada con la sesión abierta
  return { ...u, permisos: PERMISOS[u.rol] || [] };
}

const sinClave = (u) => ({
  usuario: u.usuario, nombre: u.nombre, rol: u.rol,
  debe_cambiar_clave: u.debe_cambiar_clave, permisos: u.permisos,
  puede_borrar: u.puede_borrar === true,
});

/**
 * Nombres de quienes pueden borrar. La pantalla los muestra para que el que no
 * puede sepa a quién pedírselo, en vez de toparse con un botón apagado.
 * Si la columna todavía no existe, no se inventa a nadie.
 */
async function quienBorra(env) {
  try {
    const filas = await buscar(env,
      'usuarios?select=nombre&puede_borrar=is.true&activo=is.true&order=nombre.asc');
    return filas.map((f) => f.nombre);
  } catch {
    return [];
  }
}

const puede = (usuario, modulo) => !!usuario?.permisos?.includes(modulo);

// ---------------------------------------------------------------- ciclos
/**
 * Mantiene al día los periodos de facturación:
 *  - crea el primero de cada servicio activo;
 *  - cuando un periodo termina, lo pasa a "solicitar_oc" y abre el siguiente;
 *  - un servicio cargado con fecha retroactiva recupera todos sus periodos
 *    en esta misma pasada.
 * Corre al entrar al panel, así que no depende de ninguna tarea programada.
 */
async function ponerCiclosAlDia(env) {
  const hoy = hoyISO();
  const servicios = await buscar(env,
    'servicios?select=id,fecha_inicio,dias_ciclo,monto_neto&activo=is.true');

  const nuevos = [];
  const cierres = [];

  for (const s of servicios) {
    const ultimo = await primero(env,
      `ciclos?select=numero,hasta,estado&servicio_id=eq.${s.id}&order=numero.desc`);

    if (ultimo && ultimo.estado === 'en_curso' && diasEntre(ultimo.hasta, hoy) >= 0) {
      cierres.push({ servicio_id: s.id, numero: ultimo.numero });
    }

    let numero = ultimo ? ultimo.numero : 0;
    let desde  = ultimo ? sumarDias(ultimo.hasta, 1) : s.fecha_inicio;

    const tope = numero + 500;   // freno ante una fecha de inicio absurda
    while (diasEntre(desde, hoy) >= 0 && numero < tope) {
      numero += 1;
      const hasta = sumarDias(desde, s.dias_ciclo - 1);
      nuevos.push({
        servicio_id: s.id, numero, desde, hasta,
        estado: diasEntre(hasta, hoy) >= 0 ? 'solicitar_oc' : 'en_curso',
        monto_neto: s.monto_neto ?? null,
      });
      desde = sumarDias(hasta, 1);
    }
  }

  for (const c of cierres) {
    await actualizar(env, `ciclos?servicio_id=eq.${c.servicio_id}&numero=eq.${c.numero}`,
      { estado: 'solicitar_oc', actualizado_en: new Date().toISOString() });
  }
  if (nuevos.length) {
    await insertarSinDuplicar(env, 'ciclos', nuevos, 'servicio_id,numero');
  }
  return nuevos.length + cierres.length;
}

/**
 * Encuentra la instalación por nombre, o la crea junto con su cliente si no
 * existe. Así la oficina puede dar de alta un parque nuevo sin que nadie tenga
 * que cargarlo antes en otra pantalla.
 *
 * La comparación es sin mayúsculas ni espacios de sobra, para que "PMGD Rengo"
 * y "pmgd rengo " no terminen siendo dos instalaciones distintas.
 */
const mismoNombre = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function resolverCliente(env, usuario, nombre) {
  const clientes = await buscar(env, 'clientes?select=id,nombre');
  const ya = clientes.find((c) => mismoNombre(c.nombre, nombre));
  if (ya) return ya;
  const [nuevo] = await insertar(env, 'clientes', { nombre: nombre.trim() });
  await anotar(env, usuario.usuario, 'cliente', nuevo.id, 'creado', nombre.trim());
  return nuevo;
}

async function resolverInstalacion(env, usuario, cuerpo) {
  if (entero(cuerpo.instalacion_id)) {
    const i = await primero(env, `instalaciones?select=id&id=eq.${entero(cuerpo.instalacion_id)}`);
    return i || { error: 'Esa instalación no existe' };
  }

  const nombre = (cuerpo.instalacion || '').trim();
  if (!nombre) return { error: 'Escriba el nombre de la instalación' };
  if (nombre.length > 160) return { error: 'El nombre de la instalación es demasiado largo' };

  const instalaciones = await buscar(env, 'instalaciones?select=id,nombre');
  const ya = instalaciones.find((i) => mismoNombre(i.nombre, nombre));
  if (ya) return { ...ya, ya_existia: true };

  const nombreCliente = (cuerpo.cliente || '').trim() || 'Sin cliente asignado';
  const cliente = await resolverCliente(env, usuario, nombreCliente);

  const [nueva] = await insertar(env, 'instalaciones', {
    cliente_id: cliente.id,
    nombre,
    comuna: (cuerpo.comuna || '').trim() || null,
    region: (cuerpo.region || '').trim() || null,
  });
  await anotar(env, usuario.usuario, 'instalacion', nueva.id, 'creada',
               `${nombre}${cuerpo.comuna ? ' · ' + cuerpo.comuna : ''} para ${nombreCliente}`);
  return nueva;
}

/** El periodo de esa instalación que contiene esa fecha, si existe. */
async function cicloDeLaFecha(env, instalacion_id, fecha) {
  const servicios = await buscar(env,
    `servicios?select=id&instalacion_id=eq.${instalacion_id}`);
  if (!servicios.length) return null;
  const ids = servicios.map((s) => s.id).join(',');
  return primero(env,
    `ciclos?select=id,numero,estado,desde,hasta&servicio_id=in.(${ids})`
    + `&desde=lte.${fecha}&hasta=gte.${fecha}&order=id.asc`);
}

// ---------------------------------------------------------------- panel
const ORDEN = { solicitar_oc: 1, pendiente_facturacion: 2, en_curso: 3, cerrado: 4 };

async function panel(env) {
  const [ciclos, sueltos] = await Promise.all([
    buscar(env, 'v_ciclos?select=*'),
    buscar(env, 'v_extras?select=*&ciclo_id=is.null&order=fecha.asc'),
  ]);

  for (const c of ciclos) {
    // La vista entrega neto e IVA; el total se arma acá para no repetir la
    // regla del 19% en dos lugares distintos.
    c.total_neto = Number(c.total_neto) || 0;
    c.extras_neto = Number(c.extras_neto) || 0;
    c.iva = Math.round(c.total_neto * IVA);
    c.total = c.total_neto + c.iva;
  }
  ciclos.sort((a, b) =>
    (ORDEN[a.estado] - ORDEN[b.estado]) || a.hasta.localeCompare(b.hasta));

  const abiertos = ciclos.filter((c) => c.estado !== 'cerrado');
  // Facturado y todavía sin cobrar: la plata que salió en factura y no entró.
  const facturadosSinCobrar = ciclos.filter(
    (c) => c.estado === 'cerrado' && c.pago_estado === 'por_cobrar');
  return {
    hoy: hoyISO(),
    ciclos,
    extras_sueltos: sueltos,
    resumen: {
      solicitar_oc:          ciclos.filter((c) => c.estado === 'solicitar_oc').length,
      pendiente_facturacion: ciclos.filter((c) => c.estado === 'pendiente_facturacion').length,
      en_curso:              ciclos.filter((c) => c.estado === 'en_curso').length,
      neto_por_cobrar:       abiertos.reduce((t, c) => t + c.total_neto, 0),
      facturado_sin_cobrar:  facturadosSinCobrar.length,
      neto_facturado_sin_cobrar: facturadosSinCobrar.reduce((t, c) => t + c.total_neto, 0),
      dias_mas_antiguo:      facturadosSinCobrar.reduce(
                               (m, c) => Math.max(m, c.dias_desde_factura || 0), 0),
      extras_sin_asignar:    sueltos.length,
      neto_extras_sueltos:   sueltos.reduce((t, e) => t + (Number(e.monto_neto) || 0), 0),
    },
  };
}

// ---------------------------------------------------------------- API
async function api(request, env, url, usuario) {
  const ruta = url.pathname.replace(/^\/api/, '');
  const metodo = request.method;
  const cuerpo = metodo === 'POST' || metodo === 'PATCH'
    ? await request.json().catch(() => ({}))
    : {};

  if (ruta === '/yo') {
    return json({ usuario: sinClave(usuario), quien_borra: await quienBorra(env) });
  }

  if (ruta === '/clave' && metodo === 'POST') {
    const r = await cambiarClave(env, usuario, cuerpo.actual, cuerpo.nueva);
    if (r.error) return error(r.error, r.status);
    await anotar(env, usuario.usuario, 'usuario', null, 'cambió su contraseña', null);
    return json({ ok: true });
  }

  // Con la contraseña inicial sin cambiar, lo único permitido es cambiarla.
  if (usuario.debe_cambiar_clave) {
    return error('Tiene que cambiar su contraseña antes de usar el sistema', 403);
  }

  // Catálogos: los usan los dos módulos, así que basta con cualquiera de ellos.
  if (ruta === '/catalogos' && metodo === 'GET') {
    if (!puede(usuario, 'facturacion') && !puede(usuario, 'cotizaciones')) {
      return error('Sin acceso a este módulo', 403);
    }
    const [tarifas, instalaciones, clientes] = await Promise.all([
      buscar(env, 'tarifas?select=*&activo=is.true&order=grupo.asc,precio.asc'),
      buscar(env, 'v_instalaciones?select=id,nombre,comuna,cliente&activa=is.true&order=nombre.asc'),
      buscar(env, 'clientes?select=id,nombre,rut,contacto,email&activo=is.true&order=nombre.asc'),
    ]);
    return json({ tarifas, instalaciones, clientes });
  }

  // Acciones sobre varios registros marcados a la vez. El permiso lo revisa
  // adentro, porque depende de qué se esté tocando.
  if (ruta === '/lote' && metodo === 'POST') {
    // Borrar es lo único que no se puede deshacer leyendo la bitácora, así que
    // no basta el módulo: hace falta el permiso personal.
    if (cuerpo.accion === 'borrar' && usuario.puede_borrar !== true) {
      const quienes = await quienBorra(env);
      return error(quienes.length
        ? `Solo ${quienes.join(' o ')} puede eliminar. Pídaselo.`
        : 'No tiene permiso para eliminar.', 403);
    }
    const r = await lote.aplicar(env, usuario, puede, cuerpo);
    if (r.error) return error(r.error, r.status);
    return json(r);
  }

  // ---------------------------------------------------------- cotizaciones
  if (ruta.startsWith('/cotizaciones')) {
    if (!puede(usuario, 'cotizaciones')) return error('Sin acceso a este módulo', 403);

    if (ruta === '/cotizaciones' && metodo === 'GET') {
      return json({ cotizaciones: await cotiz.listar(env) });
    }
    if (ruta === '/cotizaciones' && metodo === 'POST') {
      const r = await cotiz.crear(env, usuario, cuerpo);
      if (r.error) return error(r.error, r.status);
      return json({ ok: true, cotizacion: r.cotizacion }, 201);
    }
    const m = ruta.match(/^\/cotizaciones\/(\d+)$/);
    if (m && metodo === 'GET') {
      const c = await cotiz.conItems(env, Number(m[1]));
      return c ? json({ cotizacion: c }) : error('Esa cotización no existe', 404);
    }
    if (m && metodo === 'PATCH') {
      const r = await cotiz.editar(env, usuario, Number(m[1]), cuerpo);
      if (r.error) return error(r.error, r.status);
      return json({ ok: true });
    }
    return error('Ruta no encontrada', 404);
  }

  if (!puede(usuario, 'facturacion')) return error('Sin acceso a este módulo', 403);

  if (ruta === '/panel' && metodo === 'GET') {
    await ponerCiclosAlDia(env);
    return json(await panel(env));
  }

  // Instalaciones: el catálogo que alimenta los desplegables de toda la app.
  // Se edita acá para no tener que entrar a la base a corregir un nombre.
  if (ruta === '/instalaciones' && metodo === 'GET') {
    const [inst, servicios, extras] = await Promise.all([
      buscar(env, 'v_instalaciones?select=*&order=nombre.asc'),
      buscar(env, 'servicios?select=instalacion_id,activo'),
      buscar(env, 'extras?select=instalacion_id'),
    ]);
    const cuenta = (filas, campo) => {
      const m = new Map();
      for (const f of filas) m.set(f[campo], (m.get(f[campo]) || 0) + 1);
      return m;
    };
    const cs = cuenta(servicios, 'instalacion_id');
    const ce = cuenta(extras, 'instalacion_id');
    return json({
      instalaciones: inst.map((i) => ({
        ...i,
        servicios: cs.get(i.id) || 0,
        extras: ce.get(i.id) || 0,
      })),
    });
  }

  // Alta directa, sin pasar por un servicio: hay parques que se cargan antes
  // de tener nada contratado, para dejarlos listos.
  if (ruta === '/instalaciones' && metodo === 'POST') {
    const inst = await resolverInstalacion(env, usuario, cuerpo);
    if (inst.error) return error(inst.error, inst.status || 400);
    // Si ya existía se devuelve esa misma en vez de crear una repetida, pero
    // hay que decirlo: si no, quien la cargó cree que agregó una nueva.
    return json({ ok: true, id: inst.id, ya_existia: inst.ya_existia === true }, 201);
  }

  const mInst = ruta.match(/^\/instalaciones\/(\d+)$/);
  if (mInst && metodo === 'PATCH') {
    const id = Number(mInst[1]);
    const actual = await primero(env, `instalaciones?select=*&id=eq.${id}`);
    if (!actual) return error('Esa instalación no existe', 404);

    const campos = {};
    if ('nombre' in cuerpo) {
      const n = (cuerpo.nombre || '').trim();
      if (!n) return error('Falta el nombre de la instalación');
      if (n.length > 160) return error('El nombre de la instalación es demasiado largo');
      campos.nombre = n;
    }
    for (const k of ['comuna', 'region']) {
      if (k in cuerpo) campos[k] = (cuerpo[k] || '').trim() || null;
    }
    if ('activa' in cuerpo) campos.activa = !!cuerpo.activa;

    let cliente_id = actual.cliente_id;
    if ('cliente' in cuerpo && (cuerpo.cliente || '').trim()) {
      const cl = await resolverCliente(env, usuario, cuerpo.cliente);
      cliente_id = cl.id;
      if (cl.id !== actual.cliente_id) campos.cliente_id = cl.id;
    }

    // Dos instalaciones del mismo cliente no pueden llamarse igual: la base lo
    // rechazaría con un error ilegible, así que se avisa antes y con nombre.
    const nombreFinal = campos.nombre ?? actual.nombre;
    const choca = await primero(env,
      `instalaciones?select=id,nombre&cliente_id=eq.${cliente_id}&nombre=eq.${encodeURIComponent(nombreFinal)}&id=neq.${id}`);
    if (choca) {
      return error(`Ese cliente ya tiene una instalación llamada "${choca.nombre}". Use otro nombre o únalas a mano.`, 409);
    }

    if (!Object.keys(campos).length) return error('No hay nada que cambiar');

    await actualizar(env, `instalaciones?id=eq.${id}`, campos);
    await anotar(env, usuario.usuario, 'instalacion', id, 'editada',
                 Object.keys(campos).join(', '));
    return json({ ok: true });
  }

  // Los servicios continuos, con su instalación y en qué va cada uno.
  if (ruta === '/servicios' && metodo === 'GET') {
    const [servicios, ciclos] = await Promise.all([
      buscar(env, 'servicios?select=*,instalaciones(nombre,comuna,clientes(nombre))&order=activo.desc,nombre.asc'),
      buscar(env, 'ciclos?select=servicio_id,estado'),
    ]);
    const cuenta = new Map();
    for (const c of ciclos) {
      const n = cuenta.get(c.servicio_id) || { total: 0, cerrados: 0, abiertos: 0 };
      n.total += 1;
      if (c.estado === 'cerrado') n.cerrados += 1; else n.abiertos += 1;
      cuenta.set(c.servicio_id, n);
    }
    return json({
      servicios: servicios.map((s) => {
        const { instalaciones: i, ...resto } = s;
        const n = cuenta.get(s.id) || { total: 0, cerrados: 0, abiertos: 0 };
        return {
          ...resto,
          instalacion: i?.nombre || '—',
          comuna: i?.comuna || null,
          cliente: i?.clientes?.nombre || '—',
          periodos: n.total, periodos_cerrados: n.cerrados, periodos_abiertos: n.abiertos,
        };
      }),
    });
  }

  // Editar un servicio ya creado.
  const mServicio = ruta.match(/^\/servicios\/(\d+)$/);
  if (mServicio && metodo === 'PATCH') {
    const id = Number(mServicio[1]);
    const actual = await primero(env, `servicios?select=*&id=eq.${id}`);
    if (!actual) return error('Ese servicio no existe', 404);

    const campos = {};
    if ('nombre' in cuerpo) {
      const n = (cuerpo.nombre || '').trim();
      if (!n) return error('Falta el nombre del servicio');
      campos.nombre = n;
    }
    if ('dias_ciclo' in cuerpo) {
      const d = entero(cuerpo.dias_ciclo);
      if (d === null || d < 1 || d > 365) {
        return error('El ciclo debe ser un número de días entre 1 y 365');
      }
      campos.dias_ciclo = d;
    }
    if ('monto_neto' in cuerpo) {
      campos.monto_neto = cuerpo.monto_neto === '' || cuerpo.monto_neto === null
        ? null : entero(cuerpo.monto_neto);
      if (campos.monto_neto !== null && campos.monto_neto < 0) {
        return error('El monto no puede ser negativo');
      }
    }
    if ('activo' in cuerpo) campos.activo = !!cuerpo.activo;

    // La fecha de inicio solo se puede corregir mientras no haya periodos: con
    // periodos encima, moverla no los recalcula y dejaría el servicio diciendo
    // una cosa y su calendario otra.
    if ('fecha_inicio' in cuerpo && cuerpo.fecha_inicio !== actual.fecha_inicio) {
      if (!esFecha(cuerpo.fecha_inicio)) return error('La fecha de inicio no es válida');
      const ya = await primero(env, `ciclos?select=id&servicio_id=eq.${id}`);
      if (ya) {
        return error('Este servicio ya tiene periodos corriendo: la fecha de inicio no se puede mover sin rehacerlos. Dé de baja este servicio y cree uno nuevo con la fecha correcta.', 409);
      }
      campos.fecha_inicio = cuerpo.fecha_inicio;
    }

    if ('instalacion' in cuerpo || 'instalacion_id' in cuerpo) {
      const inst = await resolverInstalacion(env, usuario, cuerpo);
      if (inst.error) return error(inst.error, inst.status || 400);
      campos.instalacion_id = inst.id;

      // Si la instalación ya existía, resolverInstalacion devuelve la de antes
      // y no mira el cliente. Acá sí se corrige: el campo está en el formulario
      // de edición justamente para poder cambiarlo.
      const nombreCliente = (cuerpo.cliente || '').trim();
      if (nombreCliente) {
        const actualInst = await primero(env,
          `v_instalaciones?select=id,cliente&id=eq.${inst.id}`);
        if (actualInst && !mismoNombre(actualInst.cliente || '', nombreCliente)) {
          const cl = await resolverCliente(env, usuario, nombreCliente);
          await actualizar(env, `instalaciones?id=eq.${inst.id}`, { cliente_id: cl.id });
          await anotar(env, usuario.usuario, 'instalacion', inst.id, 'cambió de cliente',
                       `${actualInst.cliente} → ${cl.nombre}`);
        }
      }
    }

    if (!Object.keys(campos).length) return error('No hay nada que cambiar');

    await actualizar(env, `servicios?id=eq.${id}`, campos);
    await anotar(env, usuario.usuario, 'servicio', id, 'editado',
                 Object.keys(campos).join(', '));
    if (campos.activo !== false) await ponerCiclosAlDia(env);
    return json({ ok: true });
  }

  // Alta de un servicio continuo: acá se elige el día de inicio.
  if (ruta === '/servicios' && metodo === 'POST') {
    const { nombre, fecha_inicio, dias_ciclo, monto_neto } = cuerpo;
    if (!nombre?.trim()) return error('Falta el nombre del servicio');
    if (!esFecha(fecha_inicio)) return error('La fecha de inicio no es válida');

    // Ausente significa "el de siempre"; un valor presente se valida tal cual,
    // nunca se corrige en silencio.
    const vacio = dias_ciclo === undefined || dias_ciclo === null || dias_ciclo === '';
    const dias = vacio ? 30 : entero(dias_ciclo);
    if (dias === null || dias < 1 || dias > 365) {
      return error('El ciclo debe ser un número de días entre 1 y 365');
    }

    const inst = await resolverInstalacion(env, usuario, cuerpo);
    if (inst.error) return error(inst.error, inst.status || 400);

    const [creado] = await insertar(env, 'servicios', {
      instalacion_id: inst.id, nombre: nombre.trim(),
      fecha_inicio, dias_ciclo: dias, monto_neto: entero(monto_neto),
      creado_por: usuario.email,
    });

    await anotar(env, usuario.email, 'servicio', creado.id, 'creado',
                 `${creado.nombre} desde ${fecha_inicio}, ciclo de ${dias} días`);
    await ponerCiclosAlDia(env);
    return json({ ok: true, id: creado.id }, 201);
  }

  // Registrar la OC y el folio. Acá vive la máquina de estados.
  const mCiclo = ruta.match(/^\/ciclos\/(\d+)$/);
  if (mCiclo && metodo === 'PATCH') {
    const id = Number(mCiclo[1]);
    const actual = await primero(env, `ciclos?select=*&id=eq.${id}`);
    if (!actual) return error('Ese periodo no existe', 404);

    const campos = {};
    for (const k of ['oc_numero', 'oc_fecha', 'factura_folio', 'factura_fecha', 'notas',
                     'pago_fecha', 'factoring', 'pago_notas']) {
      if (k in cuerpo) campos[k] = cuerpo[k] === '' ? null : cuerpo[k];
    }
    if ('monto_neto' in cuerpo) campos.monto_neto = entero(cuerpo.monto_neto);
    if ('pago_monto' in cuerpo) {
      campos.pago_monto = cuerpo.pago_monto === '' ? null : entero(cuerpo.pago_monto);
      if (campos.pago_monto !== null && campos.pago_monto < 0) {
        return error('El monto recibido no puede ser negativo');
      }
    }

    for (const k of ['oc_fecha', 'factura_fecha', 'pago_fecha']) {
      if (campos[k] && !esFecha(campos[k])) {
        const cual = k === 'oc_fecha' ? 'la OC' : k === 'factura_fecha' ? 'la factura' : 'el pago';
        return error(`La fecha de ${cual} no es válida`);
      }
    }

    if ('pago_estado' in cuerpo) {
      if (!['por_cobrar', 'pagado', 'factorizado'].includes(cuerpo.pago_estado)) {
        return error('Ese estado de pago no existe');
      }
      campos.pago_estado = cuerpo.pago_estado;
      // No se cobra lo que no se ha facturado: así el panel no miente.
      const folio = 'factura_folio' in campos ? campos.factura_folio : actual.factura_folio;
      if (campos.pago_estado !== 'por_cobrar' && !folio) {
        return error('Primero registre el folio de la factura: no se puede marcar como pagado algo que no se ha facturado');
      }
      if (campos.pago_estado !== 'por_cobrar') {
        const fecha = 'pago_fecha' in campos ? campos.pago_fecha : actual.pago_fecha;
        if (!fecha) return error('Indique la fecha en que entró la plata');
      } else {
        // Volver a "por cobrar" limpia lo que ya no corresponde.
        campos.pago_fecha = null;
        campos.pago_monto = null;
        campos.factoring = null;
      }
      if (campos.pago_estado !== 'factorizado') campos.factoring = null;
    }

    const fin = { ...actual, ...campos };
    // Cerrado solo cuando están los tres datos: N° de OC, fecha de OC y folio.
    let estado;
    if (fin.factura_folio && fin.oc_numero && fin.oc_fecha) estado = 'cerrado';
    else if (fin.oc_numero && fin.oc_fecha)                 estado = 'pendiente_facturacion';
    else if (diasEntre(fin.hasta, hoyISO()) >= 0)           estado = 'solicitar_oc';
    else                                                    estado = 'en_curso';
    campos.estado = estado;
    campos.actualizado_en = new Date().toISOString();

    await actualizar(env, `ciclos?id=eq.${id}`, campos);
    await anotar(env, usuario.email, 'ciclo', id, `estado: ${actual.estado} → ${estado}`,
                 JSON.stringify(campos));
    return json({ ok: true, estado });
  }

  // Servicios extraordinarios.
  if (ruta === '/extras' && metodo === 'POST') {
    const { fecha, tarifa_id, cantidad, detalle } = cuerpo;
    if (!esFecha(fecha)) return error('La fecha no es válida');
    const cant = Number(cantidad);
    if (!Number.isFinite(cant) || cant <= 0) return error('La cantidad debe ser mayor que cero');

    // La instalación se escribe. Muchos extras ocurren en parques donde no hay
    // un servicio permanente, así que exigir que ya existiera dejaba fuera
    // justo los trabajos sueltos que hay que cobrar aparte.
    const inst = await resolverInstalacion(env, usuario, cuerpo);
    if (inst.error) return error(inst.error, inst.status || 400);

    // El ítem puede salir del tarifario o escribirse a mano, y el precio del
    // tarifario se puede ajustar: hay servicios que se negocian caso a caso y
    // antes había que elegir el ítem más parecido y aceptar un monto que no
    // era el real.
    let t = null;
    if (entero(tarifa_id)) {
      t = await primero(env, `tarifas?select=*&id=eq.${entero(tarifa_id)}`);
      if (!t) return error('Ese ítem del tarifario no existe');
    }

    const nombreItem = (cuerpo.item || '').trim() || (t ? t.nombre : '');
    if (!nombreItem) {
      return error('Escriba qué se hizo, o elija un ítem del tarifario');
    }
    if (nombreItem.length > 200) return error('La descripción del ítem es demasiado larga');

    // El ítem se escribe, así que puede venir sin id aunque sea uno del
    // tarifario. Se busca por nombre para no perder de dónde salió el precio.
    if (!t) {
      const tarifas = await buscar(env, 'tarifas?select=*&activo=is.true');
      t = tarifas.find((x) => mismoNombre(x.nombre, nombreItem)) || null;
    }

    // Vacío significa "el de lista"; un valor presente se usa tal cual, aunque
    // sea cero: un servicio de cortesía también hay que dejarlo escrito.
    const dioPrecio = cuerpo.precio_unitario !== undefined
                   && cuerpo.precio_unitario !== null
                   && cuerpo.precio_unitario !== '';
    let precio;
    if (dioPrecio) {
      precio = entero(cuerpo.precio_unitario);
      if (precio === null || precio < 0) return error('El precio no es válido');
    } else if (t) {
      precio = Number(t.precio);
    } else {
      return error('Falta el precio del ítem');
    }

    // El periodo ya no se elige: lo decide la fecha del servicio. Elegirlo a
    // mano era un paso que se olvidaba, y un extra sin periodo es exactamente
    // la plata que se escapaba sin facturar.
    const periodo = await cicloDeLaFecha(env, inst.id, fecha);

    const neto = Math.round(precio * cant);
    const [creado] = await insertar(env, 'extras', {
      instalacion_id: inst.id,
      ciclo_id: periodo && periodo.estado !== 'cerrado' ? periodo.id : null,
      fecha, tarifa_id: t ? t.id : null, item: nombreItem, cantidad: cant,
      precio_unitario: precio, monto_neto: neto,
      detalle: detalle?.trim() || null, creado_por: usuario.usuario,
    });

    // Que el precio no sea el de lista no es un error, pero tiene que quedar
    // dicho: es justo lo que alguien va a querer revisar en seis meses.
    const ajuste = t && precio !== Number(t.precio)
      ? ` · precio ajustado, el de lista era ${t.precio}`
      : t ? '' : ' · ítem fuera del tarifario';
    await anotar(env, usuario.usuario, 'extra', creado.id, 'registrado',
                 `${nombreItem} x${cant} a ${precio} = ${neto} el ${fecha}${ajuste}`);

    // Decir dónde quedó, siempre. Un extra que cae en un periodo ya facturado
    // o en una instalación sin servicio queda suelto a propósito, y quien lo
    // registró tiene que enterarse en el momento, no un mes después.
    let nota;
    if (!periodo) {
      nota = 'Queda sin asignar: esa instalación no tiene ningún periodo que cubra esa fecha. Aparece en el panel para cobrarlo aparte.';
    } else if (periodo.estado === 'cerrado') {
      nota = `El periodo N°${periodo.numero} de esa fecha ya está facturado, así que queda sin asignar para cobrarlo aparte.`;
    }
    return json({
      ok: true, id: creado.id, monto_neto: neto,
      periodo: periodo && periodo.estado !== 'cerrado'
        ? { numero: periodo.numero, desde: periodo.desde, hasta: periodo.hasta } : null,
      nota,
    }, 201);
  }

  // Asignar un extra suelto a un periodo, para que se cobre.
  const mExtra = ruta.match(/^\/extras\/(\d+)$/);
  if (mExtra && metodo === 'PATCH') {
    const id = Number(mExtra[1]);
    const ciclo_id = cuerpo.ciclo_id === null || cuerpo.ciclo_id === ''
      ? null : entero(cuerpo.ciclo_id);
    if (ciclo_id !== null) {
      const c = await primero(env, `ciclos?select=id&id=eq.${ciclo_id}`);
      if (!c) return error('Ese periodo no existe', 404);
    }
    const filas = await actualizar(env, `extras?id=eq.${id}`, { ciclo_id });
    if (!filas.length) return error('Ese servicio extra no existe', 404);
    await anotar(env, usuario.email, 'extra', id, 'asignado a periodo', String(ciclo_id));
    return json({ ok: true });
  }

  if (ruta === '/contactos' && metodo === 'GET') {
    return json({ contactos: await buscar(env,
      'contactos?select=*&order=creado_en.desc&limit=300') });
  }

  const mContacto = ruta.match(/^\/contactos\/(\d+)$/);
  if (mContacto && metodo === 'PATCH') {
    const id = Number(mContacto[1]);
    const campos = { atendido_por: usuario.usuario, atendido_en: new Date().toISOString() };
    if ('estado' in cuerpo) {
      if (!['nuevo','contactado','cotizado','cerrado','descartado'].includes(cuerpo.estado)) {
        return error('Ese estado no existe');
      }
      campos.estado = cuerpo.estado;
    }
    if ('notas' in cuerpo) campos.notas = (cuerpo.notas || '').trim() || null;
    const filas = await actualizar(env, `contactos?id=eq.${id}`, campos);
    if (!filas.length) return error('Ese contacto no existe', 404);
    await anotar(env, usuario.usuario, 'contacto', id, 'actualizado', campos.estado || null);
    return json({ ok: true });
  }

  // Agenda del mes: lo que pasa y lo que hay que hacer, en fechas.
  if (ruta === '/agenda' && metodo === 'GET') {
    const mes = url.searchParams.get('mes') || hoyISO().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return error('Ese mes no es válido');
    const primerDia = mes + '-01';
    const [a, m] = mes.split('-').map(Number);
    const ultimoDia = new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);

    const [ciclos, extras] = await Promise.all([
      // Un periodo entra en el mes si lo pisa, aunque empiece antes o termine
      // después: lo que interesa es qué está corriendo en esos días.
      buscar(env, `v_ciclos?select=*&desde=lte.${ultimoDia}&hasta=gte.${primerDia}`),
      buscar(env, `v_extras?select=*&fecha=gte.${primerDia}&fecha=lte.${ultimoDia}&order=fecha.asc`),
    ]);

    return json({
      mes, primer_dia: primerDia, ultimo_dia: ultimoDia, hoy: hoyISO(),
      ciclos: ciclos.map((c) => {
        const neto = Number(c.total_neto) || 0;
        return { ...c, total_neto: neto, iva: Math.round(neto * IVA),
                 total: neto + Math.round(neto * IVA) };
      }),
      extras,
    });
  }

  if (ruta === '/bitacora' && metodo === 'GET') {
    const bitacora = await buscar(env, 'bitacora?select=*&order=id.desc&limit=100');
    return json({ bitacora });
  }

  return error('Ruta no encontrada', 404);
}

/**
 * Dice qué tablas responden. No devuelve ningún dato: solo si cada una existe
 * y es accesible, para saber si falta correr una migración.
 */
async function revisarTablas(env) {
  const r = {};
  for (const t of ['usuarios', 'clientes', 'instalaciones', 'servicios', 'tarifas',
                   'ciclos', 'extras', 'bitacora', 'cotizaciones', 'cotizacion_items',
                   'contactos']) {
    try {
      await buscar(env, `${t}?select=count&limit=1`);
      r[t] = true;
    } catch {
      r[t] = false;
    }
  }
  // Columnas que llegaron después: si faltan, es que quedó una migración sin
  // correr y el sistema lo dice en vez de fallar en medio de un trámite.
  try {
    await buscar(env, 'ciclos?select=pago_estado&limit=1');
    r.ciclos_con_cobranza = true;
  } catch {
    r.ciclos_con_cobranza = false;
  }
  // No basta con que la columna exista: si el update no corrió, nadie tiene el
  // permiso y los botones quedan apagados para todos. Se informa cuántas
  // cuentas lo tienen, nunca cuáles: esta ruta es pública.
  try {
    const con = await buscar(env,
      'usuarios?select=usuario&puede_borrar=is.true&activo=is.true');
    r.permiso_de_borrar = true;
    r.cuentas_que_pueden_borrar = con.length;
  } catch {
    r.permiso_de_borrar = false;
  }
  return r;
}

// ---------------------------------------------------------------- entrada
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      // Contacto desde la web pública. Es la única ruta sin sesión que
      // escribe, así que valida con cuidado y recorta todo lo que entra.
      if (url.pathname === '/api/contacto') {
        const origen = request.headers.get('origin') || '';
        const permitidos = ['https://seggarridos.com', 'https://www.seggarridos.com',
                            'https://globseg-web.contacto-globseg.workers.dev'];
        // En desarrollo el Worker corre en localhost; ahí se acepta cualquier
        // origen local para poder probar el circuito completo. En producción
        // el servidor es adm.seggarridos.com y esta rama nunca se cumple.
        const enLocal = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
        const ok = permitidos.includes(origen) ||
                   (enLocal && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origen));
        const cors = {
          'access-control-allow-origin': ok ? origen : permitidos[0],
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        };
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (request.method !== 'POST') {
          return new Response(JSON.stringify({ error: 'Método no permitido' }),
            { status: 405, headers: { ...cors, 'content-type': 'application/json' } });
        }

        const d = await request.json().catch(() => ({}));
        const texto = (v, max) => {
          const t = typeof v === 'string' ? v.trim() : '';
          return t ? t.slice(0, max) : null;
        };
        const nombre = texto(d.Nombre ?? d.nombre, 120);
        const telefono = texto(d['Teléfono'] ?? d.telefono ?? d.fono, 40);
        if (!nombre) {
          return new Response(JSON.stringify({ error: 'Falta el nombre' }),
            { status: 400, headers: { ...cors, 'content-type': 'application/json' } });
        }
        if (!telefono && !texto(d.Correo ?? d.email, 120)) {
          return new Response(JSON.stringify({ error: 'Falta un teléfono o un correo' }),
            { status: 400, headers: { ...cors, 'content-type': 'application/json' } });
        }

        try {
          await insertar(env, 'contactos', {
            nombre,
            telefono,
            email: texto(d.Correo ?? d.email, 120),
            empresa: texto(d.Empresa ?? d.empresa, 160),
            comuna: texto(d.Comuna ?? d.comuna, 120),
            que_cuidar: texto(d['Qué hay que cuidar'] ?? d.lugar, 160),
            servicio: texto(d.Servicio ?? d.servicio, 120),
            turno: texto(d.Turno ?? d.turno, 60),
            detalle: texto(d.Detalle ?? d.detalle, 2000),
            origen: texto(d.Origen ?? d.origen, 120),
          });
        } catch (e) {
          console.error('contacto:', e.message);
          return new Response(JSON.stringify({ error: 'No se pudo guardar. Intente de nuevo.' }),
            { status: 502, headers: { ...cors, 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ ok: true }),
          { status: 201, headers: { ...cors, 'content-type': 'application/json' } });
      }

      // Revisa la configuración sin mostrar ningún valor: solo responde
      // sí o no sobre la forma de las claves. Sirve para no adivinar cuando
      // la conexión falla.
      if (url.pathname === '/api/diagnostico') {
        const k = (env.SUPABASE_SERVICE_KEY || '').trim();
        return json({
          url_configurada: !!env.SUPABASE_URL,
          clave_presente: k.length > 0,
          clave_es_la_secreta_nueva: k.startsWith('sb_secret_'),
          clave_es_la_antigua_jwt: k.startsWith('ey') && k.split('.').length === 3,
          clave_es_la_publica: k.startsWith('sb_publishable_'),
          clave_tiene_caracteres_raros: /[^\x21-\x7E]/.test(k),
          clave_parece_recortada: k.length > 0 && k.length < 30,
          secreto_de_sesion_configurado: !!env.SESION_SECRETO,
          tablas: await revisarTablas(env),
        });
      }

      // Ingreso y salida: son las únicas rutas sin sesión previa.
      if (url.pathname === '/api/sesion') {
        if (request.method === 'POST') {
          const datos = await request.json().catch(() => ({}));
          const r = await ingresar(env, datos.usuario, datos.clave);
          if (r.error) return error(r.error, r.status);
          const cookie = await crearSesion(r.usuario, env);
          const seguro = url.protocol === 'https:';
          await anotar(env, r.usuario.usuario, 'usuario', null, 'ingresó', null);
          return new Response(JSON.stringify({
            ok: true,
            usuario: { usuario: r.usuario.usuario, nombre: r.usuario.nombre,
                       rol: r.usuario.rol, debe_cambiar_clave: r.usuario.debe_cambiar_clave },
          }), {
            headers: { 'content-type': 'application/json; charset=utf-8',
                       'set-cookie': cookieSesion(cookie, 60 * 60 * 10, seguro),
                       'cache-control': 'no-store' },
          });
        }
        if (request.method === 'DELETE') {
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json; charset=utf-8',
                       'set-cookie': cookieBorrada(url.protocol === 'https:'),
                       'cache-control': 'no-store' },
          });
        }
      }

      const usuario = await identificar(request, env);
      if (!usuario) return error('Sin sesión', 401);
      return await api(request, env, url, usuario);
    } catch (e) {
      if (e instanceof ErrorDatos) {
        console.error('Supabase:', e.status, e.message, JSON.stringify(e.detalle));
        // 42501 es "permission denied" de Postgres. Como al rol público se le
        // quitó todo acceso a propósito, verlo acá significa casi siempre que
        // SUPABASE_SERVICE_KEY tiene la clave publishable en vez de la secreta.
        if (e.detalle?.code === '42501') {
          return error(
            'La clave de Supabase configurada no tiene permisos: parece ser la ' +
            'publishable en vez de la secreta. Revise SUPABASE_SERVICE_KEY.', 500);
        }
        return error('La base de datos rechazó la operación: ' + e.message, 502);
      }
      console.error(e);
      return error('Error inesperado: ' + e.message, 500);
    }
  },
};
