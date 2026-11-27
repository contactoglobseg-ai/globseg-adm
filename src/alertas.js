/**
 * Alertas de documentación pendiente, y lo que está subido a Pronexo.
 *
 * Pedido del gerente (17-11-2026): «alerta de documentación pendiente de cada
 * trabajador; si bien nosotros subimos la información a PRONEXO, es importante
 * que esto esté al día». Tres decisiones suyas:
 *   1. Correo diario a RRHH, y solo cuando hay algo nuevo.
 *   2. El sistema registra qué documento ya está subido a Pronexo.
 *   3. Lo exigido es lo mismo para todos: los obligatorios del catálogo.
 *
 * La pantalla de RRHH ya mostraba lo vencido desde el 15-10. Lo que faltaba no
 * era el cálculo, era que llegara solo: nadie entra a mirar lo que no le llega.
 *
 * Una sola regla decide todo lo demás: de cada papel de cada persona cuenta EL
 * ÚLTIMO, no todos. Cuando la OS-10 se renueva, la nueva es otra fila y la
 * vieja queda vigente hasta que alguien la anule, que nadie hace. Contarlas a
 * las dos haría que el correo siguiera diciendo «vencida» a una credencial que
 * se renovó la semana pasada, y un aviso que se equivoca una vez deja de
 * leerse las demás.
 *
 * Qué NO hace, a propósito:
 *   - No se conecta a Pronexo. Pronexo no ofrece una API pública, y aunque la
 *     ofreciera, lo que se registra acá es lo que RRHH afirma haber subido. Si
 *     algún día hay forma de preguntarle a Pronexo, esta marca es el lugar
 *     donde se escribiría la respuesta.
 *   - No manda nada si falta la clave del servicio de correo: escribe el
 *     intento en `envios_alertas` con el motivo, y la pantalla lo dice.
 */

import { buscar, primero, insertar, insertarSinDuplicar, actualizar, borrar, anotar } from './datos.js';
import { hoyISO } from './fechas.js';
import { formatearRut } from './rut.js';
import { aplicaA } from './rrhh.js';

/** Los tramos en que se avisa un vencimiento. Cada uno manda un correo una
 *  vez: a los 60 días hay tiempo de pedir hora; a los 7 ya no. */
export const TRAMOS = [60, 30, 7];

/** Hasta dónde se mira hacia adelante: lo que vence después no es pendiente. */
const HORIZONTE = TRAMOS[0];

const dias = (desde, hasta) => Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000);

/** El tramo de un documento que vence: 'vencido', 60, 30, 7, o null si está
 *  lejos. La clave del aviso lleva el tramo, así que cruzarlo vuelve a avisar. */
export function tramoDe(n) {
  if (n === null || n === undefined) return null;
  if (n < 0) return 'vencido';
  let t = null;
  for (const x of TRAMOS) if (n <= x) t = x;
  return t;
}

/** ¿Está aplicada la migración? Se mira una columna que solo ella crea. */
export async function migracionLista(env) {
  try {
    await buscar(env, 'documentos_trabajador?select=pronexo_subido_en&limit=1');
    await buscar(env, 'avisos_documentos?select=clave&limit=1');
    return true;
  } catch {
    return false;
  }
}

/** Trae todas las filas, de a mil. Supabase corta en mil por omisión, y una
 *  lista de documentos cortada en silencio es un faltante que no existe. */
async function todas(env, ruta) {
  const salida = [];
  for (let desde = 0; desde < 20000; desde += 1000) {
    const filas = await buscar(env, `${ruta}&limit=1000&offset=${desde}`);
    salida.push(...filas);
    if (filas.length < 1000) break;
  }
  return salida;
}

/**
 * El estado documental de cada persona activa.
 *
 * Por cada papel obligatorio que le corresponde según su cargo, dice uno de
 * cuatro estados —falta, vencido, por vencer, al día— y, si conviene, si ese
 * papel está subido a Pronexo.
 */
export async function estadoDocumental(env, { hoy = hoyISO(), conPronexo = true } = {}) {
  const colPronexo = conPronexo ? ',pronexo_subido_en,pronexo_por' : '';
  const [personas, tipos, docs] = await Promise.all([
    todas(env, 'v_personal?select=id,nombre,rut,cargo,instalacion&activo=is.true&order=nombre.asc'),
    buscar(env, 'tipos_documento?select=codigo,nombre,grupo,vence,obligatorio,aplica_a,orden'
      + '&activo=is.true&obligatorio=is.true&order=orden.asc'),
    todas(env, 'v_documentos?select=id,trabajador_id,tipo,numero,fecha_emision,fecha_vencimiento'
      + `${colPronexo}&trabajador_activo=is.true&vigente=is.true&order=id.asc`),
  ]);

  // El último de cada papel de cada persona. Gana el que vence más tarde; entre
  // dos que no vencen, el cargado después. Es la misma pregunta que haría
  // quien revisa la carpeta: «¿cuál es el que vale?».
  const ultimo = new Map();
  for (const d of docs) {
    const k = `${d.trabajador_id}|${d.tipo}`;
    const a = ultimo.get(k);
    if (!a) { ultimo.set(k, d); continue; }
    const fa = a.fecha_vencimiento || '';
    const fd = d.fecha_vencimiento || '';
    if (fd > fa || (fd === fa && d.id > a.id)) ultimo.set(k, d);
  }

  const resultado = [];
  for (const p of personas) {
    const items = [];
    for (const td of tipos.filter((x) => aplicaA(x, p.cargo))) {
      const d = ultimo.get(`${p.id}|${td.codigo}`);
      const it = { tipo: td.codigo, nombre: td.nombre, grupo: td.grupo };
      if (!d) {
        items.push({ ...it, estado: 'falta' });
        continue;
      }
      it.documento_id = d.id;
      it.numero = d.numero || null;
      it.fecha_vencimiento = d.fecha_vencimiento || null;
      const n = d.fecha_vencimiento ? dias(hoy, d.fecha_vencimiento) : null;
      it.dias = n;
      it.estado = n === null ? 'al_dia' : n < 0 ? 'vencido' : n <= HORIZONTE ? 'por_vencer' : 'al_dia';
      if (conPronexo) {
        it.pronexo_subido_en = d.pronexo_subido_en || null;
        it.pronexo_por = d.pronexo_por || null;
        // Un papel vencido no se sube: se renueva. Pedir que se suba a Pronexo
        // algo vencido sería pedir el paso equivocado.
        it.pronexo = d.pronexo_subido_en ? 'subido' : it.estado === 'vencido' ? null : 'pendiente';
      }
      items.push(it);
    }
    const cuenta = (e) => items.filter((x) => x.estado === e).length;
    resultado.push({
      id: p.id, nombre: p.nombre, rut: formatearRut(p.rut), cargo: p.cargo,
      instalacion: p.instalacion || null,
      items,
      faltan: cuenta('falta'), vencidos: cuenta('vencido'), por_vencer: cuenta('por_vencer'),
      pronexo_pendiente: items.filter((x) => x.pronexo === 'pendiente').length,
    });
  }

  const suma = (k) => resultado.reduce((a, p) => a + p[k], 0);
  return {
    hoy,
    tramos: TRAMOS,
    con_pronexo: conPronexo,
    exigidos: tipos.map((t) => ({ codigo: t.codigo, nombre: t.nombre, aplica_a: t.aplica_a })),
    personas: resultado,
    totales: {
      personas: resultado.length,
      al_dia: resultado.filter((p) => !p.faltan && !p.vencidos && !p.por_vencer
        && !p.pronexo_pendiente).length,
      faltan: suma('faltan'), vencidos: suma('vencidos'), por_vencer: suma('por_vencer'),
      pronexo_pendiente: suma('pronexo_pendiente'),
    },
  };
}

/**
 * Lo pendiente, cada cosa con su clave de aviso.
 *
 * La clave dice qué y en qué tramo. Lo que no cambia de tramo no vuelve a
 * avisarse; lo que cruza de 30 a 7 sí.
 */
export function pendientes(estado) {
  const salida = [];
  for (const p of estado.personas) {
    for (const it of p.items) {
      const base = { persona: p, item: it };
      if (it.estado === 'falta') {
        salida.push({ ...base, clase: 'falta', clave: `falta:${p.id}:${it.tipo}` });
      } else if (it.estado === 'vencido' || it.estado === 'por_vencer') {
        salida.push({ ...base, clase: it.estado,
          clave: `vence:${it.documento_id}:${tramoDe(it.dias)}` });
      }
      if (it.pronexo === 'pendiente') {
        salida.push({ ...base, clase: 'pronexo', clave: `pronexo:${it.documento_id}` });
      }
    }
  }
  return salida;
}

// ------------------------------------------------------------------- correo
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fechaCl = (iso) => (iso ? iso.split('-').reverse().join('-') : '');

function enDias(n) {
  if (n < 0) return `venció hace ${-n} día${n === -1 ? '' : 's'}`;
  if (n === 0) return 'vence hoy';
  if (n === 1) return 'vence mañana';
  return `vence en ${n} días`;
}

const ORDEN = { vencido: 0, falta: 1, por_vencer: 2, pronexo: 3 };

/** Una línea del correo, en palabras. */
function frase(x) {
  const it = x.item;
  if (x.clase === 'falta') return `${it.nombre}: no está cargado`;
  if (x.clase === 'pronexo') return `${it.nombre}: falta subirlo a Pronexo`;
  return `${it.nombre}: ${enDias(it.dias)} (${fechaCl(it.fecha_vencimiento)})`;
}

/** Destinatarios, desde datos_empresa. Lo que no parece un correo se descarta
 *  y se dice: una coma de más no puede dejar a RRHH sin aviso. */
export async function destinatarios(env) {
  const fila = await primero(env, 'datos_empresa?select=valor,por_confirmar&codigo=eq.correo_alertas_rrhh')
    .catch(() => null);
  const lista = String(fila?.valor || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  return {
    correos: lista.filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)),
    descartados: lista.filter((s) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)),
    por_confirmar: !!fila?.por_confirmar,
    configurado: !!fila,
  };
}

/**
 * Arma el correo. Va agrupado por persona —es como se trabaja: se llama a
 * alguien y se le pide todo lo suyo de una vez— y lo nuevo de hoy arriba.
 */
export function armarCorreo(estado, lista, nuevas, { url = 'https://adm.seggarridos.com/rrhh' } = {}) {
  const porPersona = new Map();
  for (const x of lista) {
    if (!porPersona.has(x.persona.id)) porPersona.set(x.persona.id, { p: x.persona, cosas: [] });
    porPersona.get(x.persona.id).cosas.push(x);
  }
  const grupos = [...porPersona.values()].map((g) => {
    g.cosas.sort((a, b) => ORDEN[a.clase] - ORDEN[b.clase] || a.item.nombre.localeCompare(b.item.nombre));
    g.nuevas = g.cosas.filter((x) => nuevas.has(x.clave)).length;
    g.peor = Math.min(...g.cosas.map((x) => ORDEN[x.clase]));
    return g;
  });
  // Primero quien tiene algo nuevo, después quien tiene algo vencido.
  grupos.sort((a, b) => (b.nuevas > 0) - (a.nuevas > 0) || a.peor - b.peor
    || a.p.nombre.localeCompare(b.p.nombre));

  const t = estado.totales;
  const cuenta = (c) => lista.filter((x) => x.clase === c).length;
  const resumen = [
    cuenta('vencido') && `${cuenta('vencido')} vencido${cuenta('vencido') === 1 ? '' : 's'}`,
    cuenta('falta') && `${cuenta('falta')} sin cargar`,
    cuenta('por_vencer') && `${cuenta('por_vencer')} por vencer`,
    cuenta('pronexo') && `${cuenta('pronexo')} sin subir a Pronexo`,
  ].filter(Boolean);

  const asunto = nuevas.size
    ? `Documentación: ${nuevas.size} aviso${nuevas.size === 1 ? '' : 's'} nuevo${nuevas.size === 1 ? '' : 's'}`
      + ` · ${grupos.filter((g) => g.nuevas).length} persona${grupos.filter((g) => g.nuevas).length === 1 ? '' : 's'}`
    : `Documentación pendiente · ${grupos.length} persona${grupos.length === 1 ? '' : 's'}`;

  const COLOR = { vencido: '#B42318', falta: '#B42318', por_vencer: '#B54708', pronexo: '#175CD3' };

  const html = `<!doctype html><html><body style="margin:0;background:#F5F5F7;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1d1d1f">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
  <p style="margin:0 0 4px;font-size:12px;color:#6e6e73;text-transform:uppercase;letter-spacing:.06em">Seguridad Garridos · Recursos Humanos</p>
  <h1 style="margin:0 0 6px;font-size:20px">${esc(asunto)}</h1>
  <p style="margin:0 0 18px;font-size:14px;color:#424245">${fechaCl(estado.hoy)} · ${t.personas} personas activas, ${t.al_dia} al día.
    ${resumen.length ? 'Pendiente: ' + esc(resumen.join(', ')) + '.' : ''}</p>
  ${grupos.map((g) => `
  <div style="background:#fff;border-radius:12px;padding:14px 16px;margin:0 0 10px;border:1px solid #e5e5ea">
    <p style="margin:0 0 6px;font-size:15px"><b>${esc(g.p.nombre)}</b>
      <span style="color:#6e6e73;font-size:13px"> · ${esc(g.p.rut)}${g.p.instalacion ? ' · ' + esc(g.p.instalacion) : ''}</span></p>
    <ul style="margin:0;padding:0 0 0 18px;font-size:14px;line-height:1.55">
      ${g.cosas.map((x) => `<li style="color:${COLOR[x.clase]}"><span style="color:#1d1d1f">${esc(frase(x))}</span>${
        nuevas.has(x.clave) ? ' <b style="font-size:11px;background:#FEF0C7;color:#93370D;padding:1px 6px;border-radius:6px">NUEVO</b>' : ''}</li>`).join('')}
    </ul>
  </div>`).join('')}
  <p style="margin:18px 0 0;font-size:13px;color:#6e6e73">Se revisa todos los días a las 8 de la mañana. Este correo sale solo cuando
    aparece algo nuevo: un papel que falta, uno que entra a los ${TRAMOS.join(', ')} días de vencer, uno que venció,
    o uno renovado que todavía no se marca como subido a Pronexo.<br>
    Para ver y marcar: <a href="${esc(url)}" style="color:#0071e3">${esc(url.replace(/^https?:\/\//, ''))}</a>, pestaña Documentación.</p>
</div></body></html>`;

  const texto = [
    asunto, `${fechaCl(estado.hoy)} · ${t.personas} personas activas, ${t.al_dia} al día.`, '',
    ...grupos.flatMap((g) => [
      `${g.p.nombre} (${g.p.rut})`,
      ...g.cosas.map((x) => `  - ${frase(x)}${nuevas.has(x.clave) ? '  [NUEVO]' : ''}`), '',
    ]),
    `Ver y marcar: ${url} (pestaña Documentación)`,
  ].join('\n');

  return { asunto, html, texto, personas: grupos.length };
}

/** Manda por Resend. Devuelve { ok, error }. Sin clave no intenta. */
export async function mandarCorreo(env, para, { asunto, html, texto }) {
  if (!env.RESEND_API_KEY) {
    return { ok: false, error: 'Falta configurar el envío de correos (secreto RESEND_API_KEY del Worker)' };
  }
  const remitente = env.CORREO_REMITENTE || 'Seguridad Garridos <avisos@seggarridos.com>';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY.trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: remitente, to: para, subject: asunto, html, text: texto }),
    });
    if (r.ok) return { ok: true };
    const cuerpo = await r.text();
    let msj = cuerpo;
    try { msj = JSON.parse(cuerpo).message || cuerpo; } catch { /* queda el texto */ }
    return { ok: false, error: `El servicio de correo respondió ${r.status}: ${String(msj).slice(0, 300)}` };
  } catch (e) {
    return { ok: false, error: `No se pudo llegar al servicio de correo: ${e.message}` };
  }
}

/**
 * La pasada diaria, y el «Enviar ahora» de la pantalla.
 *
 * El diario manda solo si hay algo nuevo; el de la pantalla manda siempre,
 * porque quien aprieta el botón quiere el correo. Los dos dejan anotado qué
 * salió, y solo un envío que salió de verdad marca las cosas como avisadas:
 * un correo que falló no avisó a nadie, y lo nuevo tiene que seguir siéndolo
 * mañana.
 */
export async function enviarResumen(env, { origen = 'diario', quien = null, soloVer = false } = {}) {
  if (!(await migracionLista(env))) {
    return { error: 'Falta aplicar la migración 20261117120000_alertas_documentos.sql', status: 503 };
  }
  const estado = await estadoDocumental(env);
  const lista = pendientes(estado);
  const claves = new Set(lista.map((x) => x.clave));

  const previas = await todas(env, 'avisos_documentos?select=clave&order=clave.asc');
  const yaAvisadas = new Set(previas.map((x) => x.clave));
  const nuevas = new Set([...claves].filter((k) => !yaAvisadas.has(k)));
  const obsoletas = [...yaAvisadas].filter((k) => !claves.has(k));

  const correo = armarCorreo(estado, lista, nuevas, { url: env.URL_RRHH });
  const para = await destinatarios(env);

  if (soloVer) {
    return { ...correo, para: para.correos, descartados: para.descartados,
             nuevos: nuevas.size, pendientes: lista.length };
  }

  // Lo que ya no está pendiente se olvida, haya o no correo hoy. Así la tabla
  // no crece, y si mañana vuelve a faltar, es nuevo de verdad.
  for (let i = 0; i < obsoletas.length; i += 80) {
    const trozo = obsoletas.slice(i, i + 80).map((k) => `"${k}"`).join(',');
    await borrar(env, `avisos_documentos?clave=in.(${encodeURIComponent(trozo)})`).catch((e) =>
      console.error('alertas: no se pudo limpiar', e.message));
  }

  if (origen === 'diario' && !nuevas.size) {
    return { enviado: false, motivo: 'Nada nuevo desde el último aviso', pendientes: lista.length };
  }
  if (!lista.length) {
    return { enviado: false, motivo: 'No hay nada pendiente', pendientes: 0 };
  }
  if (!para.correos.length) {
    const error = 'No hay ningún correo de destino válido en «correo_alertas_rrhh»';
    await insertar(env, 'envios_alertas', { origen, destinatarios: '', asunto: correo.asunto,
      nuevos: nuevas.size, pendientes: lista.length, ok: false, error, quien });
    return { enviado: false, error, status: 400 };
  }

  const r = await mandarCorreo(env, para.correos, correo);
  await insertar(env, 'envios_alertas', {
    origen, destinatarios: para.correos.join(', '), asunto: correo.asunto,
    nuevos: nuevas.size, pendientes: lista.length, ok: r.ok, error: r.error || null, quien,
  });
  if (r.ok && nuevas.size) {
    await insertarSinDuplicar(env, 'avisos_documentos',
      [...nuevas].map((clave) => ({ clave })), 'clave').catch((e) =>
      console.error('alertas: no se pudo anotar lo avisado', e.message));
  }
  if (quien) {
    await anotar(env, quien, 'alertas', null, r.ok ? 'mandó el aviso de documentación' : 'intentó mandar el aviso',
      `${para.correos.join(', ')} · ${lista.length} pendientes${r.error ? ' · ' + r.error : ''}`);
  }
  return { enviado: r.ok, error: r.error, para: para.correos, nuevos: nuevas.size,
           pendientes: lista.length, asunto: correo.asunto };
}

/** Para la pantalla: el estado, a quién se avisa y cómo salieron los últimos. */
export async function pantalla(env) {
  const lista = await migracionLista(env);
  const estado = await estadoDocumental(env, { conPronexo: lista });
  const [para, envios] = await Promise.all([
    destinatarios(env),
    lista ? buscar(env, 'envios_alertas?select=*&order=enviado_en.desc&limit=10').catch(() => []) : [],
  ]);
  return {
    ...estado,
    migracion_lista: lista,
    correo: {
      para: para.correos, descartados: para.descartados, por_confirmar: para.por_confirmar,
      configurado: !!env.RESEND_API_KEY,
      remitente: env.CORREO_REMITENTE || 'Seguridad Garridos <avisos@seggarridos.com>',
    },
    envios,
  };
}

// ------------------------------------------------------------------ Pronexo
const sinMigracion = () => ({
  error: 'Falta aplicar la migración 20261117120000_alertas_documentos.sql: sin ella no hay dónde '
    + 'anotar lo que está subido a Pronexo', status: 503,
});

/** Marca (o desmarca) un documento como subido a Pronexo. */
export async function marcarPronexo(env, quien, id, subido) {
  if (!(await migracionLista(env))) return sinMigracion();
  const d = await primero(env, `v_documentos?select=id,tipo_nombre,trabajador,vigente,estado&id=eq.${id}`);
  if (!d) return { error: 'Ese documento no existe', status: 404 };
  if (subido && !d.vigente) return { error: 'Ese documento está anulado', status: 400 };
  await actualizar(env, `documentos_trabajador?id=eq.${id}`, subido
    ? { pronexo_subido_en: new Date().toISOString(), pronexo_por: quien }
    : { pronexo_subido_en: null, pronexo_por: null });
  await anotar(env, quien, 'documento_rrhh', id,
    subido ? 'marcó subido a Pronexo' : 'desmarcó Pronexo', `${d.trabajador} · ${d.tipo_nombre}`);
  return { ok: true, aviso: subido && d.estado === 'vencido'
    ? 'Quedó marcado, pero el documento está vencido: lo que Pronexo tiene que recibir es el renovado.'
    : null };
}

/**
 * Marca de una vez lo que está pendiente de subir: de una persona, o de todos.
 *
 * Existe por el primer día. La empresa lleva meses subiendo a Pronexo, y sin
 * esto el primer correo diría que nada está subido —cientos de líneas—, que es
 * la forma más rápida de que nadie lea el segundo.
 */
export async function marcarPronexoTodo(env, quien, trabajadorId = null) {
  if (!(await migracionLista(env))) return sinMigracion();
  const estado = await estadoDocumental(env);
  const ids = estado.personas
    .filter((p) => !trabajadorId || p.id === trabajadorId)
    .flatMap((p) => p.items.filter((x) => x.pronexo === 'pendiente').map((x) => x.documento_id));
  if (!ids.length) return { ok: true, marcados: 0 };
  const ahora = new Date().toISOString();
  for (let i = 0; i < ids.length; i += 150) {
    await actualizar(env, `documentos_trabajador?id=in.(${ids.slice(i, i + 150).join(',')})`,
      { pronexo_subido_en: ahora, pronexo_por: quien });
  }
  const nombre = trabajadorId ? estado.personas.find((p) => p.id === trabajadorId)?.nombre : null;
  await anotar(env, quien, 'documento_rrhh', null, 'marcó subido a Pronexo en bloque',
    `${ids.length} documento${ids.length === 1 ? '' : 's'}${nombre ? ' de ' + nombre : ' de todo el personal'}`);
  return { ok: true, marcados: ids.length };
}
