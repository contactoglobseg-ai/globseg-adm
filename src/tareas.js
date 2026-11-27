/**
 * Tareas entre las cuentas de la oficina (27-11-2026).
 *
 * Una cuenta le pide algo a otra: «para quién», «qué», prioridad, para
 * cuándo, un detalle y, si sirve, una foto o un PDF. A quien se la piden le
 * queda en «Mis tareas» de su portada y le llega un correo. La cierra como
 * hecha (con una nota), o la devuelve si no le corresponde; quien la pidió
 * puede anularla mientras esté pendiente. Los dos pueden comentar adentro.
 *
 * Reglas:
 * · La ven SOLO quien la pidió y a quien se la pidieron. Todas las rutas
 *   buscan la tarea y miran eso antes de hacer nada; el id que viene en la
 *   ruta no alcanza.
 * · Se pide a cuentas activas de oficina (`usuarios`), por su usuario.
 * · El correo avisa pero no manda: si Resend falla, la tarea queda creada
 *   igual y se dice que el aviso no salió.
 */

import { buscar, primero, insertar, actualizar, anotar } from './datos.js';
import * as arch from './archivos.js';
import { mandarCorreo } from './alertas.js';

const PRIORIDADES = ['normal', 'urgente'];
const TIPOS_ADJUNTO = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];

const limpio = (v, max) => {
  const t = typeof v === 'string' ? v.trim().replace(/[ \t]+/g, ' ') : '';
  return t ? t.slice(0, max) : null;
};
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Las cuentas de oficina a las que se les puede pedir algo. Sin correos: la pantalla no los necesita. */
export async function personas(env) {
  const filas = await buscar(env, 'usuarios?select=usuario,nombre,rol&activo=is.true&usuario=not.is.null&order=nombre.asc');
  return filas.map((u) => ({ usuario: u.usuario, nombre: u.nombre, rol: u.rol }));
}

async function cuenta(env, usuario) {
  return primero(env, `usuarios?select=usuario,nombre,email,activo&usuario=eq.${encodeURIComponent(usuario)}`);
}

/** La tarea, solo si `quien` la pidió o se la pidieron. Si no, null. */
async function tareaDe(env, id, quien) {
  const t = await primero(env, `tareas?select=*&id=eq.${Math.round(Number(id)) || 0}`);
  if (!t || (t.para_usuario !== quien && t.pedida_por !== quien)) return null;
  return t;
}

const sinRuta = ({ archivo_ruta, ...t }) => ({ ...t, tiene_archivo: !!archivo_ruta });

/** Lo de la portada y la pantalla de tareas: para mí, lo que pedí, y los nombres. */
export async function listar(env, quien) {
  const q = encodeURIComponent(quien);
  const [paraMi, pedidas, gente] = await Promise.all([
    buscar(env, `tareas?select=*&para_usuario=eq.${q}&order=creado_en.desc&limit=200`),
    buscar(env, `tareas?select=*&pedida_por=eq.${q}&order=creado_en.desc&limit=200`),
    personas(env),
  ]);
  const ids = [...new Set([...paraMi, ...pedidas].map((t) => t.id))];
  const cuentas = ids.length
    ? await buscar(env, `tareas_comentarios?select=tarea_id&tarea_id=in.(${ids.join(',')})`)
    : [];
  const nCom = new Map();
  for (const c of cuentas) nCom.set(c.tarea_id, (nCom.get(c.tarea_id) || 0) + 1);
  const con = (t) => ({ ...sinRuta(t), comentarios: nCom.get(t.id) || 0 });
  return { para_mi: paraMi.map(con), pedidas: pedidas.map(con), personas: gente };
}

export async function ver(env, id, quien) {
  const t = await tareaDe(env, id, quien);
  if (!t) return { error: 'Esa tarea no existe o no es suya', status: 404 };
  const comentarios = await buscar(env,
    `tareas_comentarios?select=id,autor,texto,creado_en&tarea_id=eq.${t.id}&order=creado_en.asc`);
  return { tarea: sinRuta(t), comentarios };
}

function correoNueva(t, de, url) {
  const asunto = `${t.prioridad === 'urgente' ? '[URGENTE] ' : ''}Tarea de ${de}: ${t.titulo}`;
  const filas = [
    ['Qué', t.titulo], ['Pedida por', de],
    ['Para cuándo', t.vence ? t.vence.split('-').reverse().join('-') : 'Sin fecha'],
    ['Prioridad', t.prioridad === 'urgente' ? 'Urgente' : 'Normal'],
  ];
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1d1d1f;max-width:560px">
    <p style="margin:0 0 6px;color:#6b6b80;font-size:12px;letter-spacing:.1em;text-transform:uppercase">Seguridad Garridos · Tareas</p>
    <h2 style="margin:0 0 14px;font-size:20px">${escHtml(de)} le pidió una tarea</h2>
    <table style="border-collapse:collapse;font-size:14px">${filas.map(([a, b]) =>
      `<tr><td style="padding:4px 14px 4px 0;color:#6b6b80">${escHtml(a)}</td><td style="padding:4px 0"><b>${escHtml(b)}</b></td></tr>`).join('')}</table>
    ${t.detalle ? `<p style="white-space:pre-wrap;background:#f4f3f8;border-radius:10px;padding:12px 14px;font-size:14px">${escHtml(t.detalle)}</p>` : ''}
    <p style="margin-top:18px"><a href="${url}" style="background:#130052;color:#fff;text-decoration:none;padding:10px 18px;border-radius:980px;font-weight:600;font-size:14px">Ver en el panel</a></p>
  </div>`;
  const texto = [`${de} le pidió una tarea`, '', ...filas.map(([a, b]) => `${a}: ${b}`),
    ...(t.detalle ? ['', t.detalle] : []), '', `Ver en el panel: ${url}`].join('\n');
  return { asunto, html, texto };
}

function correoCierre(t, quien, url) {
  const hecha = t.estado === 'hecha';
  const asunto = `${hecha ? 'Hecha' : 'Devuelta'}: ${t.titulo}`;
  const frase = hecha ? `${quien} terminó la tarea que le pidió` : `${quien} le devolvió la tarea que le pidió`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1d1d1f;max-width:560px">
    <p style="margin:0 0 6px;color:#6b6b80;font-size:12px;letter-spacing:.1em;text-transform:uppercase">Seguridad Garridos · Tareas</p>
    <h2 style="margin:0 0 10px;font-size:20px">${escHtml(frase)}</h2>
    <p style="font-size:15px"><b>${escHtml(t.titulo)}</b></p>
    ${t.nota_cierre ? `<p style="white-space:pre-wrap;background:#f4f3f8;border-radius:10px;padding:12px 14px;font-size:14px">${escHtml(t.nota_cierre)}</p>` : ''}
    <p style="margin-top:18px"><a href="${url}" style="color:#130052;font-weight:600">Ver en el panel</a></p></div>`;
  const texto = [frase, '', t.titulo, ...(t.nota_cierre ? ['', t.nota_cierre] : []), '', `Ver en el panel: ${url}`].join('\n');
  return { asunto, html, texto };
}

/** Aviso por correo. Nunca hace fallar lo que lo llamó. */
async function avisar(env, usuario, armar) {
  try {
    const c = await cuenta(env, usuario);
    if (!c?.email || !c.activo) return { ok: false, error: 'esa cuenta no tiene correo' };
    return await mandarCorreo(env, c.email, armar(c));
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function crear(env, quien, cuerpo, base) {
  const titulo = limpio(cuerpo.titulo, 200);
  if (!titulo) return { error: 'Escriba qué necesita', status: 400 };
  const para = limpio(cuerpo.para_usuario, 60);
  const destino = para && await cuenta(env, para);
  if (!destino || !destino.activo) return { error: 'Elija a quién se la pide', status: 400 };
  const vence = /^\d{4}-\d{2}-\d{2}$/.test(cuerpo.vence || '') ? cuerpo.vence : null;

  const [t] = await insertar(env, 'tareas', {
    titulo, detalle: limpio(cuerpo.detalle, 4000), para_usuario: destino.usuario, pedida_por: quien,
    prioridad: PRIORIDADES.includes(cuerpo.prioridad) ? cuerpo.prioridad : 'normal', vence,
  });
  await anotar(env, quien, 'tarea', t.id, 'pidió una tarea', `${destino.usuario} · ${titulo}`.slice(0, 900));

  // Si se la pide a sí mismo es un recordatorio: no hace falta correo.
  let aviso = { ok: true, propia: true };
  if (destino.usuario !== quien && !cuerpo.con_archivo) {
    const yo = await cuenta(env, quien);
    aviso = await avisar(env, destino.usuario, () => correoNueva(t, yo?.nombre || quien, `${base}/`));
  }
  return { tarea: sinRuta(t), aviso };
}

/** El correo de una tarea que se creó esperando su archivo: sale cuando el archivo ya está. */
export async function avisarNueva(env, id, quien, base) {
  const t = await tareaDe(env, id, quien);
  if (!t || t.pedida_por !== quien || t.para_usuario === quien) return { ok: true };
  const yo = await cuenta(env, quien);
  return avisar(env, t.para_usuario, () => correoNueva(t, yo?.nombre || quien, `${base}/`));
}

export async function subirArchivo(env, id, quien, bytes, nombreOriginal) {
  const t = await tareaDe(env, id, quien);
  if (!t) return { error: 'Esa tarea no existe o no es suya', status: 404 };
  if (t.pedida_por !== quien) return { error: 'El archivo lo agrega quien pidió la tarea', status: 403 };
  if (t.estado !== 'pendiente') return { error: 'La tarea ya está cerrada', status: 409 };
  if (!bytes?.length) return { error: 'No llegó ningún archivo', status: 400 };
  if (bytes.length > arch.MAX_BYTES) return { error: 'El archivo pesa más de 10 MB', status: 413 };
  const rec = arch.reconocer(bytes);
  if (!rec || !TIPOS_ADJUNTO.includes(rec.tipo)) {
    return { error: 'Solo fotos (JPG, PNG, WebP, HEIC) o PDF', status: 415 };
  }
  const azar = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ruta = `tareas/${t.id}/${azar}.${rec.ext}`;
  const nombre = arch.nombreSeguro(nombreOriginal || 'adjunto', rec.ext);
  await arch.subir(env, ruta, bytes, rec.tipo);
  await actualizar(env, `tareas?id=eq.${t.id}`, {
    archivo_ruta: ruta, archivo_nombre: nombre, archivo_tipo: rec.tipo, archivo_bytes: bytes.length,
  }).catch(async (e) => { await arch.borrar(env, ruta).catch(() => {}); throw e; });
  if (t.archivo_ruta && t.archivo_ruta !== ruta) await arch.borrar(env, t.archivo_ruta).catch(() => {});
  return { ok: true, archivo: { nombre, tipo: rec.tipo, bytes: bytes.length } };
}

export async function archivo(env, id, quien) {
  const t = await tareaDe(env, id, quien);
  if (!t?.archivo_ruta) return null;
  return { nombre: t.archivo_nombre, tipo: t.archivo_tipo, contenido: await arch.bajar(env, t.archivo_ruta) };
}

export async function comentar(env, id, quien, texto) {
  const t = await tareaDe(env, id, quien);
  if (!t) return { error: 'Esa tarea no existe o no es suya', status: 404 };
  const limpioTxt = limpio(texto, 2000);
  if (!limpioTxt) return { error: 'Escriba el comentario', status: 400 };
  const [c] = await insertar(env, 'tareas_comentarios', { tarea_id: t.id, autor: quien, texto: limpioTxt });
  return { comentario: c };
}

/**
 * Cambiar el estado. `hecha` y `devuelta` las hace a quien se la pidieron;
 * `anulada`, quien la pidió; `reabrir` vuelve una cerrada a pendiente y lo
 * puede hacer quien la pidió (si la devolvieron, para insistir o corregir).
 */
export async function cambiar(env, id, quien, accion, nota, base) {
  const t = await tareaDe(env, id, quien);
  if (!t) return { error: 'Esa tarea no existe o no es suya', status: 404 };
  const ahora = new Date().toISOString();
  const texto = limpio(nota, 2000);

  if (accion === 'hecha' || accion === 'devuelta') {
    if (t.para_usuario !== quien) return { error: 'Solo la cierra a quien se la pidieron', status: 403 };
    if (t.estado !== 'pendiente') return { error: 'La tarea ya no está pendiente', status: 409 };
    if (accion === 'devuelta' && !texto) return { error: 'Diga por qué la devuelve', status: 400 };
    const [n] = await actualizar(env, `tareas?id=eq.${t.id}&estado=eq.pendiente`,
      { estado: accion, nota_cierre: texto, cerrada_por: quien, cerrada_en: ahora });
    if (!n) return { error: 'La tarea ya no está pendiente', status: 409 };
    await anotar(env, quien, 'tarea', t.id, accion === 'hecha' ? 'terminó una tarea' : 'devolvió una tarea',
      `${t.titulo}${texto ? ' · ' + texto : ''}`.slice(0, 900));
    let aviso = { ok: true, propia: true };
    if (t.pedida_por !== quien) {
      const yo = await cuenta(env, quien);
      aviso = await avisar(env, t.pedida_por, () => correoCierre(n, yo?.nombre || quien, `${base}/`));
    }
    return { tarea: sinRuta(n), aviso };
  }
  if (accion === 'anulada') {
    if (t.pedida_por !== quien) return { error: 'Solo la anula quien la pidió', status: 403 };
    if (t.estado !== 'pendiente') return { error: 'Solo se anula una tarea pendiente', status: 409 };
    const [n] = await actualizar(env, `tareas?id=eq.${t.id}`,
      { estado: 'anulada', nota_cierre: texto, cerrada_por: quien, cerrada_en: ahora });
    await anotar(env, quien, 'tarea', t.id, 'anuló una tarea', t.titulo);
    return { tarea: sinRuta(n) };
  }
  if (accion === 'reabrir') {
    if (t.pedida_por !== quien) return { error: 'Solo la reabre quien la pidió', status: 403 };
    if (t.estado === 'pendiente') return { error: 'La tarea ya está pendiente', status: 409 };
    const [n] = await actualizar(env, `tareas?id=eq.${t.id}`,
      { estado: 'pendiente', cerrada_por: null, cerrada_en: null });
    if (texto) await insertar(env, 'tareas_comentarios', { tarea_id: t.id, autor: quien, texto: texto });
    await anotar(env, quien, 'tarea', t.id, 'reabrió una tarea', t.titulo);
    return { tarea: sinRuta(n) };
  }
  return { error: 'Acción no válida', status: 400 };
}
