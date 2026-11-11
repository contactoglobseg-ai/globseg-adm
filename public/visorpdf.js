/**
 * Muestra un PDF hoja por hoja, dentro de la página.
 *
 * Lo cargan **las dos pantallas** —Personas y el libro de asistencia—, como
 * `firma.js`: el guardia lee el documento de prevención en su teléfono y la
 * oficina lo mira antes de mandarlo, y es el mismo papel.
 *
 * Por qué se dibuja y no se mete en un marco:
 *
 *  - En el iPhone, un `<iframe>` con un PDF adentro muestra **la primera hoja
 *    y nada más**: no deja desplazarse. Un IRL de tres hojas quedaría firmado
 *    habiendo visto una, que es justo lo que el documento existe para evitar.
 *  - `X-Frame-Options: DENY` protege a todo el sistema de ir dentro de un
 *    marco, y hacerle una excepción a esta respuesta para poder embeberla
 *    sería aflojar eso por una pantalla.
 *  - Dibujando se sabe cuántas hojas son y se puede rotular cada una, que es
 *    lo que convierte «firmé un PDF» en «leí tres hojas».
 *
 * pdf.js va servido desde el propio dominio (`/pdfjs/`) y no desde cdnjs: su
 * worker se crea con `new Worker(url)` y un worker de otro origen no se puede
 * crear. Son 1,4 MB que **solo se bajan cuando alguien abre un documento que
 * llegó como archivo**; quien nunca firma uno no los descarga jamás.
 */
window.VisorPdf = (function () {
  const RUTA = '/pdfjs/pdf.min.js';
  const WORKER = '/pdfjs/pdf.worker.min.js';

  /* Tope de nitidez. En un teléfono con pantalla de 3x, una hoja carta a 3x
     son unos 25 MB de mapa de bits por hoja: con cinco hojas el navegador se
     queda sin memoria y la pestaña muere en silencio. A 2x se lee igual. */
  const NITIDEZ_MAX = 2;

  let cargando = null;

  /* La proporción del recuadro de firma: tres de ancho por uno de alto, que es
     como queda un trazo hecho con el dedo en el lienzo de `firma.js`. El alto
     no se marca aparte a propósito: dejar estirar los dos lados por separado
     solo permite deformar la firma. */
  const PROPORCION = 1 / 3;
  const ANCHO_POR_OMISION = 0.22;

  /* El estilo viaja con el visor y no en `panel.css`, porque lo usan dos
     páginas que no comparten hoja de estilo: el libro de asistencia tiene la
     suya. Escribirlo en los dos `<style>` sería la clase de copia que después
     se separa sola. Usa los tokens de `apariencia.css`, así que sigue el tema
     claro, oscuro y el tamaño de letra como el resto. */
  const ESTILO = `
.visor{display:flex;flex-direction:column;gap:14px;margin:0 0 4px}
.visor__hoja{border:1px solid var(--borde);border-radius:var(--r-s);overflow:hidden;
  background:#fff}
.visor__rotulo{font-size:.74rem;color:var(--texto-3);padding:5px 9px;
  background:var(--sup-2);border-bottom:1px solid var(--borde)}
.visor__hoja canvas{display:block}
.visor__cargando,.visor__error{font-size:.85rem;color:var(--texto-2);margin:0;padding:10px 0}
.visor__error a{color:var(--acento)}
/* La hoja es el marco de referencia de las marcas: van en porcentaje de su
   tamaño, así que se ven en el mismo sitio con cualquier zoom y en cualquier
   pantalla. */
.visor__papel{position:relative;line-height:0}
.visor__papel--marcando{cursor:crosshair}
.visor__marca{position:absolute;border:2px solid var(--acento);border-radius:4px;
  background:color-mix(in srgb,var(--acento) 12%,transparent);
  display:flex;align-items:flex-end;justify-content:space-between;gap:4px;
  padding:3px 4px;box-sizing:border-box}
/* El rotulo cuelga del borde de arriba y no se mete adentro: un recuadro de
   texto mide dos milimetros de alto y el nombre no cabria. Sin eventos de
   puntero, para que tocar el rotulo marque la hoja en vez de esquivarlo.
   Ojo: este bloque es una plantilla de texto y un acento grave aca la cierra. */
.visor__marca span{position:absolute;bottom:100%;left:-2px;margin-bottom:2px;
  font:600 .66rem var(--cuerpo);color:var(--acento);pointer-events:none;
  background:var(--sup);border-radius:3px;padding:0 4px;line-height:1.4;white-space:nowrap}
.visor__marca button{font:600 .68rem var(--cuerpo);color:var(--rojo);background:var(--sup);
  border:0;border-radius:3px;padding:1px 5px;cursor:pointer;line-height:1.3}`;

  function estilar() {
    if (document.getElementById('visor-pdf-estilo')) return;
    const e = document.createElement('style');
    e.id = 'visor-pdf-estilo';
    e.textContent = ESTILO;
    document.head.appendChild(e);
  }

  function cargar() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (cargando) return cargando;
    cargando = new Promise((listo, falla) => {
      const s = document.createElement('script');
      s.src = RUTA;
      s.onload = () => {
        if (!window.pdfjsLib) return falla(new Error('No se pudo cargar el lector de PDF.'));
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;
        listo(window.pdfjsLib);
      };
      s.onerror = () => falla(new Error('No se pudo cargar el lector de PDF.'));
      document.head.appendChild(s);
    });
    return cargando;
  }

  /**
   * Dibuja el PDF de `url` dentro de `caja`.
   *
   * Devuelve cuántas hojas tiene. Si algo falla, deja escrito en la caja qué
   * pasó y un enlace para abrirlo aparte: que no se pueda dibujar no puede
   * dejar a la persona sin poder leer lo que va a firmar.
   */
  async function dibujar(caja, url, opciones) {
    return pintar(caja, url, async () => {
      const resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) throw new Error('No se pudo bajar el documento (' + resp.status + ').');
      return new Uint8Array(await resp.arrayBuffer());
    }, opciones);
  }

  /**
   * Lo mismo, pero con un archivo que la persona acaba de elegir en su
   * computador. Es la vista previa de antes de mandarlo: el PDF todavía no ha
   * salido de ahí, así que no hay nada que bajar.
   */
  async function dibujarArchivo(caja, archivo, opciones) {
    return pintar(caja, null, async () => new Uint8Array(await archivo.arrayBuffer()),
                  opciones);
  }

  /**
   * `opciones` sirve para marcar dónde va la firma:
   *   marcas    [{pagina,x,y,ancho}] — lo que ya está marcado, en proporción
   *   alMarcar  fn(pagina, x, y)     — un clic en una hoja
   *   alQuitar  fn(indice)           — la cruz de un recuadro
   * Sin `alMarcar` el documento solo se lee, que es como lo abre el guardia.
   */
  async function pintar(caja, url, traer, opciones) {
    const op = opciones || {};
    estilar();
    caja.classList.add('visor');
    caja.innerHTML = '<p class="visor__cargando">Abriendo el documento…</p>';
    let lib;
    try {
      lib = await cargar();
    } catch (e) {
      return fallo(caja, url, e.message);
    }
    try {
      const datos = await traer();
      const doc = await lib.getDocument({ data: datos }).promise;

      caja.innerHTML = '';
      const ancho = Math.max(240, caja.clientWidth || 320);
      const nitidez = Math.min(window.devicePixelRatio || 1, NITIDEZ_MAX);

      for (let n = 1; n <= doc.numPages; n++) {
        const hoja = document.createElement('div');
        hoja.className = 'visor__hoja';
        const rotulo = document.createElement('div');
        rotulo.className = 'visor__rotulo';
        rotulo.textContent = `Hoja ${n} de ${doc.numPages}`;
        const papel = document.createElement('div');
        papel.className = 'visor__papel' + (op.alMarcar ? ' visor__papel--marcando' : '');
        const lienzo = document.createElement('canvas');
        papel.appendChild(lienzo);
        hoja.appendChild(rotulo);
        hoja.appendChild(papel);
        caja.appendChild(hoja);

        marcasDe(papel, n, op);
        if (op.alMarcar) {
          papel.onclick = (e) => {
            // Donde se hizo clic, en proporción del tamaño de la hoja, y
            // centrado: lo que la persona apunta es el medio del recuadro, no
            // su esquina.
            const r = papel.getBoundingClientRect();
            const ancho = op.ancho || ANCHO_POR_OMISION;
            const alto = ancho * proporcionDe(op.tipo, ancho) * (r.width / r.height);
            op.alMarcar(n,
              Math.min(1 - ancho, Math.max(0, (e.clientX - r.left) / r.width - ancho / 2)),
              Math.min(1 - alto, Math.max(0, (e.clientY - r.top) / r.height - alto / 2)));
          };
        }

        const pagina = await doc.getPage(n);
        const natural = pagina.getViewport({ scale: 1 });
        const escala = (ancho / natural.width) * nitidez;
        const vista = pagina.getViewport({ scale: escala });
        lienzo.width = Math.floor(vista.width);
        lienzo.height = Math.floor(vista.height);
        // El canvas se dibuja a la nitidez de la pantalla y se muestra al
        // ancho de la caja: sin esto, en un teléfono se vería borroso.
        lienzo.style.width = '100%';
        lienzo.style.height = 'auto';
        await pagina.render({ canvasContext: lienzo.getContext('2d'), viewport: vista }).promise;
      }
      return doc.numPages;
    } catch (e) {
      return fallo(caja, url, e.message || 'No se pudo abrir el documento.');
    }
  }

  /** Los recuadros de esta hoja, encima del canvas. */
  /**
   * Qué alto tiene el recuadro, como fracción de su ancho.
   *
   * La firma es un trazo y ocupa alto; el nombre, el RUT y la fecha son una
   * línea de texto y un recuadro alto los haría apuntar a cualquier parte.
   * Son los mismos números que usa el PDF al sellar, y tienen que seguir
   * siéndolo: lo que se ve al marcar es lo que sale impreso.
   */
  function proporcionDe(tipo, ancho) {
    if (!tipo || tipo === 'firma') return PROPORCION;
    // **El alto de un texto no sigue a su ancho.** Si lo siguiera, dos campos
    // tocados a la misma altura pero de distinto ancho —«Nombre» es más largo
    // que «RUT»— saldrían en renglones distintos, porque lo que se guarda es
    // el borde de arriba del recuadro. Con el alto fijo, tocar a la misma
    // altura deja los dos en la misma línea, que es lo que pide un formulario.
    return ALTO_TEXTO / Math.max(0.01, Number(ancho) || ANCHO_POR_OMISION);
  }

  /** Alto de un recuadro de texto, en fracción del ANCHO de la hoja. */
  const ALTO_TEXTO = 1 / 40;

  const ROTULOS = { firma: 'Firma', nombre: 'Nombre', rut: 'RUT', fecha: 'Fecha',
                    instructor: 'Instructor' };

  function marcasDe(papel, pagina, op) {
    (op.marcas || []).forEach((m, i) => {
      if (Number(m.pagina) !== pagina) return;
      const caja = document.createElement('div');
      caja.className = 'visor__marca';
      const ancho = Number(m.ancho) || ANCHO_POR_OMISION;
      caja.style.left = (m.x * 100) + '%';
      caja.style.top = (m.y * 100) + '%';
      caja.style.width = (ancho * 100) + '%';
      // El alto se calcula del ancho **en píxeles**, porque el porcentaje de
      // alto se mide contra la hoja y una hoja no es cuadrada.
      caja.style.aspectRatio = String(1 / proporcionDe(m.tipo, ancho));
      const rotulo = document.createElement('span');
      rotulo.textContent = ROTULOS[m.tipo] || ROTULOS.firma;
      caja.appendChild(rotulo);
      if (op.alQuitar) {
        const quitar = document.createElement('button');
        quitar.type = 'button';
        quitar.textContent = 'Quitar';
        quitar.onclick = (e) => { e.stopPropagation(); op.alQuitar(i); };
        caja.appendChild(quitar);
      }
      papel.appendChild(caja);
    });
  }

  function fallo(caja, url, mensaje) {
    caja.innerHTML = '<p class="visor__error"></p>';
    const p = caja.firstChild;
    p.textContent = mensaje + ' ';
    // Sin `url` no hay adónde mandar a nadie: es el archivo que la persona
    // acaba de elegir en su propio computador, y ya lo tiene.
    if (url) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Abrir el documento aparte';
      p.appendChild(a);
    }
    return 0;
  }

  return { dibujar, dibujarArchivo, PROPORCION, ANCHO_POR_OMISION, ALTO_TEXTO, proporcionDe, ROTULOS };
})();
