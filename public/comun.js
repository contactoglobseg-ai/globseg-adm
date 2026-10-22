/**
 * Lo que comparten las páginas de la oficina: el panel de adm.seggarridos.com
 * y Personas en rrhh.seggarridos.com.
 *
 * Acá vive el marco —barra lateral, cajón, movimiento, la puerta de entrada y
 * el arranque— y los ayudantes que usan las dos. Lo propio de cada pantalla
 * se queda en su página.
 *
 * ================= Antes de mover nada de acá, leer esto =================
 *
 * Este archivo y el `<script>` de cada página son dos scripts clásicos, así
 * que **comparten el ámbito global**: una sola declaración repetida entre los
 * dos da `SyntaxError: Identifier has already been declared` y entonces no
 * corre NADA de esa página. Queda en blanco, no a medias. Si se saca algo de
 * acá hacia una página, hay que borrarlo de acá; si se sube algo, hay que
 * borrarlo de las dos páginas.
 *
 * Al revés sí funciona, y de eso depende el diseño: las funciones de acá
 * pueden nombrar cosas que declara la página —`VISTAS`, `GRUPOS`— porque el
 * cuerpo de una función se resuelve recién al llamarla, y para entonces la
 * página ya se evaluó.
 *
 * Cada página pone lo suyo:
 *   · `VISTAS` y `GRUPOS`, que son distintos en cada una.
 *   · `precargar(usuario)`, opcional: lo que haya que traer antes de pintar.
 *   · `alCambiarVista(vista)`, opcional: lo que haya que soltar al cambiar
 *     de sección. El panel limpia ahí lo que estaba marcado en las tablas.
 *
 * Se carga **después** de apariencia.js y **antes** del `<script>` de la
 * página, que es quien llama a `arrancar()`.
 */

"use strict";

const $ = (s, r = document) => r.querySelector(s);

/** Escribe en un cartel de estado conservando su clase .mensaje: asignar
 *  className a secas la borraba, y el siguiente intento ya no encontraba el
 *  elemento. tipo: "", "ok" o "error". */
function decir(el, texto, tipo = "") {
  if (!el) return;
  el.className = "mensaje" + (tipo ? " " + tipo : "");
  el.textContent = texto;
}
const clp = n => "$" + (Math.round(n || 0)).toLocaleString("es-CL");
const fecha = s => s ? s.split("-").reverse().join("-") : "—";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));


const hoyISO = () => new Date().toISOString().slice(0, 10);

/* El título con que arrancó la página, para anteponerle la sección sin tener
   escrito «Administración» en un archivo que también usa Personas. Se lee acá
   y no al cambiar de sección porque para entonces ya lo reescribimos.
   De ahí sale además el rótulo de la puerta de entrada: el <title> ya viene
   con las dos líneas que lleva, «Personas · Seguridad Garridos». */
const TITULO_BASE = document.title;
const MARCA = TITULO_BASE.split(" · ");

let recadoReloj;
function recado(texto, tipo = "ok") {
  $("#recado")?.remove();
  const el = document.createElement("div");
  el.id = "recado";
  el.className = "recado" + (tipo === "mal" ? " recado--mal" : "");
  el.textContent = texto;
  document.body.appendChild(el);
  clearTimeout(recadoReloj);
  recadoReloj = setTimeout(() => el.remove(), 4200);
}

let estado = { usuario: null, quienBorra: [], panel: null, catalogos: null, vista: "panel",
  // Qué empresa se está mirando en el panel y en qué orden. Vive en memoria,
  // como el filtro del libro de asistencia: son un puñado de clientes y todo
  // lo que hay que filtrar ya llegó en /panel.
  panelFiltro: { empresa: "", orden: "urgencia" },
  // A qué grupo de la lateral pertenece cada vista, para decirlo en el
  // encabezado: en teléfono la lateral no se ve y sin esto nadie sabe dónde está.
  grupoDe: {} };

async function pedir(ruta, opciones) {
  const r = await fetch("/api" + ruta, {
    headers: { "content-type": "application/json" },
    ...opciones,
  });
  const cuerpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(cuerpo.error || `Error ${r.status}`);
  return cuerpo;
}

function aviso(tipo, titulo, texto) {
  const icono = tipo === "bien"
    ? '<path d="M4 12.5l5 5 11-11"/>'
    : '<path d="M12 8v5"/><circle cx="12" cy="16.5" r="1.1" fill="currentColor" stroke="none"/><path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>';
  return `<div class="aviso aviso--${tipo}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icono}</svg>
    <div><b>${esc(titulo)}</b>${esc(texto)}</div></div>`;
}

const JSPDF = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";

function cargarScript(url, queEs = "el generador de PDF") {
  return new Promise((listo, falla) => {
    if (document.querySelector(`script[src="${url}"]`)) return listo();
    const s = document.createElement("script");
    s.src = url;
    s.onload = listo;
    s.onerror = () => falla(new Error(`No se pudo cargar ${queEs}. ¿Hay internet?`));
    document.head.appendChild(s);
  });
}

/** Carga el logo reducido. A tamaño completo son 140 KB que se incrustan en
 *  cada PDF y lo dejan en más de un mega; a 150 px se ve igual de nítido en
 *  los 20 mm que ocupa en la hoja. */
const cargarLogo = (src, lado = 150) => new Promise(listo => {
  const i = new Image();
  i.onload = () => {
    const c = document.createElement("canvas");
    c.width = c.height = lado;
    c.getContext("2d").drawImage(i, 0, 0, lado, lado);
    listo(c.toDataURL("image/png"));
  };
  i.onerror = () => listo(null);     // sin logo, el PDF se arma igual
  i.src = src;
});

const SHEETJS = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

const CARGOS = ["guardia", "supervisor", "nochero", "rondin"];

const sinTildes = s => String(s ?? "").normalize("NFD")
  .replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

/** La misma regla que aplica el servidor, para mostrarla mientras se escribe. */
function usuarioPropuesto(nombres, paterno, materno) {
  const n = sinTildes(String(nombres ?? "").trim().split(/\s+/)[0]);
  const p = sinTildes(paterno);
  const m = sinTildes(String(materno ?? "").trim().split(/\s+/)[0]);
  if (!n || !p) return "";
  return n[0] + p + (m ? m[0] : "");
}

const rutLindo = v => {
  const t = String(v ?? "").toUpperCase().replace(/[^0-9K]/g, "");
  if (t.length < 2) return t;
  return t.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "-" + t.slice(-1);
};

/** Los grupos con las secciones que esta cuenta puede ver; un grupo sin
 *  ninguna no se dibuja. Lo que no esté en ningún grupo aparece igual, al
 *  final, bajo "Otras": una pantalla nueva que alguien olvide agrupar tiene
 *  que salir mal puesta, no desaparecer sin que nadie se entere. */
function navegacion() {
  /* `modulo` puede ser uno o un arreglo. Un arreglo es «cualquiera de estos»:
     lo pide la pantalla de documentos, que abren RRHH y prevención con
     permisos distintos. */
  const puede = k => {
    const m = VISTAS[k] && VISTAS[k].modulo;
    if (!VISTAS[k]) return false;
    if (!m) return true;
    return (Array.isArray(m) ? m : [m]).some(x => estado.usuario.permisos.includes(x));
  };
  const agrupadas = new Set(GRUPOS.flatMap(g => g.vistas));
  const grupos = GRUPOS
    .map(g => ({ rotulo: g.rotulo, vistas: g.vistas.filter(puede) }))
    .filter(g => g.vistas.length);
  const sueltas = Object.keys(VISTAS).filter(k => !agrupadas.has(k) && puede(k));
  if (sueltas.length) grupos.push({ rotulo: "Otras", vistas: sueltas });
  return grupos;
}

/* ================= El marco: lateral, cajón y movimiento =================

   Esto es lo único de la página con movimiento propio, y sigue tres reglas
   prestadas de cómo arma Apple sus interfaces:

   1. Todo lo que se puede agarrar se anima con un resorte, no con una
      transición de CSS. El resorte arranca siempre desde donde está la cosa
      EN PANTALLA, así que se puede agarrar a mitad de camino y devolver sin
      que pegue un salto. Una transición no se deja agarrar.
   2. Al soltar el dedo, la animación sigue a la velocidad que traía el dedo.
      Sin eso se nota la costura entre arrastrar y soltar.
   3. Dónde termina un envión no lo decide dónde se soltó, sino dónde iba a
      parar: la misma proyección con que frena el scroll.

   Con prefers-reduced-motion todo esto se salta y los estados se aplican de
   una vez. Lo que se reduce es el movimiento, no la respuesta. */

const MENOS_MOVIMIENTO = window.matchMedia("(prefers-reduced-motion: reduce)");
const ES_ANGOSTO = window.matchMedia("(max-width: 1000px)");

/**
 * Un resorte, con los dos parámetros con que lo piensa Apple en vez de masa,
 * rigidez y amortiguación:
 *   respuesta — en cuánto llega, en segundos. Más chico, más seco.
 *   rebote    — 0 es crítico y no se pasa; .2 se pasa un poco. El rebote se
 *               reserva para lo que venía con envión del dedo: una cosa
 *               lanzada se pasa, un panel que se abrió con un botón no.
 * Devuelve un mando: `x` y `v` son el valor y la velocidad de este instante,
 * que es justamente lo que hay que leer para que la animación siguiente
 * empiece desde acá y no desde el valor lógico.
 */
function resorte({ desde, hasta, velocidad = 0, rebote = 0, respuesta = .4, alPaso, alFin }) {
  const w = 2 * Math.PI / respuesta;
  const z = 1 - Math.max(0, Math.min(.85, rebote));
  let x = desde, v = velocidad, antes = null, vivo = true;
  const paso = t => {
    if (!vivo) return;
    if (antes === null) antes = t;
    // Una pestaña en segundo plano devuelve saltos de varios segundos; sin
    // este tope la integración explota y la cosa sale disparada.
    const dt = Math.min((t - antes) / 1000, 1 / 20);
    antes = t;
    const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
    for (let i = 0; i < n; i++) {
      v += (-w * w * (x - hasta) - 2 * z * w * v) * h;
      x += v * h;
    }
    if (Math.abs(x - hasta) < .4 && Math.abs(v) < 5) {
      x = hasta; v = 0; vivo = false;
      alPaso(x); if (alFin) alFin();
      return;
    }
    alPaso(x);
    requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
  return {
    get x() { return x; }, get v() { return v; }, get vivo() { return vivo; },
    detener() { vivo = false; },
  };
}

/** Dónde va a parar un envión, con la misma curva de frenado del scroll. */
const proyectar = (vel, frenado = .998) => (vel / 1000) * frenado / (1 - frenado);

/** Resistencia pasado el tope: cede cada vez menos en vez de pegar un palo.
 *  Un freno seco se lee como "esto se trabó"; la resistencia se lee como
 *  "sigue respondiendo, pero por acá no hay más". */
const elastico = (exceso, medida, k = .55) =>
  (exceso * medida * k) / (medida + k * Math.abs(exceso));

const marco = (() => {
  const lateral = $("#lateral"), velo = $("#velo"), boton = $("#abrir-lateral");

  /* ---------- la pastilla que marca la sección elegida ---------- */
  let pasY = 0, pasAnim = null, pasPuesta = false;

  function moverPastilla(bt, deGolpe) {
    const sel = $("#lateral-sel");
    if (!sel || !bt) return;
    const destino = bt.offsetTop;
    let v0 = 0;
    // Siempre desde el valor que hay en pantalla: si alguien cambia de
    // sección con la pastilla todavía viajando, sigue desde donde va y con la
    // velocidad que lleva, en vez de saltar al punto de partida nuevo.
    if (pasAnim) { pasY = pasAnim.x; v0 = pasAnim.v; pasAnim.detener(); pasAnim = null; }
    sel.style.height = bt.offsetHeight + "px";
    if (deGolpe || !pasPuesta || MENOS_MOVIMIENTO.matches) {
      pasY = destino;
      sel.style.transform = `translateY(${destino}px)`;
      sel.classList.add("vive");
      pasPuesta = true;
      return;
    }
    pasAnim = resorte({
      desde: pasY, hasta: destino, velocidad: v0, respuesta: .34,
      alPaso: y => { pasY = y; sel.style.transform = `translateY(${y}px)`; },
      alFin: () => { pasAnim = null; },
    });
  }

  const botonDe = v => document.querySelector(`#pestanas button[data-vista="${v}"]`);
  const recolocar = () => moverPastilla(botonDe(estado.vista), true);

  /* ---------- el cajón, en teléfono ----------
     x va de -ancho (cerrado) a 0 (abierto), en píxeles. */
  let x = 0, ancho = 280, anim = null, arr = null, ultimoArrastre = -9999;

  const medir = () => { ancho = lateral.getBoundingClientRect().width || ancho; };

  function pintar(n) {
    x = n;
    lateral.style.transform = `translateX(${n}px)`;
    const f = Math.min(1, Math.max(0, 1 + n / ancho));
    velo.style.opacity = String(f);
    if (f > 0 && velo.hidden) velo.hidden = false;
  }

  function asentar(destino) {
    const abierto = destino >= 0;
    velo.hidden = !abierto;
    boton.setAttribute("aria-expanded", String(abierto));
    // Cerrado, el cajón sigue existiendo corrido fuera de pantalla: sin inert
    // se llega igual a sus botones con Tab y el lector de pantalla los lee.
    lateral.inert = ES_ANGOSTO.matches && !abierto;
  }

  function animar(destino, v0 = 0, conEnvion = false) {
    if (anim) { x = anim.x; if (!v0) v0 = anim.v; anim.detener(); anim = null; }
    if (destino >= 0) {
      velo.hidden = false; lateral.inert = false;
      boton.setAttribute("aria-expanded", "true");
    }
    if (MENOS_MOVIMIENTO.matches) { pintar(destino); asentar(destino); return; }
    anim = resorte({
      desde: x, hasta: destino, velocidad: v0,
      rebote: conEnvion ? .2 : 0, respuesta: .33,
      alPaso: pintar,
      alFin: () => { anim = null; asentar(destino); },
    });
  }

  const abrir = () => { if (!ES_ANGOSTO.matches) return; medir(); animar(0); };
  const cerrar = () => {
    if (!ES_ANGOSTO.matches) return;
    if (!anim && x <= -ancho + .5) return;
    animar(-ancho);
  };

  /* El cajón va pegado al dedo, con resistencia pasado el tope, y al soltar
     se va a donde iba a parar el envión. */
  function empezar(ev) {
    if (!ES_ANGOSTO.matches || ev.button > 0 || !ev.isPrimary) return;
    medir();
    arr = { x0: ev.clientX, y0: ev.clientY, base: x, activo: false,
            donde: ev.currentTarget, hist: [{ t: ev.timeStamp, x }] };
  }

  function seguir(ev) {
    if (!arr) return;
    const dx = ev.clientX - arr.x0, dy = ev.clientY - arr.y0;
    if (!arr.activo) {
      // Hasta diez píxeles todavía puede ser un toque o un scroll vertical.
      // Comprometerse antes se roba los clics de los botones de la lateral.
      if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy)) return;
      arr.activo = true;
      if (anim) { arr.base = anim.x; anim.detener(); anim = null; }
      try { arr.donde.setPointerCapture(ev.pointerId); } catch { /* da igual */ }
    }
    let n = arr.base + dx;
    if (n > 0) n = elastico(n, ancho);
    else if (n < -ancho) n = -ancho;
    arr.hist.push({ t: ev.timeStamp, x: n });
    if (arr.hist.length > 6) arr.hist.shift();
    pintar(n);
  }

  function soltar(ev) {
    const a = arr; arr = null;
    if (!a) return;
    if (!a.activo) {
      // No llegó a ser arrastre: fue un toque. En el velo, eso cierra.
      if (a.donde === velo) cerrar();
      return;
    }
    ultimoArrastre = performance.now();
    const p = a.hist[0], u = a.hist[a.hist.length - 1];
    const dt = (u.t - p.t) / 1000;
    const v = dt > 0 ? (u.x - p.x) / dt : 0;
    animar(x + proyectar(v) > -ancho / 2 ? 0 : -ancho, v, Math.abs(v) > 120);
  }

  for (const el of [lateral, velo]) {
    el.addEventListener("pointerdown", empezar);
    el.addEventListener("pointermove", seguir);
    el.addEventListener("pointerup", soltar);
    el.addEventListener("pointercancel", soltar);
  }
  boton.addEventListener("click", () => (x > -ancho / 2 ? cerrar() : abrir()));
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape" && ES_ANGOSTO.matches && x > -ancho + .5) cerrar();
  });

  /* Al pasar de teléfono a pantalla grande hay que soltar el transform que
     dejó el cajón: si no, la lateral se queda corrida fuera de pantalla. */
  function acomodar() {
    if (anim) { anim.detener(); anim = null; }
    if (ES_ANGOSTO.matches) {
      medir();
      pintar(-ancho); asentar(-ancho);
    } else {
      lateral.style.transform = "";
      velo.hidden = true; velo.style.opacity = "0";
      x = 0;
      boton.setAttribute("aria-expanded", "false");
      lateral.inert = false;
    }
    recolocar();
  }
  ES_ANGOSTO.addEventListener("change", acomodar);
  window.addEventListener("resize", recolocar);
  acomodar();

  /* La línea bajo el encabezado aparece solo cuando hay contenido pasando por
     debajo: un borde fijo sobre una página sin scroll no separa nada. */
  const barra = $("#barra");
  const mirarScroll = () => barra.classList.toggle("barra--pegada", window.scrollY > 2);
  window.addEventListener("scroll", mirarScroll, { passive: true });
  mirarScroll();

  return {
    recolocar,
    cerrar,
    /** ¿Veníamos de un arrastre? Para no disparar el clic de un botón de la
     *  lateral cuando lo que hizo el dedo fue arrastrar el cajón. */
    arrastrando: () => performance.now() - ultimoArrastre < 220,
    /** Al elegir una sección: la pastilla viaja, el encabezado dice dónde
     *  estamos —en teléfono la lateral no se ve— y el cajón se cierra solo. */
    alElegir(vista) {
      moverPastilla(botonDe(vista));
      $("#donde-grupo").textContent = estado.grupoDe[vista] || "";
      $("#donde-vista").textContent = VISTAS[vista] ? VISTAS[vista].rotulo : "";
      document.title = (VISTAS[vista] ? VISTAS[vista].rotulo + " · " : "") + TITULO_BASE;
      cerrar();
    },
    /** El contenido nuevo entra en vez de aparecer de golpe. */
    entrada() {
      const app = $("#app");
      if (!app || MENOS_MOVIMIENTO.matches) return;
      app.classList.remove("entra");
      void app.offsetWidth;   // sin esto la animación no se vuelve a disparar
      app.classList.add("entra");
    },
  };
})();

function ir(vista) {
  // Cambiar de sección descarta lo que la página tuviera agarrado: el panel
  // limpia ahí lo que estaba marcado en las tablas, porque las acciones de la
  // barra no aplican a lo que se está mirando ahora y quedaría apuntando a
  // otra cosa. La página de Personas no tiene nada que soltar y no define el
  // gancho.
  if (vista !== estado.vista && typeof alCambiarVista === "function") {
    alCambiarVista(vista);
  }
  estado.vista = vista;
  // Sin esto, entrar a una sección nueva desde el final de la anterior deja la
  // pantalla a media altura y parece que no hubiera pasado nada.
  window.scrollTo({ top: 0 });
  document.querySelectorAll("#pestanas button").forEach(b =>
    b.setAttribute("aria-current", String(b.dataset.vista === vista)));
  marco.alElegir(vista);
  // Varias vistas son asíncronas: si fallan y nadie atrapa el error, la
  // pantalla se queda en blanco sin decir por qué. Mejor mostrar el motivo.
  Promise.resolve()
    .then(() => VISTAS[vista].pintar())
    .then(() => marco.entrada())
    .catch(e => {
      $("#app").innerHTML = aviso("mal", "No se pudo cargar esta sección", e.message);
    });
}

function pintarIngreso(mensaje) {
  document.body.innerHTML = `<div class="puerta"><div class="puerta__caja">
    <div class="puerta__tit"><img src="logo.png" alt="">
      <span><b>${esc(MARCA[0])}</b><span>${esc(MARCA[1] || "")}</span></span></div>
    <form id="f-entrar">
      <label class="campo"><span>Usuario</span>
        <input name="usuario" autocomplete="username" autocapitalize="none"
               spellcheck="false" required autofocus></label>
      <label class="campo"><span>Contraseña</span>
        <input name="clave" type="password" autocomplete="current-password" required></label>
      <button class="bt" type="submit">Entrar</button>
      <span class="mensaje"></span>
    </form>
  </div></div>`;
  const f = document.getElementById("f-entrar");
  if (mensaje) { const m = f.querySelector(".mensaje"); decir(m, mensaje, "error"); }
  f.onsubmit = async ev => {
    ev.preventDefault();
    const m = f.querySelector(".mensaje"), bt = f.querySelector("button");
    decir(m, "Entrando…"); bt.disabled = true;
    try {
      await pedir("/sesion", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(f))) });
      location.reload();
    } catch (e) {
      decir(m, e.message, "error");
      bt.disabled = false;
      f.clave.value = ""; f.clave.focus();
    }
  };
}

/**
 * `obligatorio` es la primera entrada, con la contraseña inicial sin cambiar:
 * de ahí no se sale sin cambiarla, y el servidor tampoco deja usar ninguna otra
 * ruta. Sin él, es alguien que vino a cambiarla porque quiso —porque la tecleó
 * donde no debía, por ejemplo— y entonces tiene que poder volverse atrás: un
 * formulario sin salida se contesta cerrando la pestaña, y quien la tecleó en
 * otra parte se queda con la misma contraseña.
 */
function pintarCambioClave(usuario, obligatorio = true) {
  document.body.innerHTML = `<div class="puerta"><div class="puerta__caja">
    <div class="puerta__tit"><img src="logo.png" alt="">
      <span><b>${obligatorio ? "Cambie su contraseña" : "Cambiar mi contraseña"}</b><span>${esc(usuario.nombre)}</span></span></div>
    <form id="f-clave">
      <label class="campo"><span>Contraseña actual</span>
        <input name="actual" type="password" autocomplete="current-password" required autofocus></label>
      <label class="campo"><span>Contraseña nueva</span>
        <input name="nueva" type="password" autocomplete="new-password" required></label>
      <label class="campo"><span>Repita la nueva</span>
        <input name="repetir" type="password" autocomplete="new-password" required></label>
      <button class="bt" type="submit">${obligatorio ? "Guardar y entrar" : "Guardar"}</button>
      <span class="mensaje"></span>
      ${obligatorio ? "" : `<button class="bt bt--fino" type="button" id="volver">Volver sin cambiar</button>`}
    </form>
    <div class="puerta__aviso" style="background:var(--ambar-suave);color:#7A4A00">
      Al menos 8 caracteres, mezclando letras y números. Es suya: nadie más,
      yo incluido, puede verla después de guardada.
    </div>
  </div></div>`;
  const f = document.getElementById("f-clave");
  const volver = document.getElementById("volver");
  if (volver) volver.onclick = () => location.reload();
  f.onsubmit = async ev => {
    ev.preventDefault();
    const m = f.querySelector(".mensaje"), bt = f.querySelector("button[type=submit]");
    if (f.nueva.value !== f.repetir.value) {
      decir(m, "Las dos contraseñas nuevas no coinciden", "error");
      f.repetir.focus(); return;
    }
    decir(m, "Guardando…"); bt.disabled = true;
    try {
      await pedir("/clave", { method: "POST",
        body: JSON.stringify({ actual: f.actual.value, nueva: f.nueva.value }) });
      location.reload();
    } catch (e) { decir(m, e.message, "error"); bt.disabled = false; }
  };
}

async function arrancar() {
  let usuario, quien_borra;
  try {
    ({ usuario, quien_borra } = await pedir("/yo"));
  } catch (e) {
    return pintarIngreso(e.message.includes("Sin sesión") ? "" : e.message);
  }
  if (usuario.debe_cambiar_clave) return pintarCambioClave(usuario, true);

  try {
    estado.usuario = usuario;
    estado.quienBorra = quien_borra || [];
    $("#quien").innerHTML =
      `<b>${esc(usuario.nombre)}</b>${esc(usuario.usuario)} · ${esc(usuario.rol)}`;
    // Los dos botones se inyectan acá y no se escriben en el HTML de cada
    // página: el panel y Personas tienen cada uno su pie, y dos copias de lo
    // mismo terminan separándose. Cambiar la contraseña estuvo hasta el
    // 21-10-2026 solo como pantalla obligatoria del primer ingreso, así que
    // quien ya la había cambiado no tenía cómo volver a hacerlo: el guardia
    // tenía su botón en el pie y la oficina no tenía ninguno.
    $("#quien").insertAdjacentHTML("afterend",
      `<button class="bt bt--fino bt--chico" id="mi-clave" type="button">Cambiar mi contraseña</button>
       <button class="bt bt--fino bt--chico" id="salir" type="button">Cerrar sesión</button>`);
    $("#mi-clave").onclick = () => pintarCambioClave(usuario, false);
    $("#salir").onclick = async () => {
      await pedir("/sesion", { method: "DELETE" }).catch(() => {});
      location.reload();
    };

    const grupos = navegacion();
    const permitidas = grupos.flatMap(g => g.vistas);
    if (!permitidas.length) {
      // Qué decirle a quien entró y no tiene nada que ver acá lo pone cada
      // página: en el panel es «su rol todavía no tiene módulo», y en Personas
      // es «su cuenta no abre esta puerta, vaya al panel», que es otra cosa.
      $("#app").innerHTML = typeof sinNada === "function"
        ? sinNada(usuario)
        : aviso("ojo", "Su cuenta todavía no tiene módulos asignados",
            "Su rol es «" + esc(usuario.rol) + "». El módulo correspondiente aún no está construido.");
      return;
    }
    estado.grupoDe = {};
    for (const g of grupos) for (const v of g.vistas) estado.grupoDe[v] = g.rotulo;
    // La pastilla de selección se vuelve a emitir acá porque este innerHTML se
    // lleva por delante la que trae el HTML.
    $("#pestanas").innerHTML =
      `<div class="lateral__sel" id="lateral-sel" aria-hidden="true"></div>` +
      grupos.map(g =>
        `<div class="lateral__grupo">${esc(g.rotulo)}</div>` +
        g.vistas.map(k =>
          `<button type="button" data-vista="${k}">${esc(VISTAS[k].rotulo)}</button>`).join("")
      ).join("");
    // Un solo oyente en el contenedor: sigue andando si mañana se agrega una
    // sección desde JavaScript. Y no dispara si el dedo venía arrastrando el
    // cajón en vez de apuntándole a un botón.
    $("#pestanas").onclick = ev => {
      const b = ev.target.closest("button[data-vista]");
      if (!b || marco.arrastrando()) return;
      ir(b.dataset.vista);
    };

    // Lo que cada página necesite tener a mano antes de pintar. Va en la
    // página y no acá porque cada una pide lo suyo, y porque cada cosa se pide
    // solo si la cuenta puede pedirla: una cuenta de solo RRHH no tiene acceso
    // a /catalogos, y pedirlo igual la dejaba sin entrar.
    if (typeof precargar === "function") await precargar(usuario);
    ir(permitidas[0]);
  } catch (e) {
    $("#app").innerHTML = aviso("mal", "No se pudo entrar", e.message);
  }
}
