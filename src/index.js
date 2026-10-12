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
});

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
  return {
    hoy: hoyISO(),
    ciclos,
    extras_sueltos: sueltos,
    resumen: {
      solicitar_oc:          ciclos.filter((c) => c.estado === 'solicitar_oc').length,
      pendiente_facturacion: ciclos.filter((c) => c.estado === 'pendiente_facturacion').length,
      en_curso:              ciclos.filter((c) => c.estado === 'en_curso').length,
      neto_por_cobrar:       abiertos.reduce((t, c) => t + c.total_neto, 0),
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

  if (ruta === '/yo') return json({ usuario: sinClave(usuario) });

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

    const inst = await primero(env, `instalaciones?select=id&id=eq.${entero(instalacion_id)}`);
    if (!inst) return error('Esa instalación no existe');

    const [creado] = await insertar(env, 'servicios', {
      instalacion_id: entero(instalacion_id), nombre: nombre.trim(),
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
    for (const k of ['oc_numero', 'oc_fecha', 'factura_folio', 'factura_fecha', 'notas']) {
      if (k in cuerpo) campos[k] = cuerpo[k] === '' ? null : cuerpo[k];
    }
    if ('monto_neto' in cuerpo) campos.monto_neto = entero(cuerpo.monto_neto);

    for (const k of ['oc_fecha', 'factura_fecha']) {
      if (campos[k] && !esFecha(campos[k])) {
        return error(`La fecha de ${k.startsWith('oc') ? 'la OC' : 'la factura'} no es válida`);
      }
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
    const { instalacion_id, fecha, tarifa_id, cantidad, detalle, ciclo_id } = cuerpo;
    if (!entero(instalacion_id)) return error('Falta la instalación');
    if (!esFecha(fecha)) return error('La fecha no es válida');
    const cant = Number(cantidad);
    if (!Number.isFinite(cant) || cant <= 0) return error('La cantidad debe ser mayor que cero');

    const inst = await primero(env, `instalaciones?select=id&id=eq.${entero(instalacion_id)}`);
    if (!inst) return error('Esa instalación no existe');

    const t = await primero(env, `tarifas?select=*&id=eq.${entero(tarifa_id)}`);
    if (!t) return error('Ese ítem del tarifario no existe');

    const neto = Math.round(Number(t.precio) * cant);
    const [creado] = await insertar(env, 'extras', {
      instalacion_id: entero(instalacion_id),
      ciclo_id: ciclo_id ? entero(ciclo_id) : null,
      fecha, tarifa_id: t.id, item: t.nombre, cantidad: cant,
      precio_unitario: t.precio, monto_neto: neto,
      detalle: detalle?.trim() || null, creado_por: usuario.email,
    });

    await anotar(env, usuario.email, 'extra', creado.id, 'registrado',
                 `${t.nombre} x${cant} = ${neto} el ${fecha}`);
    return json({ ok: true, id: creado.id, monto_neto: neto }, 201);
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

  if (ruta === '/bitacora' && metodo === 'GET') {
    const bitacora = await buscar(env, 'bitacora?select=*&order=id.desc&limit=100');
    return json({ bitacora });
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

    try {
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
