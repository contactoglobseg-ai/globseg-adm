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
.visor__error a{color:var(--acento)}`;

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
  async function dibujar(caja, url) {
    return pintar(caja, url, async () => {
      const resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) throw new Error('No se pudo bajar el documento (' + resp.status + ').');
      return new Uint8Array(await resp.arrayBuffer());
    });
  }

  /**
   * Lo mismo, pero con un archivo que la persona acaba de elegir en su
   * computador. Es la vista previa de antes de mandarlo: el PDF todavía no ha
   * salido de ahí, así que no hay nada que bajar.
   */
  async function dibujarArchivo(caja, archivo) {
    return pintar(caja, null, async () => new Uint8Array(await archivo.arrayBuffer()));
  }

  async function pintar(caja, url, traer) {
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
        const lienzo = document.createElement('canvas');
        hoja.appendChild(rotulo);
        hoja.appendChild(lienzo);
        caja.appendChild(hoja);

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

  return { dibujar, dibujarArchivo };
})();
