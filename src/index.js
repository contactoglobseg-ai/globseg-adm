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
import { ingresar, cambiarClave, crearSesion, leerSesion, cookieSesion, cookieBorrada,
         duracionSesion } from './sesion.js';
import { hoyISO, sumarDias, diasEntre, esFecha, periodoDe, fechasMovibles }
  from './fechas.js';
import * as cotiz from './cotizaciones.js';
import * as lote from './lote.js';
import * as asis from './asistencia.js';
import * as rrhh from './rrhh.js';
import * as carga from './carga.js';
import * as arch from './archivos.js';
import * as ing from './ingreso.js';
import * as docs from './documentos.js';
import { redireccionHttps, cabecerasSeguridad, conCabeceras, soloHttps }
  from './seguridad.js';
import { ipDe, huellaDe, revisarLimite, limpiarHuellas, MENSAJES as MENSAJES_LIMITE,
         revisarLimitePuerta, anotarIntento, limpiarIntentos,
         MENSAJES_PUERTA } from './limite.js';

const IVA = 0.19;

const PERMISOS = {
  gerencia:    ['facturacion', 'cotizaciones', 'personal', 'documentos', 'rrhh'],
  operaciones: ['facturacion', 'personal', 'documentos'],
  rrhh:        ['rrhh'],
  prevencion:  ['documentos'],
};

/**
 * Módulos dados a una persona en particular, además de los de su rol.
 *
 * Va por persona y no agregado al rol a propósito: si mañana entra otro
 * encargado de operaciones, no debería heredar el acceso a cotizaciones sin
 * que alguien lo decida.
 *
 * 14-10-2026: Joaquín cotiza, aunque su rol sea operaciones.
 */
const PERMISOS_PERSONA = {
  jgarridob: ['cotizaciones'],
};

// ---------------------------------------------------------------- utilidades
const json = (datos, status = 200) =>
  new Response(JSON.stringify(datos), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
               ...soloHttps() },
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
  const permisos = [...new Set([
    ...(PERMISOS[u.rol] || []),
    ...(PERMISOS_PERSONA[u.usuario] || []),
  ])];
  return { ...u, permisos };
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
    'servicios?select=id,fecha_inicio,dias_ciclo,ciclo_tipo,monto_neto&activo=is.true');

  const nuevos = [];
  const cierres = [];

  const correcciones = [];

  for (const s of servicios) {
    // Primero se enderezan los periodos ya grabados cuyas fechas no son las que
    // corresponden al ciclo. Los primeros servicios se cargaron sumando 30 días
    // y el día de cobro se fue atrasando; dejar eso esperando a que alguien
    // apriete un botón era pedirle a la oficina que arreglara un error del
    // sistema. Solo se tocan los que no tienen nada comprometido con el cliente.
    const suyos = await buscar(env,
      `ciclos?select=id,numero,desde,hasta,estado&servicio_id=eq.${s.id}&order=numero.asc`);
    for (const c of suyos) {
      if (!fechasMovibles(c.estado)) continue;
      const q = periodoDe(s, c.numero);
      if (c.desde === q.desde && c.hasta === q.hasta) continue;
      correcciones.push({ id: c.id, numero: c.numero, desde: q.desde, hasta: q.hasta,
                          antes: `${c.desde}→${c.hasta}` });
    }

    const ultimo = suyos.length ? suyos[suyos.length - 1] : null;

    if (ultimo && ultimo.estado === 'en_curso' && diasEntre(ultimo.hasta, hoy) >= 0) {
      cierres.push({ servicio_id: s.id, numero: ultimo.numero });
    }

    // Cada periodo se calcula desde la fecha de inicio por su número, no
    // encadenando desde el anterior. Encadenar hacía que un periodo mal
    // grabado arrastrara a todos los siguientes, y en el modo mensual
    // desalineaba el día de cobro.
    let numero = ultimo ? ultimo.numero : 0;
    const tope = numero + 500;   // freno ante una fecha de inicio absurda
    while (numero < tope) {
      const n = numero + 1;
      const { desde, hasta } = periodoDe(s, n);
      if (diasEntre(desde, hoy) < 0) break;   // ese periodo todavía no empieza
      nuevos.push({
        servicio_id: s.id, numero: n, desde, hasta,
        estado: diasEntre(hasta, hoy) >= 0 ? 'solicitar_oc' : 'en_curso',
        monto_neto: s.monto_neto ?? null,
      });
      numero = n;
    }
  }

  for (const c of correcciones) {
    await actualizar(env, `ciclos?id=eq.${c.id}`,
      { desde: c.desde, hasta: c.hasta, actualizado_en: new Date().toISOString() });
  }
  if (correcciones.length) {
    await anotar(env, 'sistema', 'ciclo', null, 'fechas enderezadas',
      `${correcciones.length} periodo${correcciones.length > 1 ? 's' : ''}: `
      + correcciones.slice(0, 12).map((c) => `N°${c.numero} ${c.antes} → ${c.desde}→${c.hasta}`).join('; '));
  }

  for (const c of cierres) {
    await actualizar(env, `ciclos?servicio_id=eq.${c.servicio_id}&numero=eq.${c.numero}`,
      { estado: 'solicitar_oc', actualizado_en: new Date().toISOString() });
  }
  if (nuevos.length) {
    await insertarSinDuplicar(env, 'ciclos', nuevos, 'servicio_id,numero');
  }
  return nuevos.length + cierres.length + correcciones.length;
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
  const [ciclos, sueltos, instalaciones] = await Promise.all([
    buscar(env, 'v_ciclos?select=*'),
    buscar(env, 'v_extras?select=*&ciclo_id=is.null&order=fecha.asc'),
    // v_ciclos trae el cliente; v_extras no, y el panel ahora filtra por
    // empresa. Se arma acá en vez de rehacer la vista: son unas pocas filas y
    // en este proyecto una migración no se aplica sola.
    buscar(env, 'v_instalaciones?select=id,cliente'),
  ]);

  const clienteDe = new Map(instalaciones.map((i) => [i.id, i.cliente]));
  for (const e of sueltos) e.cliente = clienteDe.get(e.instalacion_id) || '';

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

  // El resumen de las fichas se dejó de calcular acá: con una empresa elegida
  // tiene que cuadrar con las filas que se están viendo, y eso solo lo sabe la
  // pantalla. Escrito en las dos puntas, un día dirían cosas distintas, que es
  // justo lo que pasó con el subtotal de las cotizaciones. Lo hace
  // `resumirPanel()` en public/index.html, con los mismos datos de acá.
  return { hoy: hoyISO(), ciclos, extras_sueltos: sueltos };
}

// ---------------------------------------------------------------- API
async function api(request, env, url, usuario) {
  const ruta = url.pathname.replace(/^\/api/, '');
  const metodo = request.method;

  // La subida de un archivo manda bytes, no JSON. Leerla acá como JSON no
  // fallaría con ruido —el catch la deja en {}— pero sí dejaría el cuerpo
  // consumido, y más abajo el archivo llegaría vacío sin que nada lo diga.
  const esSubidaDeArchivo = metodo === 'POST'
    && /^\/rrhh\/documentos\/\d+\/archivo$/.test(ruta);

  const cuerpo = (metodo === 'POST' || metodo === 'PATCH') && !esSubidaDeArchivo
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

  // ---------------------------------------------------------- asistencia
  // La oficina crea trabajadores y lee el libro. No marca por nadie: la marca
  // la hace el guardia desde asistencia.seggarridos.com, y eso es justamente
  // lo que le da valor como respaldo. Lo único que puede escribir en el libro
  // es una corrección, firmada y con motivo, para cerrar una jornada que quedó
  // sin salida (ver corregirJornada en asistencia.js).
  if (ruta === '/trabajadores' || ruta.startsWith('/trabajadores/')
      || ruta === '/libro' || ruta.startsWith('/libro/')) {
    if (!puede(usuario, 'personal')) return error('Sin acceso a este módulo', 403);

    if (ruta === '/trabajadores' && metodo === 'GET') {
      return json({ trabajadores: await asis.listarTrabajadores(env) });
    }
    if (ruta === '/trabajadores' && metodo === 'POST') {
      const r = await asis.crearTrabajador(env, usuario.usuario, cuerpo);
      if (r.error) return error(r.error, r.status);
      return json({ ok: true, trabajador: r.trabajador }, 201);
    }
    const m = ruta.match(/^\/trabajadores\/(\d+)$/);
    if (m && metodo === 'PATCH') {
      const r = await asis.editarTrabajador(env, usuario.usuario, Number(m[1]), cuerpo);
      if (r.error) return error(r.error, r.status);
      return json({ ok: true, trabajador: r.trabajador });
    }

    if (ruta === '/libro' && metodo === 'GET') {
      const p = url.searchParams;
      const hasta = esFecha(p.get('hasta')) ? p.get('hasta') : asis.fechaChile();
      const desde = esFecha(p.get('desde')) ? p.get('desde') : sumarDias(hasta, -29);
      if (diasEntre(desde, hasta) < 0) return error('El desde es posterior al hasta', 400);
      if (diasEntre(desde, hasta) > 400) return error('El rango no puede pasar de un año', 400);
      return json(await asis.libro(env, {
        desde, hasta,
        trabajador_id: entero(p.get('trabajador')) || null,
        instalacion_id: entero(p.get('instalacion')) || null,
      }));
    }

    // Cerrar una jornada que quedó sin salida. No edita la marca del guardia:
    // agrega la salida que falta, firmada por quien la pone y con el motivo,
    // y el libro la muestra señalada.
    if (ruta === '/libro/corregir' && metodo === 'POST') {
      const r = await asis.corregirJornada(env, usuario.usuario, cuerpo);
      if (r.error) return error(r.error, r.status);
      return json({ ok: true, hora: r.hora, horas: r.horas, trabajador: r.trabajador }, 201);
    }
    return error('Ruta no encontrada', 404);
  }

  // ---------------------------------------------------------- recursos humanos
  //
  // Todo el módulo cuelga de `/rrhh` y de un solo permiso. Es el módulo con los
  // datos más sensibles del sistema —sueldos, salud, cuentas bancarias, RUT— y
  // por eso no comparte puerta con nada: quien tiene `facturacion` no entra acá,
  // y quien tiene `rrhh` no ve los cobros.
  if (ruta === '/rrhh' || ruta.startsWith('/rrhh/')) {
    if (!puede(usuario, 'rrhh')) return error('Sin acceso a este módulo', 403);
    const sub = ruta.replace(/^\/rrhh/, '') || '/';

    if (sub === '/panel' && metodo === 'GET') {
      // Las fichas que llegaron por enlace se agregan acá y no dentro de
      // `panelRrhh` para no hacer que rrhh.js y ingreso.js se importen el uno
      // al otro: ingreso.js ya usa `camposFicha` y `editarFicha`.
      const p = await rrhh.panelRrhh(env);
      p.fichas_por_revisar = await ing.porRevisar(env);
      return json(p);
    }

    // Todo lo que los formularios necesitan para armarse, en un viaje.
    if (sub === '/catalogos' && metodo === 'GET') {
      const [tipos, afps, instalaciones, params] = await Promise.all([
        buscar(env, 'tipos_documento?select=*&activo=is.true&order=orden.asc'),
        buscar(env, 'afps?select=*&activa=is.true&order=nombre.asc'),
        buscar(env, 'v_instalaciones?select=id,nombre,cliente&activa=is.true&order=nombre.asc'),
        rrhh.parametros(env),
      ]);
      return json({
        tipos_documento: tipos,
        afps,
        instalaciones,
        cargos: asis.CARGOS,
        tipos_contrato: rrhh.TIPOS_CONTRATO,
        jornadas: rrhh.JORNADAS,
        tipos_ausencia: rrhh.TIPOS_AUSENCIA,
        causales: rrhh.CAUSALES,
        plantillas: carga.plantillas(),
        por_tanda: carga.POR_TANDA,
        parametros: Object.values(params),
      });
    }

    // ------------------------------------------------------------ personal
    if (sub === '/personal' && metodo === 'GET') {
      const personal = await buscar(env, 'v_personal?select=*&order=activo.desc,nombre.asc');
      return json({ personal });
    }

    // Alta completa: crea a la persona —con su cuenta del libro de asistencia,
    // que es la misma de siempre— y de paso le llena la ficha de RRHH.
    if (sub === '/personal' && metodo === 'POST') {
      const r = await asis.crearTrabajador(env, usuario.usuario, cuerpo);
      if (r.error) return error(r.error, r.status);
      const ficha = rrhh.camposFicha(cuerpo);
      if (Object.keys(ficha).length) {
        await rrhh.editarFicha(env, usuario.usuario, r.trabajador.id, cuerpo);
      }
      return json({ ok: true, trabajador: r.trabajador }, 201);
    }

    let m = sub.match(/^\/personal\/(\d+)$/);
    if (m && metodo === 'GET') {
      const f = await rrhh.fichaCompleta(env, Number(m[1]));
      return f ? json(f) : error('Esa persona no está en el registro', 404);
    }
    if (m && metodo === 'PATCH') {
      // Lo que ya sabía manejar asistencia (baja, desbloqueo, clave) sigue ahí;
      // lo propio de RRHH va por su camino. Separarlos evita que un cambio de
      // ficha reactive sin querer una cuenta dada de baja.
      const id = Number(m[1]);
      const deAsistencia = ['activo', 'desbloquear', 'restablecer_clave', 'instalacion_id', 'cargo']
        .some((k) => k in cuerpo);
      if (deAsistencia) {
        const r = await asis.editarTrabajador(env, usuario.usuario, id, cuerpo);
        if (r.error) return error(r.error, r.status);
      }
      const ficha = rrhh.camposFicha(cuerpo);
      if (Object.keys(ficha).length) {
        const r = await rrhh.editarFicha(env, usuario.usuario, id, cuerpo);
        if (r.error) return error(r.error, r.status);
      } else if (!deAsistencia) {
        return error('No hay nada que cambiar', 400);
      }
      return json({ ok: true });
    }

    // ------------------------------------------------------------ contratos
    if (sub === '/contratos' && metodo === 'GET') {
      const p = url.searchParams;
      const filtros = ['select=*,trabajadores(nombre,rut,activo),instalaciones(nombre)'];
      if (entero(p.get('trabajador'))) filtros.push(`trabajador_id=eq.${entero(p.get('trabajador'))}`);
      if (p.get('estado')) filtros.push(`estado=eq.${encodeURIComponent(p.get('estado'))}`);
      filtros.push('order=fecha_inicio.desc');
      return json({ contratos: await buscar(env, `contratos?${filtros.join('&')}`) });
    }
    if (sub === '/contratos' && metodo === 'POST') {
      const r = await rrhh.crearContrato(env, usuario.usuario, cuerpo);
      if (r.error) return error(r.error, r.status);
      return json(r, 201);
    }
    m = sub.match(/^\/contratos\/(\d+)$/);
    if (m && metodo === 'PATCH') {
      const r = await rrhh.editarContrato(env, usuario.usuario, Number(m[1]), cuerpo);
      if (r.error) return error(r.error, r.status);
      return json(r);
    }

    // ------------------------------------------------- fichas de ingreso
    if (sub === '/fichas-ingreso' && metodo === 'GET') {
      return json(await ing.listarEnlaces(env));
    }
    if (sub === '/fichas-ingreso' && metodo === 'POST') {
      // El enlace sale apuntando al mismo lugar desde donde lo pidieron, así
      // no hay ningún dominio escrito a mano que se quede viejo. El Host lo
      // pone Cloudflare y en `wrangler dev` es el localhost.
      const hostPedido = (request.headers.get('host') || url.host).split(':')[0].toLowerCase();
      const esLocal = hostPedido === 'localhost' || hostPedido === '127.0.0.1';
      const base = `${esLocal ? 'http' : 'https'}://${request.headers.get('host') || url.host}`;
      const r = await ing.crearEnlace(env, usuario.usuario, cuerpo, base);
      if (r.error) return error(r.error, r.status);
      return json(r, 201);
    }
    m = sub.match(/^\/fichas-ingreso\/(\d+)$/);
    if (m && metodo === 'GET') {
      const r = await ing.detalleEnlace(env, Number(m[1]));
      if (r.error) return error(r.error, r.status);
      return json(r);
    }
    if (m && metodo === 'PATCH') {
      const r = await ing.anularEnlace(env, usuario.usuario, Number(m[1]), cuerpo.motivo);
      if (r.error) return error(r.error, r.status);
      return json(r);
    }
    m = sub.match(/^\/fichas-ingreso\/(\d+)\/aceptar$/);
    if (m && metodo === 'POST') {
      const r = await ing.aceptarFicha(env, usuario.usuario, Number(m[1]), cuerpo);
      if (r.error) return error(r.error, r.status);
      return json(r);
    }

    // ------------------------------------------------------------ documentos
    if (sub === '/documentos' && metodo === 'GET') {
      const p = url.searchParams;
      const filtros = ['select=*'];
      if (entero(p.get('trabajador'))) filtros.push(`trabajador_id=eq.${entero(p.get('trabajador'))}`);
      if (p.get('tipo')) filtros.push(`tipo=eq.${encodeURIComponent(p.get('tipo'))}`);
      if (p.get('grupo')) filtros.push(`tipo_grupo=eq.${encodeURIComponent(p.get('grupo'))}`);
      if (p.get('solo_activos') !== 'no') filtros.push('trabajador_activo=is.true');
      filtros.push('order=fecha_vencimiento.asc.nullslast');
      // `lista` y no `docs`: `docs` es el módulo de documentos generados, que se
      // importa arriba, y una variable local con ese nombre lo tapa.
      const lista = await buscar(env, `v_documentos?${filtros.join('&')}`);
      // El estado se filtra acá y no en la consulta porque lo calcula la vista
      // a partir de la fecha de hoy, y PostgREST no filtra por una expresión.
      const estado = p.get('estado');
      return json({ documentos: estado ? lista.filter((d) => d.estado === estado) : lista });
    }
    if (sub === '/documentos' && metodo === 'POST') {
      const r = await rrhh.crearDocumento(env, usuario.usuario, cuerpo);
      if (r.error) return error(r.error, r.status);
      return json(r, 201);
    }
    m = sub.match(/^\/documentos\/(\d+)$/);
    if (m && metodo === 'PATCH') {
      const r = await rrhh.editarDocumento(env, usuario.usuario, Number(m[1]), cuerpo);
      if (r.error) return error(r.error, r.status);
      return json(r);
    }

    // ------------------------------------------------------------ ausencias
    if (sub === '/ausencias' && metodo === 'GET') {
      const p = url.searchParams;
      const filtros = ['select=*,trabajadores(nombre,rut)'];
      if (entero(p.get('trabajador'))) filtros.push(`trabajador_id=eq.${entero(p.get('trabajador'))}`);
      if (p.get('tipo')) filtros.push(`tipo=eq.${encodeURIComponent(p.get('tipo'))}`);
      if (esFecha(p.get('desde'))) filtros.push(`hasta=gte.${p.get('desde')}`);
      if (esFecha(p.get('hasta'))) filtros.push(`desde=lte.${p.get('hasta')}`);
      filtros.push('order=desde.desc');
      return json({ ausencias: await buscar(env, `ausencias?${filtros.join('&')}`) });
    }
    if (sub === '/ausencias' && metodo === 'POST') {
      const r = await rrhh.crearAusencia(env, usuario.usuario, cuerpo);
      if (r.error) return error(r.error, r.status);
      return json(r, 201);
    }
    m = sub.match(/^\/ausencias\/(\d+)$/);
    if (m && metodo === 'PATCH') {
      const r = await rrhh.editarAusencia(env, usuario.usuario, Number(m[1]), cuerpo);
      if (r.error) return error(r.error, r.status);
      return json(r);
    }

    // ------------------------------------------------------------ parámetros
    if (sub === '/parametros' && metodo === 'GET') {
      const todos = await buscar(env, 'parametros_rrhh?select=*&order=codigo.asc,vigente_desde.desc');
      return json({ parametros: todos, vigentes: await rrhh.parametros(env) });
    }
    if (sub === '/parametros' && metodo === 'PATCH') {
      const r = await rrhh.editarParametro(env, usuario.usuario, cuerpo);
      if (r.error) return error(r.error, r.status);
      return json(r);
    }

    // ------------------------------------------------------ liquidación
    // Calcula y devuelve; no guarda nada. Es una estimación para saber, antes
    // de comprometer un turno o un sueldo, cuánto da y cuánto cuesta.
    if (sub === '/liquidacion' && metodo === 'POST') {
      const t = await primero(env, `trabajadores?select=*&id=eq.${entero(cuerpo.trabajador_id)}`);
      if (!t) return error('Esa persona no está en el registro', 404);
      const contrato = entero(cuerpo.contrato_id)
        ? await primero(env, `contratos?select=*&id=eq.${entero(cuerpo.contrato_id)}`)
        : await primero(env,
            `contratos?select=*&trabajador_id=eq.${t.id}&estado=eq.vigente&order=fecha_inicio.desc`);
      if (!contrato) return error('Esa persona no tiene contrato cargado', 409);

      const mes = /^\d{4}-\d{2}$/.test(cuerpo.mes || '') ? cuerpo.mes : hoyISO().slice(0, 7);
      const p = await rrhh.parametros(env, `${mes}-28`);
      const [afp, tramos] = await Promise.all([
        t.afp ? primero(env, `afps?select=*&nombre=eq.${encodeURIComponent(t.afp)}`) : null,
        buscar(env, 'tramos_impuesto?select=*&order=tramo.asc'),
      ]);
      // La UF y la UTM se pueden mandar en la llamada (para probar un mes
      // distinto) o salen de los parámetros, donde RRHH las carga cada mes.
      const uf = Number(cuerpo.uf) || rrhh.valor(p, 'uf', 0) || null;
      const utm = Number(cuerpo.utm) || rrhh.valor(p, 'utm', 0) || null;

      return json({
        mes,
        trabajador: { id: t.id, nombre: t.nombre, rut: t.rut, afp: t.afp,
                      salud_sistema: t.salud_sistema },
        contrato: { id: contrato.id, tipo: contrato.tipo, cargo: contrato.cargo },
        liquidacion: rrhh.liquidar({
          contrato, trabajador: t, p, afp, uf, utm,
          extra: { ...cuerpo.extra, tramos },
        }),
      });
    }

    // ------------------------------------------------------------ finiquito
    if (sub === '/finiquito' && metodo === 'POST') {
      const t = await primero(env, `trabajadores?select=*&id=eq.${entero(cuerpo.trabajador_id)}`);
      if (!t) return error('Esa persona no está en el registro', 404);
      const contrato = await primero(env,
        `contratos?select=*&trabajador_id=eq.${t.id}&order=fecha_inicio.desc`);
      if (!contrato) return error('Esa persona no tiene contrato cargado', 409);
      if (!rrhh.CAUSALES[cuerpo.causal]) return error('Falta la causal de término', 400);
      const fechaTermino = esFecha(cuerpo.fecha_termino) ? cuerpo.fecha_termino : hoyISO();

      const p = await rrhh.parametros(env, fechaTermino);
      const ausencias = await buscar(env,
        `ausencias?select=tipo,desde,dias_habiles,estado&trabajador_id=eq.${t.id}`);

      return json({
        trabajador: { id: t.id, nombre: t.nombre, rut: t.rut },
        finiquito: rrhh.calcularFiniquito({
          trabajador: t, contrato,
          causal: cuerpo.causal, fechaTermino,
          avisoDado: cuerpo.aviso_dado === true,
          baseManual: entero(cuerpo.base),
          saldo: rrhh.saldoFeriado(t, ausencias, fechaTermino),
          p, uf: Number(cuerpo.uf) || rrhh.valor(p, 'uf', 0) || null,
        }),
      });
    }

    // ------------------------------------------------------------ carga masiva

    // ------------------------------------------------- archivo de un documento
    //
    // El archivo entra y sale por acá, nunca por una URL de Storage: el bucket
    // es privado y la sesión se mira en cada pasada. Ver src/archivos.js.
    const mArchivo = sub.match(/^\/documentos\/(\d+)\/archivo$/);
    if (mArchivo) {
      const doc = await primero(env,
        `documentos_trabajador?select=*,trabajadores(nombre)&id=eq.${Number(mArchivo[1])}`);
      if (!doc) return error('Ese documento no existe', 404);
      const quien = doc.trabajadores?.nombre || '';

      if (metodo === 'GET') {
        if (!doc.archivo_ruta) return error('Ese documento no tiene archivo cargado', 404);
        const contenido = await arch.bajar(env, doc.archivo_ruta);
        return new Response(contenido, {
          headers: {
            // El tipo es el que dedujo el servidor al subirlo, nunca el que
            // dijo el navegador; con `nosniff`, el navegador tampoco adivina.
            'content-type': doc.archivo_tipo,
            'content-disposition': arch.comoAdjunto(doc.archivo_nombre),
            // CSP solo para las imágenes, no para los PDF.
            //
            // Lo que una política así evita es que un archivo que no sea lo
            // que creemos ejecute algo en nuestro dominio. Eso ya lo frena
            // `arch.reconocer()`, que mira los bytes y no lo que dijo el
            // navegador: lo que llega acá es un PDF o una imagen de verdad.
            //
            // Y en el PDF la política estorba: el visor de PDF del navegador
            // se monta con `object`/`embed`, y `default-src 'none'` los
            // bloquea, así que el gerente apretaría «Ver archivo» y vería una
            // página en blanco. Eso convierte la función en nada.
            //
            // En imagen no cuesta nada y se deja puesta.
            ...(doc.archivo_tipo === 'application/pdf'
              ? {}
              : { 'content-security-policy': "default-src 'none'" }),
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
            'cache-control': 'no-store, private',
            ...soloHttps(),
          },
        });
      }

      if (metodo === 'DELETE') {
        if (!doc.archivo_ruta) return error('Ese documento no tiene archivo cargado', 404);
        await arch.borrar(env, doc.archivo_ruta);
        await actualizar(env, `documentos_trabajador?id=eq.${doc.id}`, {
          archivo_ruta: null, archivo_nombre: null, archivo_tipo: null,
          archivo_bytes: null, archivo_subido_por: null, archivo_subido_en: null,
        });
        await anotar(env, usuario.usuario, 'documento_rrhh', doc.id,
          'quitó el archivo', `${quien} · ${doc.archivo_nombre}`);
        return json({ ok: true });
      }

      if (metodo === 'POST') {
        // El tamaño se mira antes de leer nada: un archivo de cien megas no
        // puede llegar a cargarse en memoria para después rechazarlo.
        const declarado = Number(request.headers.get('content-length') || 0);
        if (declarado > arch.MAX_BYTES) {
          return error(`El archivo pesa más de ${Math.round(arch.MAX_BYTES / 1048576)} MB. `
            + 'Si es una foto, sáquela de nuevo con menos resolución o conviértala a PDF.', 413);
        }

        const bytes = new Uint8Array(await request.arrayBuffer());
        if (!bytes.length) return error('No llegó ningún archivo', 400);
        if (bytes.length > arch.MAX_BYTES) {
          return error(`El archivo pesa más de ${Math.round(arch.MAX_BYTES / 1048576)} MB.`, 413);
        }

        // Lo que el archivo es de verdad, por sus primeros bytes. El
        // `content-type` que manda el navegador lo elige el cliente.
        const reconocido = arch.reconocer(bytes);
        if (!reconocido) {
          return error('Ese archivo no es un PDF ni una imagen (JPG, PNG, WebP o HEIC). '
            + 'Si es un Word o un Excel, guárdelo como PDF antes de subirlo.', 415);
        }

        const nombre = arch.nombreSeguro(
          decodeURIComponent(request.headers.get('x-archivo-nombre') || ''),
          reconocido.ext);
        const ruta = arch.rutaPara(doc.trabajador_id, doc.id, reconocido.ext);
        const anterior = doc.archivo_ruta;

        await arch.subir(env, ruta, bytes, reconocido.tipo);
        try {
          await actualizar(env, `documentos_trabajador?id=eq.${doc.id}`, {
            archivo_ruta: ruta,
            archivo_nombre: nombre,
            archivo_tipo: reconocido.tipo,
            archivo_bytes: bytes.length,
            archivo_subido_por: usuario.usuario,
            archivo_subido_en: new Date().toISOString(),
          });
        } catch (e) {
          // Si la fila no se pudo actualizar, el archivo que acaba de subir no
          // lo apunta nadie: se saca, o queda ocupando espacio para siempre.
          await arch.borrar(env, ruta).catch(() => {});
          throw e;
        }

        // El anterior se borra al final y aparte: si falla, el documento ya
        // quedó bien apuntado al nuevo y lo único que sobra es un archivo
        // suelto. Al revés —borrar primero— un error dejaría al documento sin
        // ninguno de los dos.
        if (anterior && anterior !== ruta) {
          await arch.borrar(env, anterior).catch(
            (e) => console.error('No se pudo borrar el archivo reemplazado:', e.message));
        }

        await anotar(env, usuario.usuario, 'documento_rrhh', doc.id,
          anterior ? 'reemplazó el archivo' : 'subió el archivo',
          `${quien} · ${nombre} (${bytes.length < 1024
            ? bytes.length + ' bytes' : Math.round(bytes.length / 1024) + ' KB'})`);
        return json({
          ok: true,
          archivo: { nombre, tipo: reconocido.tipo, bytes: bytes.length },
          reemplazo: !!anterior,
        }, 201);
      }
      return error('Ruta no encontrada', 404);
    }

    if (sub === '/carga' && metodo === 'POST') {
      const r = await carga.cargar(env, usuario.usuario, cuerpo);
      if (r.error) return error(r.error, r.status);
      return json(r);
    }

    return error('Ruta no encontrada', 404);
  }

  // ------------------------------------------ documentos desde plantilla
  //
  // La puerta es `documentos` **o** `rrhh`, y no uno solo, porque este módulo
  // lo usan dos áreas distintas: el prevencionista (que tiene `documentos` y
  // nada más) hace firmar entregas de EPP y charlas, y RRHH (que tiene `rrhh`
  // y nada más) emite los contratos. Pedir un solo permiso dejaría a una de
  // las dos afuera de su propio trabajo.
  //
  // Adentro hay una segunda puerta: una plantilla de clase `laboral` lleva el
  // sueldo y la cuenta bancaria escritos en el cuerpo, así que **exige `rrhh`**
  // aunque la cuenta haya entrado con `documentos`. Sin eso, operaciones vería
  // los sueldos al generar un contrato.
  if (ruta === '/documentos' || ruta.startsWith('/documentos/')) {
    if (!puede(usuario, 'documentos') && !puede(usuario, 'rrhh')) {
      return error('Sin acceso a este módulo', 403);
    }
    const sub = ruta.replace(/^\/documentos/, '') || '/';

    // Si la migración no corrió, se dice con el nombre del archivo y el resto
    // del sistema sigue andando. Nadie las aplica solo desde el 14-10-2026.
    if (!(await docs.tablasListas(env))) {
      return json({ sin_migracion: true, aviso: docs.avisoMigracion(),
                    migracion: docs.MIGRACION }, 503);
    }

    const puedeLaboral = puede(usuario, 'rrhh');

    if (sub === '/catalogos' && metodo === 'GET') {
      const c = await docs.catalogos(env);
      return json({
        ...c,
        // Las laborales se muestran igual, apagadas y con el motivo: esconder
        // una pantalla hace que la gente crea que el sistema no la tiene.
        puede_laboral: puedeLaboral,
        personas: puedeLaboral
          ? await buscar(env, 'v_personal?select=id,nombre,rut,cargo&activo=is.true&order=nombre.asc')
          : [],
      });
    }

    if (sub === '/' && metodo === 'GET') {
      return json({ documentos: await docs.listar(env, {
        trabajador_id: url.searchParams.get('trabajador_id'),
        estado: url.searchParams.get('estado'),
      }) });
    }

    // Vista previa: arma y devuelve, no escribe. La oficina tiene que poder
    // leer el contrato entero antes de congelarlo, porque después no se edita.
    if (sub === '/vista-previa' && metodo === 'POST') {
      const r = await docs.generar(env, usuario.usuario, cuerpo,
                                   { guardar: false, puedeLaboral });
      if (r.error) return error(r.error, r.status);
      return json(r);
    }

    if (sub === '/' && metodo === 'POST') {
      const r = await docs.generar(env, usuario.usuario, cuerpo,
                                   { guardar: true, puedeLaboral });
      // Un documento con campos en blanco vuelve con la vista previa adentro,
      // para que la pantalla pueda mostrar qué quedó sin llenar en vez de solo
      // decir que no se pudo.
      if (r.error) return json({ error: r.error, vista_previa: r.vista_previa }, r.status);
      return json(r, 201);
    }

    const mDoc = sub.match(/^\/(\d+)(\/[a-z]+)?$/);
    if (mDoc) {
      const id = Number(mDoc[1]);
      const accion = mDoc[2] || '';
      const d = await docs.ver(env, id);
      if (!d) return error('Ese documento no existe', 404);
      if (d.clase === 'laboral' && !puedeLaboral) {
        return error('Los documentos laborales los ve Recursos Humanos', 403);
      }

      if (!accion && metodo === 'GET') return json({ documento: d });

      // La firma de la empresa. Va con el nombre y el RUT del representante
      // legal, que salen de `datos_empresa`, y queda anotado qué cuenta la
      // puso: quien firma por la empresa la obliga, y eso tiene que tener
      // nombre. Ajustar quién puede hacerlo es parte de los permisos por
      // persona, que lleva otra sesión.
      if (accion === '/firma' && metodo === 'POST') {
        const empresa = await docs.catalogos(env);
        const dato = (c) => empresa.empresa.find((e) => e.codigo === c)?.valor || null;
        const r = await docs.firmar(env, request, id, {
          rol: 'empleador', origen: 'panel', quien: usuario.usuario,
          nombre: dato('representante'), rut: dato('representante_rut'),
        }, cuerpo);
        if (r.error) return error(r.error, r.status);
        return json(r, 201);
      }

      if (accion === '/anular' && metodo === 'POST') {
        const r = await docs.anular(env, usuario.usuario, id, cuerpo.motivo);
        if (r.error) return error(r.error, r.status);
        return json(r);
      }

      // Deja el documento firmado colgando de la ficha de la persona. El PDF
      // lo sube después la pantalla por /rrhh/documentos/:id/archivo, que ya
      // existe y ya revisa los bytes: no hay un segundo almacenamiento.
      if (accion === '/archivar' && metodo === 'POST') {
        const r = await docs.archivar(env, usuario.usuario, id);
        if (r.error) return error(r.error, r.status);
        return json(r, 201);
      }
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
    // Igual que el panel: entrar por acá también endereza lo que esté torcido,
    // así da lo mismo por qué pestaña se empiece.
    await ponerCiclosAlDia(env);
    const [servicios, ciclos] = await Promise.all([
      buscar(env, 'servicios?select=*,instalaciones(nombre,comuna,clientes(nombre))&order=activo.desc,nombre.asc'),
      buscar(env, 'ciclos?select=servicio_id,numero,estado,desde,hasta'),
    ]);
    const porServicio = new Map();
    for (const c of ciclos) {
      if (!porServicio.has(c.servicio_id)) porServicio.set(c.servicio_id, []);
      porServicio.get(c.servicio_id).push(c);
    }
    const cuenta = new Map();
    for (const s of servicios) {
      const suyos = porServicio.get(s.id) || [];
      const n = { total: suyos.length, cerrados: 0, abiertos: 0,
                  descuadrados: 0, congeladas: 0 };
      for (const c of suyos) {
        if (c.estado === 'cerrado') n.cerrados += 1; else n.abiertos += 1;
        // Periodos cuyas fechas no son las que corresponde al ciclo. Los que se
        // pueden mover ya los enderezó ponerCiclosAlDia; quedan contados los
        // que no, que son los que tienen OC o factura: el cliente tiene un
        // documento con esas fechas y el sistema no lo contradice solo.
        const esperado = periodoDe(s, c.numero);
        if (c.desde === esperado.desde && c.hasta === esperado.hasta) continue;
        if (fechasMovibles(c.estado)) n.descuadrados += 1; else n.congeladas += 1;
      }
      cuenta.set(s.id, n);
    }
    return json({
      servicios: servicios.map((s) => {
        const { instalaciones: i, ...resto } = s;
        const n = cuenta.get(s.id)
          || { total: 0, cerrados: 0, abiertos: 0, descuadrados: 0, congeladas: 0 };
        return {
          ...resto,
          instalacion: i?.nombre || '—',
          comuna: i?.comuna || null,
          cliente: i?.clientes?.nombre || '—',
          periodos: n.total, periodos_cerrados: n.cerrados, periodos_abiertos: n.abiertos,
          fechas_descuadradas: n.descuadrados, fechas_congeladas: n.congeladas,
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
    if ('ciclo_tipo' in cuerpo) {
      if (!['mensual', 'dias'].includes(cuerpo.ciclo_tipo)) {
        return error('Ese tipo de ciclo no existe');
      }
      campos.ciclo_tipo = cuerpo.ciclo_tipo;
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

    const tipo = cuerpo.ciclo_tipo === 'dias' ? 'dias' : 'mensual';

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
      fecha_inicio, ciclo_tipo: tipo, dias_ciclo: dias, monto_neto: entero(monto_neto),
      creado_por: usuario.usuario,
    });

    await anotar(env, usuario.usuario, 'servicio', creado.id, 'creado',
                 `${creado.nombre} desde ${fecha_inicio}, ${
                   tipo === 'mensual' ? 'cobro mensual el día ' + fecha_inicio.slice(8)
                                      : 'ciclo de ' + dias + ' días'}`);
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

    const [ciclos, extras, cPrim, cUlt, ePrim, eUlt] = await Promise.all([
      // Un periodo entra en el mes si lo pisa, aunque empiece antes o termine
      // después: lo que interesa es qué está corriendo en esos días.
      buscar(env, `v_ciclos?select=*&desde=lte.${ultimoDia}&hasta=gte.${primerDia}`),
      buscar(env, `v_extras?select=*&fecha=gte.${primerDia}&fecha=lte.${ultimoDia}&order=fecha.asc`),
      // Hasta dónde llega lo que hay cargado, para que el selector de año
      // ofrezca años con algo adentro y no una lista infinita.
      primero(env, 'ciclos?select=desde&order=desde.asc'),
      primero(env, 'ciclos?select=hasta&order=hasta.desc'),
      primero(env, 'extras?select=fecha&order=fecha.asc'),
      primero(env, 'extras?select=fecha&order=fecha.desc'),
    ]);

    const anios = [cPrim?.desde, cUlt?.hasta, ePrim?.fecha, eUlt?.fecha, hoyISO(), mes + '-01']
      .filter(Boolean).map((f) => Number(f.slice(0, 4)));

    return json({
      mes, primer_dia: primerDia, ultimo_dia: ultimoDia, hoy: hoyISO(),
      anio_desde: Math.min(...anios), anio_hasta: Math.max(...anios) + 1,
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
 * La API de asistencia.seggarridos.com.
 *
 * Va aparte de `api()` a propósito: la sesión del guardia es de otro ámbito y
 * ni siquiera busca en la tabla `usuarios`. Un guardia no puede llegar al
 * panel aunque alguien se equivoque mañana en un permiso, porque por este
 * camino el panel no existe.
 */
async function apiAsistencia(request, env, url) {
  const ruta = url.pathname.replace(/^\/api\/asistencia/, '') || '/';
  const metodo = request.method;
  const cuerpo = metodo === 'POST' ? await request.json().catch(() => ({})) : {};
  const seguro = url.protocol === 'https:';

  if (ruta === '/sesion' && metodo === 'POST') {
    const r = await asis.ingresoGuardia(env, cuerpo.usuario, cuerpo.clave);
    if (r.error) return error(r.error, r.status);
    const cookie = await crearSesion(r.usuario, env, 'asistencia');
    await anotar(env, r.usuario.usuario, 'trabajador', r.usuario.id, 'ingresó a asistencia', null);
    return new Response(JSON.stringify({ ok: true, nombre: r.usuario.nombre }), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': cookieSesion(cookie, duracionSesion('asistencia'), seguro, 'asistencia'),
        'cache-control': 'no-store', ...soloHttps(),
      },
    });
  }

  if (ruta === '/sesion' && metodo === 'DELETE') {
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': cookieBorrada(seguro, 'asistencia'),
        'cache-control': 'no-store', ...soloHttps(),
      },
    });
  }

  const nombre = await leerSesion(request, env, 'asistencia');
  if (!nombre) return error('Sin sesión', 401);
  const trabajador = await asis.trabajadorDeSesion(env, nombre);
  if (!trabajador) return error('Sin sesión', 401);   // dado de baja con la sesión abierta

  // Con la clave inicial sin cambiar, lo único permitido es cambiarla. El RUT
  // sirve para entregar la cuenta, no para quedarse: lo sabe cualquiera que
  // haya visto un contrato o una lista de turnos, y con él un compañero podría
  // marcarle la entrada al que todavía no llega.
  const debeCambiar = trabajador.debe_cambiar_clave === true;
  if (debeCambiar && ruta !== '/clave' && ruta !== '/yo') {
    return error('Tiene que cambiar su clave antes de marcar', 403);
  }

  if (ruta === '/yo' && metodo === 'GET') {
    if (debeCambiar) {
      return json({
        debe_cambiar_clave: true,
        trabajador: { nombre: trabajador.nombre, usuario: trabajador.usuario },
      });
    }
    return json(await asis.estadoGuardia(env, trabajador));
  }

  if (ruta === '/clave' && metodo === 'POST') {
    const r = await asis.cambiarClaveGuardia(env, trabajador, cuerpo.actual, cuerpo.nueva);
    if (r.error) return error(r.error, r.status);
    return json({ ok: true });
  }

  if (ruta === '/marca' && metodo === 'POST') {
    const r = await asis.marcar(env, trabajador, cuerpo);
    if (r.error) return error(r.error, r.status);
    return json({
      ok: true,
      tipo: r.marca.tipo,
      hora: r.hora ?? null,
      repetida: r.repetida === true,
      horas_turno: r.horas_turno ?? null,
      estado: await asis.estadoGuardia(env, trabajador),
    }, r.repetida ? 200 : 201);
  }

  // ------------------------------------------------ documentos por firmar
  //
  // Acá el guardia lee y firma sus contratos. Que esté detrás del mismo portón
  // que marcar turno no es casualidad: el bloqueo de más arriba impide usar
  // cualquier ruta mientras la cuenta siga con la clave inicial, y **eso es lo
  // que hace que esta firma valga algo**. Si el trabajador todavía anda con el
  // RUT de clave, la cuenta la podría estar usando un compañero, y una firma
  // puesta así no se podría defender ante nadie.
  //
  // Si la migración no corrió, se dice y el guardia sigue marcando turno igual:
  // marcar es lo que no puede fallar nunca.
  if (ruta === '/documentos' && metodo === 'GET') {
    if (!(await docs.tablasListas(env))) {
      return json({ documentos: [], sin_migracion: true, aviso: docs.avisoMigracion() });
    }
    return json({ documentos: await docs.porFirmarDe(env, trabajador.id) });
  }

  const mFirma = ruta.match(/^\/documentos\/(\d+)$/);
  if (mFirma && metodo === 'GET') {
    if (!(await docs.tablasListas(env))) return error(docs.avisoMigracion(), 503);
    const d = await docs.ver(env, Number(mFirma[1]));
    if (!d || d.trabajador_id !== trabajador.id) {
      return error('Ese documento no existe', 404);
    }
    // Se manda el cuerpo entero: lo que se firma es lo que se lee, y un
    // resumen o un enlace a «ver más» sería firmar lo que no se leyó.
    return json({
      documento: {
        id: d.id, numero: d.numero, titulo: d.titulo, cuerpo: d.cuerpo,
        estado: d.estado, por_confirmar: d.por_confirmar,
        creado_en: d.creado_en,
        firmas: d.firmas.map((f) => ({ rol: f.rol, nombre: f.nombre, firmado_en: f.firmado_en })),
      },
    });
  }

  const mPoner = ruta.match(/^\/documentos\/(\d+)\/firma$/);
  if (mPoner && metodo === 'POST') {
    if (!(await docs.tablasListas(env))) return error(docs.avisoMigracion(), 503);
    const r = await docs.firmar(env, request, Number(mPoner[1]), {
      rol: 'trabajador', origen: 'asistencia',
      quien: trabajador.usuario, trabajador,
    }, cuerpo);
    if (r.error) return error(r.error, r.status);
    return json(r, 201);
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
                   'contactos', 'trabajadores', 'marcas',
                   'contratos', 'documentos_trabajador', 'ausencias',
                   'tipos_documento', 'parametros_rrhh', 'afps', 'tramos_impuesto',
                   'plantillas_documento', 'bloques_plantilla', 'documentos_generados',
                   'firmas_documento', 'datos_empresa']) {
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
  try {
    await buscar(env, 'servicios?select=ciclo_tipo&limit=1');
    r.ciclo_mensual = true;
  } catch {
    r.ciclo_mensual = false;
  }
  try {
    await buscar(env, 'marcas?select=origen,registrada_por,motivo&limit=1');
    r.marcas_con_correccion = true;
  } catch {
    r.marcas_con_correccion = false;
  }
  try {
    await buscar(env, 'trabajadores?select=debe_cambiar_clave&limit=1');
    r.trabajador_cambia_clave = true;
  } catch {
    r.trabajador_cambia_clave = false;
  }
  // Sin esta columna el formulario público sigue recibiendo, pero sin tope.
  try {
    await buscar(env, 'contactos?select=ip_huella&limit=1');
    r.contacto_con_limite = true;
  } catch {
    r.contacto_con_limite = false;
  }
  // La ficha de RRHH son columnas agregadas a `trabajadores`: la tabla existe
  // igual, así que hay que preguntar por una columna para saber si la
  // migración entró.
  try {
    await buscar(env, 'trabajadores?select=fecha_ingreso,afp,salud_sistema&limit=1');
    r.ficha_rrhh = true;
  } catch {
    r.ficha_rrhh = false;
  }
  // El archivo de un documento necesita las dos cosas: las columnas en la
  // tabla y el bucket en Storage, que van en la misma migración pero por
  // caminos distintos. Si falta el bucket, subir falla y hay que mirar acá.
  try {
    await buscar(env, 'documentos_trabajador?select=archivo_ruta&limit=1');
    r.documentos_con_archivo = true;
  } catch {
    r.documentos_con_archivo = false;
  }
  r.bucket_documentos = await arch.bucketListo(env);
  // La calle de la instalación llegó con las plantillas de contrato: sin ella
  // el contrato sale diciendo la comuna pero no la dirección.
  try {
    await buscar(env, 'instalaciones?select=direccion&limit=1');
    r.instalaciones_con_direccion = true;
  } catch {
    r.instalaciones_con_direccion = false;
  }
  // La ficha de ingreso por enlace. Sin estas dos, el panel y el libro siguen
  // andando igual: lo que no existe es generar enlaces, y la pantalla lo dice
  // en vez de reventar.
  for (const t of ['fichas_ingreso', 'intentos_publicos']) {
    try {
      await buscar(env, `${t}?select=count&limit=1`);
      r[t] = true;
    } catch {
      r[t] = false;
    }
  }
  // Las vistas pueden faltar aunque las tablas estén: se crean al final de la
  // migración y son de las que la pantalla de RRHH consulta primero.
  for (const v of ['v_personal', 'v_documentos', 'v_documentos_generados']) {
    try {
      await buscar(env, `${v}?select=id&limit=1`);
      r[v] = true;
    } catch {
      r[v] = false;
    }
  }
  return r;
}

// ---------------------------------------------------------------- entrada
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Nada se contesta en claro. Tiene que ser lo primero: si la página de
    // ingreso llega a entregarse por http, la contraseña ya viaja a la vista.
    const aHttps = redireccionHttps(request, url);
    if (aHttps) return aHttps;

    if (!url.pathname.startsWith('/api/')) {
      // Un Worker, dos páginas. asistencia.seggarridos.com muestra el libro de
      // asistencia y adm.seggarridos.com el panel; comparten base de datos,
      // sesión y código, que es justamente lo que se quería evitar duplicar.
      // /asistencia sirve además para probar las dos en el mismo localhost.
      // El dominio se lee de la cabecera Host y no de url.hostname: en
      // `wrangler dev` la URL de la petición es siempre la de la dirección
      // local, así que mirar ahí hacía que el subdominio no se pudiera probar.
      const host = (request.headers.get('host') || url.hostname).split(':')[0].toLowerCase();
      const esAsistencia = host.split('.')[0] === 'asistencia';
      const pidePagina = url.pathname === '/' || !url.pathname.slice(1).includes('.');
      // Cuál de las tres páginas es, mirando la ruta y no solo el dominio: el
      // libro también se sirve en adm.seggarridos.com/asistencia, y si esto
      // mirara el dominio, por ese camino quedaría con geolocation=() y el
      // guardia no podría registrar dónde marcó.
      //
      // /ficha es la ficha de ingreso, la única página sin sesión. Se entrega
      // igual en los dos dominios: el enlace sale con el que esté usando la
      // oficina y no tiene por qué fallar si alguien lo arma con el otro.
      const cabeceras = cabecerasSeguridad(
        url.pathname === '/ficha' ? 'ficha'
        : esAsistencia || url.pathname === '/asistencia' ? 'asistencia'
        : 'panel');

      // Se pide sin la extensión: el servidor de archivos resuelve
      // /asistencia -> asistencia.html, y pedirlo con .html lo hace responder
      // un 307 a la dirección sin extensión en vez de la página.
      if (esAsistencia && pidePagina
          && url.pathname !== '/asistencia' && url.pathname !== '/ficha') {
        return conCabeceras(
          await env.ASSETS.fetch(new Request(new URL('/asistencia', url), request)), cabeceras);
      }
      return conCabeceras(await env.ASSETS.fetch(request), cabeceras);
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

        // Antes de leer el cuerpo: si este remitente ya se pasó, no hay para
        // qué parsear nada. El CORS de más arriba solo ordena a los
        // navegadores; lo que frena a un script es esto.
        const huella = await huellaDe(ipDe(request), env);
        // Si la revisión falla —la base no contesta, la migración todavía no
        // corrió—, el envío pasa. Lo que se protege es no perder un cliente:
        // negar un contacto bueno por eso sería causar el daño que el límite
        // existe para evitar.
        const limite = await revisarLimite(env, huella)
          .catch(e => { console.error('limite contacto:', e.message); return { ok: true }; });
        if (!limite.ok) {
          return new Response(JSON.stringify({ error: MENSAJES_LIMITE[limite.motivo] }), {
            status: 429,
            headers: { ...cors, 'content-type': 'application/json',
                       'retry-after': String(limite.segundos) },
          });
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

        const contacto = {
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
        };

        try {
          try {
            await insertar(env, 'contactos', { ...contacto, ip_huella: huella });
          } catch (e) {
            // La huella es para contar, no es parte del contacto. Si la
            // migración todavía no corrió en la base —ya pasó una vez con las
            // tablas de asistencia—, el contacto entra igual sin ella.
            if (!/ip_huella/.test(e.message || '')) throw e;
            console.error('contacto: falta la columna ip_huella, entra sin límite');
            await insertar(env, 'contactos', contacto);
          }
          // Después del bueno, no del rechazado: así la limpieza queda acotada
          // por el propio límite y un script no puede provocarla en serie.
          await limpiarHuellas(env)
            .catch(e => console.error('limpiar huellas:', e.message));
        } catch (e) {
          console.error('contacto:', e.message);
          return new Response(JSON.stringify({ error: 'No se pudo guardar. Intente de nuevo.' }),
            { status: 502, headers: { ...cors, 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ ok: true }),
          { status: 201, headers: { ...cors, 'content-type': 'application/json' } });
      }

      // La ficha de ingreso. Es la segunda ruta sin sesión que escribe —la
      // otra es el contacto de la web— y la única que toca la tabla de
      // personas, así que lleva lo mismo: tope por IP, validación estricta de
      // todo lo que llega, y un token inválido, vencido o ya usado que
      // contesta siempre lo mismo.
      //
      // No lleva CORS a propósito: la página que la usa la sirve este mismo
      // Worker, así que no hay nada legítimo llamándola desde otro origen.
      if (url.pathname.startsWith('/api/ficha/')) {
        if (request.method !== 'POST') return error('Método no permitido', 405);

        const huella = await huellaDe(ipDe(request), env);
        // Si la revisión del tope falla —la migración no corrió, la base no
        // contesta—, el intento pasa. Lo que protege esa puerta es el token,
        // que no se adivina; dejar afuera a quien empieza el lunes porque la
        // consulta del contador falló sería el daño que el tope evita.
        const limite = await revisarLimitePuerta(env, 'ficha', huella)
          .catch(e => { console.error('limite ficha:', e.message); return { ok: true }; });
        if (!limite.ok) {
          return new Response(JSON.stringify({ error: MENSAJES_PUERTA[limite.motivo] }), {
            status: 429,
            headers: { 'content-type': 'application/json; charset=utf-8',
                       'retry-after': String(limite.segundos),
                       'cache-control': 'no-store', ...soloHttps() },
          });
        }
        await anotarIntento(env, 'ficha', huella)
          .catch(e => console.error('anotar intento ficha:', e.message));

        const d = await request.json().catch(() => ({}));
        const token = typeof d.token === 'string' ? d.token : '';

        if (url.pathname === '/api/ficha/abrir') {
          const r = await ing.abrir(env, token);
          if (r.error) return error(r.error, r.status);
          return json(r);
        }
        if (url.pathname === '/api/ficha/enviar') {
          const r = await ing.recibir(env, token, d, huella);
          if (r.error) return error(r.error, r.status);
          // Después de una buena, nunca después de una rechazada: así la
          // limpieza queda acotada por el propio tope.
          await limpiarIntentos(env).catch(e => console.error('limpiar intentos:', e.message));
          return json(r);
        }
        return error('Ruta no encontrada', 404);
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
                       'cache-control': 'no-store', ...soloHttps() },
          });
        }
        if (request.method === 'DELETE') {
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json; charset=utf-8',
                       'set-cookie': cookieBorrada(url.protocol === 'https:'),
                       'cache-control': 'no-store', ...soloHttps() },
          });
        }
      }

      if (url.pathname.startsWith('/api/asistencia/')) {
        return await apiAsistencia(request, env, url);
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
      // Los de Storage ya vienen con el mensaje escrito para quien lo lee en
      // pantalla: dice qué se estaba haciendo y qué revisar.
      if (e instanceof arch.ErrorArchivo) {
        console.error('Storage:', e.status, e.message);
        return error(e.message, e.status || 502);
      }
      console.error(e);
      return error('Error inesperado: ' + e.message, 500);
    }
  },
};
