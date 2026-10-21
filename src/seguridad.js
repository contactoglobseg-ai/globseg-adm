/**
 * Lo que el navegador tiene que recibir en cada respuesta.
 *
 * Hasta el 15-10-2026 el Worker contestaba igual por http que por https: la
 * página de ingreso, con su campo de contraseña, se entregaba en claro. Safari
 * marca eso como conexión no segura, no autocompleta la clave desde el llavero
 * y avisa antes de dejar escribirla; de ahí venía el «no me deja entrar».
 * El problema de fondo no es el aviso: por http la contraseña y la cookie de
 * sesión viajan a la vista de cualquiera en la misma red.
 *
 * Por eso acá hay dos cosas:
 *  - `redireccionHttps`, que no deja que una petición en claro llegue a ver
 *    nada, y la cabecera HSTS, que le dice al navegador que no vuelva a
 *    intentarlo en claro nunca más (ni siquiera la primera petición).
 *  - `cabecerasSeguridad`, que acota lo que la página puede cargar y ejecutar.
 */

// Un año. Sin `preload`: entrar a la lista de los navegadores es un camino de
// ida y obliga a mantener https en todo seggarridos.com para siempre.
const HSTS = 'max-age=31536000; includeSubDomains';

/** En pruebas locales se trabaja por http y no hay nada que proteger. */
const esLocal = (host) =>
  host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');

/**
 * El esquema que usó el visitante. Detrás de Cloudflare la petición llega al
 * Worker tal como vino, así que `url.protocol` alcanza; `cf-visitor` se mira
 * igual por si algún día hay un proxy delante que termine el TLS antes.
 */
function enClaro(request, url) {
  const host = url.hostname.toLowerCase();
  if (esLocal(host)) return false;
  const visitante = request.headers.get('cf-visitor') || '';
  if (visitante.includes('"scheme":"http"')) return true;
  return url.protocol === 'http:';
}

/**
 * Devuelve la redirección a https, o null si la petición ya venía segura.
 *
 * 301 y no 302: es permanente y el navegador se la guarda, así que la próxima
 * vez ni siquiera sale a la red en claro.
 */
export function redireccionHttps(request, url) {
  if (!enClaro(request, url)) return null;
  const destino = new URL(url);
  destino.protocol = 'https:';
  return new Response(null, {
    status: 301,
    headers: { location: destino.toString(), 'strict-transport-security': HSTS },
  });
}

// La política de contenido del panel. Cada permiso está porque algo lo usa:
// las tipografías de Google, y jsPDF y SheetJS desde cdnjs para la cotización
// en PDF y el libro de asistencia en Excel. `blob:` es el archivo que esas dos
// arman en el navegador antes de entregarlo.
const CSP_PANEL = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Ni el libro de asistencia ni la ficha de ingreso cargan nada de afuera: ni
// tipografías ni librerías. Se les deja la política más corta que aguanta, que
// además son las dos páginas que se abren desde un teléfono en cualquier red.
// La ficha de ingreso es, encima, la única página de todo el sistema que se
// entrega sin sesión: lo que ahí se escribe es el RUT, la dirección y la
// cuenta bancaria de una persona, y no hay un solo origen de fuera que tenga
// por qué estar en el medio.
const CSP_CERRADA = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Cabeceras para la página. `frame-ancestors 'none'` y X-Frame-Options dicen
 * lo mismo para navegadores nuevos y viejos: el panel no se muestra dentro de
 * otro sitio, que es como se engaña a alguien para que haga clic donde no cree.
 *
 * `pagina` es cuál de las cuatro se está sirviendo, no en qué dominio: el libro
 * de asistencia también vive en adm.seggarridos.com/asistencia, y si esto
 * mirara el dominio, por ese camino quedaría con geolocation=() y el guardia
 * no podría registrar dónde marcó. La ficha de ingreso se sirve igual en todos
 * los dominios.
 *
 * Personas ('rrhh') se lleva la política del panel y no la cerrada: baja
 * planillas con SheetJS y emite PDF con jsPDF, los dos desde cdnjs, y con la
 * cerrada esos dos botones quedarían muertos. Geolocalización no pide, así que
 * la tiene en () como el panel.
 */
export function cabecerasSeguridad(pagina = 'panel') {
  const cerrada = pagina === 'asistencia' || pagina === 'ficha';
  return {
    'strict-transport-security': HSTS,
    'content-security-policy': cerrada ? CSP_CERRADA : CSP_PANEL,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    // La asistencia sí pide ubicación: es la que marca dónde se tomó el turno.
    // La ficha de ingreso no la pide, y por eso tampoco la tiene.
    'permissions-policy': pagina === 'asistencia'
      ? 'geolocation=(self), microphone=(), camera=(), interest-cohort=()'
      : 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
  };
}

/**
 * Agrega `no-transform` al `cache-control` que ya traiga la respuesta.
 *
 * Cloudflare reescribe el HTML al vuelo para meterle la baliza de Web
 * Analytics, y las dos CSP de acá arriba la bloquean —la de asistencia a
 * propósito, porque esa página no carga nada de afuera—. El resultado era un
 * error rojo en la consola en cada carga, de algo que además nunca iba a
 * funcionar. `no-transform` le dice que no toque la respuesta, y entonces no
 * hay nada que bloquear.
 *
 * Se **agrega** en vez de reemplazar: el servidor de archivos entrega las
 * páginas con `public, max-age=0, must-revalidate`, y escribir encima un
 * `public, no-transform` pelado quitaría el `must-revalidate`. Sin él, el
 * navegador puede quedarse con la página vieja por su cuenta, y un despliegue
 * dejaría de llegarle a quien ya la tenía abierta.
 */
function sinTransformar(cacheControl) {
  if (!cacheControl) return 'no-transform';
  if (/(^|,)\s*no-transform\s*($|,)/i.test(cacheControl)) return cacheControl;
  return cacheControl + ', no-transform';
}

/**
 * Copia una respuesta agregándole las cabeceras, sin tocar su cuerpo.
 *
 * Solo lo usan las páginas: la API arma sus propias respuestas con
 * `cache-control: no-store` y no pasa por acá.
 */
export function conCabeceras(respuesta, cabeceras) {
  const r = new Response(respuesta.body, respuesta);
  for (const [k, v] of Object.entries(cabeceras)) r.headers.set(k, v);
  r.headers.set('cache-control', sinTransformar(r.headers.get('cache-control')));
  return r;
}

/**
 * Solo la cabecera HSTS, para las respuestas de la API, que no son páginas y
 * no necesitan el resto. Importa igual: si alguien llama a la API por http una
 * sola vez, el navegador ya no vuelve a intentarlo en claro.
 */
export const soloHttps = () => ({ 'strict-transport-security': HSTS });
