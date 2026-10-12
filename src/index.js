/**
 * Administración Seguridad Garridos — Worker
 *
 * Identidad: la entrega Cloudflare Access en la cabecera
 * Cf-Access-Authenticated-User-Email. Acá no se guardan ni se validan
 * contraseñas: si alguien llega sin esa cabecera en producción, no entra.
 * En desarrollo local se simula con la variable CORREO_DEV.
 */

const IVA = 0.19;

// Qué puede ver cada rol. El módulo de facturación lo ven gerencia y
// operaciones; el resto llega cuando existan sus módulos.
const PERMISOS = {
  gerencia:    ['facturacion', 'cotizaciones', 'personal', 'documentos', 'rrhh'],
  operaciones: ['facturacion', 'personal', 'documentos'],
  rrhh:        ['rrhh'],
  prevencion:  ['documentos'],
};

// ---------------------------------------------------------------- fechas
// Se trabaja con YYYY-MM-DD en aritmética simple, sin zonas horarias:
// un periodo de facturación es un día de calendario, no un instante.
const hoyISO = () => new Date().toISOString().slice(0, 10);

function sumarDias(iso, dias) {
  const [a, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(a, m - 1, d) + dias * 86400000;
  return new Date(t).toISOString().slice(0, 10);
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

async function anotar(env, quien, entidad, entidad_id, accion, detalle) {
  await env.DB.prepare(
    'INSERT INTO bitacora (quien, entidad, entidad_id, accion, detalle) VALUES (?,?,?,?,?)'
  ).bind(quien, entidad, entidad_id ?? null, accion, detalle ?? null).run();
}

const entero = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------- identidad
async function identificar(request, env) {
  const correo = request.headers.get('Cf-Access-Authenticated-User-Email') || env.CORREO_DEV;
  if (!correo) return null;
  const u = await env.DB.prepare(
    'SELECT email, nombre, rol FROM usuarios WHERE email = ? AND activo = 1'
  ).bind(correo.toLowerCase()).first();
  if (!u) return { email: correo, desconocido: true };
  return { ...u, permisos: PERMISOS[u.rol] || [] };
}

const puede = (usuario, modulo) => !!usuario?.permisos?.includes(modulo);

// ---------------------------------------------------------------- ciclos
/**
 * Mantiene al día los periodos de facturación:
 *  - crea el primero de cada servicio activo;
 *  - cuando un periodo termina, lo pasa a "solicitar_oc" y abre el siguiente.
 * Se ejecuta al entrar, así que no depende de ninguna tarea programada.
 */
async function ponerCiclosAlDia(env) {
  const hoy = hoyISO();
  const { results: servicios } = await env.DB.prepare(
    'SELECT id, fecha_inicio, dias_ciclo, monto_neto FROM servicios WHERE activo = 1'
  ).all();

  const ordenes = [];
  for (const s of servicios) {
    const ultimo = await env.DB.prepare(
      'SELECT numero, hasta, estado FROM ciclos WHERE servicio_id = ? ORDER BY numero DESC LIMIT 1'
    ).bind(s.id).first();

    // Un periodo ya terminado que seguía "en_curso" pasa a pedir OC.
    if (ultimo && ultimo.estado === 'en_curso' && diasEntre(ultimo.hasta, hoy) >= 0) {
      ordenes.push(
        env.DB.prepare(
          "UPDATE ciclos SET estado = 'solicitar_oc', actualizado_en = datetime('now') WHERE servicio_id = ? AND numero = ?"
        ).bind(s.id, ultimo.numero)
      );
    }

    let numero = ultimo ? ultimo.numero : 0;
    let desde  = ultimo ? sumarDias(ultimo.hasta, 1) : s.fecha_inicio;

    // Un servicio dado de alta con fecha retroactiva puede deber varios
    // periodos: se generan todos en esta misma pasada.
    const tope = numero + 500;   // freno ante una fecha de inicio absurda
    while (diasEntre(desde, hoy) >= 0 && numero < tope) {
      numero += 1;
      const hasta = sumarDias(desde, s.dias_ciclo - 1);
      ordenes.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO ciclos (servicio_id, numero, desde, hasta, estado, monto_neto)
           VALUES (?,?,?,?,?,?)`
        ).bind(s.id, numero, desde, hasta,
               diasEntre(hasta, hoy) >= 0 ? 'solicitar_oc' : 'en_curso',
               s.monto_neto ?? null)
      );
      desde = sumarDias(hasta, 1);
    }
  }
  if (ordenes.length) await env.DB.batch(ordenes);
  return ordenes.length;
}

// ---------------------------------------------------------------- consultas
async function panel(env) {
  const hoy = hoyISO();

  const { results: ciclos } = await env.DB.prepare(`
    SELECT c.*, s.nombre AS servicio, i.nombre AS instalacion, i.comuna,
           cl.nombre AS cliente,
           (SELECT COALESCE(SUM(e.monto_neto),0) FROM extras e WHERE e.ciclo_id = c.id) AS extras_neto,
           (SELECT COUNT(*) FROM extras e WHERE e.ciclo_id = c.id) AS extras_n
      FROM ciclos c
      JOIN servicios s     ON s.id = c.servicio_id
      JOIN instalaciones i ON i.id = s.instalacion_id
      JOIN clientes cl     ON cl.id = i.cliente_id
     ORDER BY CASE c.estado
                WHEN 'solicitar_oc' THEN 1
                WHEN 'pendiente_facturacion' THEN 2
                WHEN 'en_curso' THEN 3
                ELSE 4 END,
              c.hasta ASC`).all();

  for (const c of ciclos) {
    c.total_neto = (c.monto_neto || 0) + (c.extras_neto || 0);
    c.iva = Math.round(c.total_neto * IVA);
    c.total = c.total_neto + c.iva;
    c.dias_desde_cierre = diasEntre(c.hasta, hoy);
  }

  // Extras que no están asignados a ningún periodo: la fuga que motivó esto.
  const { results: sueltos } = await env.DB.prepare(`
    SELECT e.*, i.nombre AS instalacion
      FROM extras e
      JOIN instalaciones i ON i.id = e.instalacion_id
     WHERE e.ciclo_id IS NULL
     ORDER BY e.fecha ASC`).all();

  const suma = (lista) => lista.reduce((t, c) => t + (c.total_neto || 0), 0);
  return {
    hoy,
    ciclos,
    extras_sueltos: sueltos,
    resumen: {
      solicitar_oc:          ciclos.filter((c) => c.estado === 'solicitar_oc').length,
      pendiente_facturacion: ciclos.filter((c) => c.estado === 'pendiente_facturacion').length,
      en_curso:              ciclos.filter((c) => c.estado === 'en_curso').length,
      neto_por_cobrar:       suma(ciclos.filter((c) => c.estado !== 'cerrado')),
      extras_sin_asignar:    sueltos.length,
      neto_extras_sueltos:   sueltos.reduce((t, e) => t + (e.monto_neto || 0), 0),
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

  if (ruta === '/yo') return json({ usuario });

  if (!puede(usuario, 'facturacion')) return error('Sin acceso a este módulo', 403);

  if (ruta === '/panel' && metodo === 'GET') {
    await ponerCiclosAlDia(env);
    return json(await panel(env));
  }

  if (ruta === '/catalogos' && metodo === 'GET') {
    const [tarifas, instalaciones] = await Promise.all([
      env.DB.prepare('SELECT * FROM tarifas WHERE activo = 1 ORDER BY grupo, precio').all(),
      env.DB.prepare(`SELECT i.id, i.nombre, i.comuna, cl.nombre AS cliente
                        FROM instalaciones i JOIN clientes cl ON cl.id = i.cliente_id
                       WHERE i.activa = 1 ORDER BY i.nombre`).all(),
    ]);
    return json({ tarifas: tarifas.results, instalaciones: instalaciones.results });
  }

  // Alta de un servicio continuo: acá se elige el día de inicio.
  if (ruta === '/servicios' && metodo === 'POST') {
    const { instalacion_id, nombre, fecha_inicio, dias_ciclo, monto_neto } = cuerpo;
    if (!entero(instalacion_id)) return error('Falta la instalación');
    if (!nombre?.trim()) return error('Falta el nombre del servicio');
    if (!esFecha(fecha_inicio)) return error('La fecha de inicio no es válida');
    // Ausente significa "el de siempre"; un valor presente se valida tal cual,
    // nunca se corrige en silencio.
    const vacio = dias_ciclo === undefined || dias_ciclo === null || dias_ciclo === '';
    const dias = vacio ? 30 : entero(dias_ciclo);
    if (dias === null || dias < 1 || dias > 365) {
      return error('El ciclo debe ser un número de días entre 1 y 365');
    }

    const r = await env.DB.prepare(
      `INSERT INTO servicios (instalacion_id, nombre, fecha_inicio, dias_ciclo, monto_neto, creado_por)
       VALUES (?,?,?,?,?,?)`
    ).bind(entero(instalacion_id), nombre.trim(), fecha_inicio, dias,
           entero(monto_neto), usuario.email).run();

    await anotar(env, usuario.email, 'servicio', r.meta.last_row_id, 'creado',
                 `${nombre.trim()} desde ${fecha_inicio}, ciclo de ${dias} días`);
    await ponerCiclosAlDia(env);
    return json({ ok: true, id: r.meta.last_row_id }, 201);
  }

  // Registrar la OC y el folio. Acá vive la máquina de estados.
  const mCiclo = ruta.match(/^\/ciclos\/(\d+)$/);
  if (mCiclo && metodo === 'PATCH') {
    const id = Number(mCiclo[1]);
    const actual = await env.DB.prepare('SELECT * FROM ciclos WHERE id = ?').bind(id).first();
    if (!actual) return error('Ese periodo no existe', 404);

    const campos = {};
    for (const k of ['oc_numero', 'oc_fecha', 'factura_folio', 'factura_fecha', 'notas']) {
      if (k in cuerpo) campos[k] = cuerpo[k] === '' ? null : cuerpo[k];
    }
    if ('monto_neto' in cuerpo) campos.monto_neto = entero(cuerpo.monto_neto);

    for (const k of ['oc_fecha', 'factura_fecha']) {
      if (campos[k] && !esFecha(campos[k])) return error(`La fecha de ${k.split('_')[0]} no es válida`);
    }

    const fin = { ...actual, ...campos };
    // Cerrado solo cuando están los tres datos que pediste.
    let estado;
    if (fin.factura_folio && fin.oc_numero && fin.oc_fecha) estado = 'cerrado';
    else if (fin.oc_numero && fin.oc_fecha)                 estado = 'pendiente_facturacion';
    else if (diasEntre(fin.hasta, hoyISO()) >= 0)           estado = 'solicitar_oc';
    else                                                    estado = 'en_curso';
    campos.estado = estado;

    const llaves = Object.keys(campos);
    await env.DB.prepare(
      `UPDATE ciclos SET ${llaves.map((k) => `${k} = ?`).join(', ')}, actualizado_en = datetime('now')
        WHERE id = ?`
    ).bind(...llaves.map((k) => campos[k]), id).run();

    await anotar(env, usuario.email, 'ciclo', id, `estado: ${actual.estado} → ${estado}`,
                 JSON.stringify(campos));
    return json({ ok: true, estado });
  }

  // Servicios extraordinarios.
  if (ruta === '/extras' && metodo === 'POST') {
    const { instalacion_id, fecha, tarifa_id, cantidad, detalle, ciclo_id } = cuerpo;
    if (!entero(instalacion_id)) return error('Falta la instalación');
    if (!esFecha(fecha)) return error('La fecha no es válida');
    const cant = Number(cantidad);
    if (!Number.isFinite(cant) || cant <= 0) return error('La cantidad debe ser mayor que cero');

    const t = await env.DB.prepare('SELECT * FROM tarifas WHERE id = ?').bind(entero(tarifa_id)).first();
    if (!t) return error('Ese ítem del tarifario no existe');

    const neto = Math.round(t.precio * cant);
    const r = await env.DB.prepare(
      `INSERT INTO extras (instalacion_id, ciclo_id, fecha, tarifa_id, item, cantidad,
                           precio_unitario, monto_neto, detalle, creado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(entero(instalacion_id), entero(ciclo_id), fecha, t.id, t.nombre, cant,
           t.precio, neto, detalle?.trim() || null, usuario.email).run();

    await anotar(env, usuario.email, 'extra', r.meta.last_row_id, 'registrado',
                 `${t.nombre} x${cant} = ${neto} el ${fecha}`);
    return json({ ok: true, id: r.meta.last_row_id, monto_neto: neto }, 201);
  }

  // Asignar un extra suelto a un periodo, para que se cobre.
  const mExtra = ruta.match(/^\/extras\/(\d+)$/);
  if (mExtra && metodo === 'PATCH') {
    const id = Number(mExtra[1]);
    const ciclo_id = cuerpo.ciclo_id === null ? null : entero(cuerpo.ciclo_id);
    if (ciclo_id !== null) {
      const c = await env.DB.prepare('SELECT id FROM ciclos WHERE id = ?').bind(ciclo_id).first();
      if (!c) return error('Ese periodo no existe', 404);
    }
    await env.DB.prepare('UPDATE extras SET ciclo_id = ? WHERE id = ?').bind(ciclo_id, id).run();
    await anotar(env, usuario.email, 'extra', id, 'asignado a periodo', String(ciclo_id));
    return json({ ok: true });
  }

  if (ruta === '/bitacora' && metodo === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM bitacora ORDER BY id DESC LIMIT 100'
    ).all();
    return json({ bitacora: results });
  }

  return error('Ruta no encontrada', 404);
}

// ---------------------------------------------------------------- entrada
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    let usuario;
    try {
      usuario = await identificar(request, env);
    } catch (e) {
      return error('La base de datos no respondió: ' + e.message, 500);
    }

    if (!usuario) return error('Sin sesión. Entre por la dirección de administración.', 401);
    if (usuario.desconocido) {
      return error(`El correo ${usuario.email} no está habilitado en el sistema.`, 403);
    }

    try {
      return await api(request, env, url, usuario);
    } catch (e) {
      return error('Error inesperado: ' + e.message, 500);
    }
  },
};
