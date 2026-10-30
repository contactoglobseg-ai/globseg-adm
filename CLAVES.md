# Las claves del sistema: cuál es cuál

Son **nueve cosas distintas** y se enredan porque todas se llaman "la clave".
Esta página dice qué es cada una, dónde vive, quién la cambia y qué pasa si se
pierde. Ninguna se escribe acá: este archivo es el mapa, no el llavero.

Regla que vale para todas las contraseñas de personas: **el sistema no las
guarda**. Guarda una derivación con PBKDF2-SHA256, que no se puede devolver al
texto original. Nadie puede ver la clave de nadie — ni usted, ni yo, ni quien
consiga una copia de la base. Lo único que se puede hacer con una clave perdida
es reemplazarla.

---

## 1. Su cuenta de la oficina

**Qué abre:** adm.seggarridos.com y rrhh.seggarridos.com (el mismo usuario sirve
en los dos; hay que entrar una vez en cada dominio).

**Dónde vive:** tabla `usuarios` de Supabase, columna `clave`.

**Cuáles hay:** `jgarridoh` (José), `sgarridob` (Seba), `jgarridob` (Joaquín),
`vtorres` (Valeria).

**Clave inicial:** `123321`, con cambio obligatorio al primer ingreso. Mientras
la cuenta siga con ella, el sistema **no deja hacer nada más que cambiarla**.

**Quién la cambia:** cada uno la suya, desde el panel. Hay que saber la actual.

**Si se pierde:** desde el 29-10-2026, **gerencia la restablece** en el panel,
en Sistema → Usuarios → Editar → «Restablecer la contraseña». Sale una temporal
que se muestra **una sola vez** en pantalla y que esa persona tiene que cambiar
al entrar. Ahí mismo se desbloquea una cuenta que se pasó de intentos.

Si quien no puede entrar es la propia gerencia, es la salida de emergencia del
punto 9.

---

## 2. La cuenta del guardia

**Qué abre:** asistencia.seggarridos.com, para marcar entrada y salida y para
firmar documentos.

**Dónde vive:** tabla `trabajadores`. Es **otra tabla a propósito**: un guardia
no puede llegar al panel de la oficina aunque mañana alguien se equivoque en un
permiso.

**Usuario:** lo arma el sistema con la inicial del nombre, el apellido paterno y
la inicial del materno (José Garrido Huinca → `jgarridoh`). No se escribe a mano.

**Clave inicial:** su RUT, con puntos o sin ellos, da lo mismo. También con
cambio obligatorio al primer ingreso: con el RUT puesto el servidor **no deja
marcar turno ni firmar**, porque el RUT lo sabe cualquiera que haya visto una
lista de turnos, y lo que se quiere impedir es que un compañero marque la
entrada por el que todavía no llega.

**Quién la cambia:** el guardia, desde el pie de su pantalla. Si la olvida,
**Joaquín la vuelve al RUT** desde adm.seggarridos.com → Trabajadores → botón
«Clave al RUT». Ahí mismo se desbloquea una cuenta que se pasó de intentos.

La tabla de Trabajadores muestra quién sigue andando con el RUT sin cambiar.
Desde el 29-10-2026 las mismas dos acciones están además en Sistema → Usuarios,
que junta las cuentas de la oficina y las de los guardias en una sola pantalla.

**El bloqueo dura 5 minutos**, no 15 (se bajó el 29-10-2026 por un reporte de
Joaquín: el guardia que cambia su clave, no la guarda en el llavero del teléfono
y la olvida a la semana siguiente es el caso real, y no es un ataque). Y el
aviso de la pantalla **dice por nombre a quién pedirle que se la devuelva**, con
el teléfono de la oficina, que sale de `datos_empresa.telefono_oficina` y se
edita en Documentos → Datos de la empresa.

---

## 3. `SUPABASE_SERVICE_KEY` — la llave del sistema a la base

**Qué es:** la clave con la que el Worker entra a Supabase. Es la única que
entra: la base tiene RLS activo y sin políticas, así que nadie más puede leerla.

**Dónde vive:** secreto del Worker en Cloudflare (Workers → globseg-adm →
Settings → Variables and Secrets). **No está en el repositorio ni en este chat**,
y así tiene que seguir.

**De dónde se saca:** Supabase → Project Settings → API keys → la **secret**
(`sb_secret_…`), no la publishable. Copiarla con el botón de copiar: seleccionar
el texto mostrado se lleva los `•••` de la máscara y el servidor responde
"Invalid API key".

**Si se pierde o se rota:** se genera otra en Supabase y se pega en el secreto de
Cloudflare. Mientras no se haga, el sistema entero queda sin base.

**Cómo saber si la puesta está bien, sin mostrarla:**
https://adm.seggarridos.com/api/diagnostico dice si está presente, si es la
secreta nueva, si es la vieja JWT, si es la pública, si quedó recortada o si
trae caracteres raros.

---

## 4. `SESION_SECRETO` — la firma de las cookies

**Qué es:** el secreto con que se firman las sesiones. No es una contraseña de
nadie: es lo que hace que una cookie no se pueda falsificar.

**Dónde vive:** secreto del Worker en Cloudflare, igual que el anterior.

**Si se cambia:** se cierran **todas** las sesiones abiertas (oficina y guardias)
y **dejan de servir los enlaces de ficha de ingreso** que estén pendientes, hay
que volver a generarlos. Lo que **no** se rompe son los documentos ya firmados:
su hash no depende de este secreto.

---

## 5. La contraseña de la base de datos (Postgres)

**Qué es:** la del usuario `postgres` del proyecto Supabase. El sistema **no la
usa** — el Worker entra con la del punto 3. La necesitan las herramientas que se
conectan directo: `psql`, el CLI de Supabase y el workflow de migraciones.

**Dónde vive:** Supabase → Project Settings → Database. Se puede restablecer ahí.

**Dónde está copiada:** dentro de la cadena del Session pooler, que es lo que va
en el secreto `SUPABASE_DB_URL` de GitHub Actions (si se decide aplicar las
migraciones por ahí). Si se restablece la contraseña, hay que actualizar también
ese secreto.

---

## 6. La cuenta de Supabase

Es la que abre https://supabase.com/dashboard/project/hjoljdjjsobweqbvlijr, donde
está el SQL Editor y donde viven los puntos 3 y 5.

Esa pantalla de **Authentication → Users que sale vacía no es un problema**: el
sistema no usa el login de Supabase, usa el propio. Esa lista va a estar siempre
vacía y está bien así.

## 7. La cuenta de Cloudflare

Es la que abre el panel donde viven los secretos del Worker (puntos 3 y 4), los
dominios y los certificados.

## 8. La cuenta de GitHub `contactoglobseg-ai`

Guarda el código de los dos repositorios (`globseg-adm` y `globseg-web`). El
acceso desde este Mac es por **llave SSH ed25519** en `~/.ssh`, no por
contraseña. Si se cambia de computador hay que generar otra llave y cargar la
pública en GitHub.

---

## 9. Salida de emergencia: cuando nadie puede entrar

Para una cuenta de **oficina** sin forma de entrar, porque se olvidó la clave o
porque se bloqueó y no hay nadie adentro que la desbloquee:

```
cd "ADMINISTRACION"
node supabase/restablecer-clave.mjs vtorres
```

Inventa una clave temporal, **la muestra una sola vez en la consola** y deja un
archivo `.sql` listo para pegar en el
[SQL Editor de Supabase](https://supabase.com/dashboard/project/hjoljdjjsobweqbvlijr/sql/new).
Ese SQL desbloquea la cuenta y la deja **obligada a cambiar la clave al entrar**,
así que la temporal sirve para un solo ingreso.

La clave la inventa él y no se la pide a nadie a propósito: una clave tecleada
en un chat o mandada por correo queda ahí para siempre. El archivo `.sql` lleva
solo la derivación, de la que no se vuelve, y está en el `.gitignore` para que
no se suba al repositorio. Péguelo y bórrelo.

El script **deriva la clave con el código del propio Worker** (`src/sesion.js`),
no con una copia: si mañana cambia la forma de guardar las contraseñas, esto
cambia con ella. Y comprueba el hash antes de escribir nada, porque uno que la
plataforma no sepa leer dejaría esa cuenta sin poder entrar nunca.

No se puede hacer con un `update` a mano: la columna `clave` no guarda texto,
guarda la derivación, y un texto suelto deja la cuenta sin poder entrar.

**Para un guardia no hace falta esto**: su clave la vuelve al RUT Joaquín desde
el panel, en Trabajadores. Esta salida es para cuando no se puede entrar ni
siquiera al panel.

**Desde el 29-10-2026 hay además un camino sin consola**, que es el que sirve
cuando no se tiene el computador con el repositorio a mano. Todo desde el SQL
Editor de Supabase, copiando y pegando una línea:

```sql
select desbloquear_cuenta('jgarridoh');              -- solo estaba bloqueada
select restablecer_clave('jgarridoh', 'Temporal2026'); -- olvidó la contraseña
select restablecer_clave_al_rut('pgonzalezm');        -- un guardia, de vuelta a su RUT
```

Sirven igual para las dos clases de cuenta y dejan la cuenta obligada a cambiar
la clave al entrar. **Escriben la derivación en el mismo formato que el Worker
verifica** —comprobado contra `claveCorrecta` de `src/sesion.js`, byte a byte—,
que es lo que un `update` a mano no puede hacer.

Los pasos completos, con lo que se mira antes y después, están en
`supabase/USUARIOS-DESDE-SUPABASE.md`. Ahí se explica también **por qué
Authentication → Users de Supabase está vacío y va a seguir estándolo**: el
ingreso de este sistema es propio y la lista de verdad es la vista `v_cuentas`,
que se abre en Table Editor como cualquier tabla.

**Para ver cómo está cada cuenta** sin tocar nada —quién sigue con la clave
inicial, quién está bloqueado, quién no ha entrado nunca— están esa vista
`v_cuentas` y, desde antes, `supabase/revisar-claves.sql` en el SQL Editor.

---

## Lo que hay que hacer y está pendiente

- [ ] **Cambiar la clave `123321`** en las cuentas de oficina que todavía no la
      hayan cambiado: quedó escrita en el historial del chat. La consulta de
      arriba dice cuáles son.
- [x] **Botón para restablecer la contraseña de otra cuenta de oficina**
      (29-10-2026): lo hace gerencia en Sistema → Usuarios, y queda en la
      bitácora. La contraseña temporal **no** entra a la bitácora: ahí quedaría
      escrita en claro.
- [ ] Confirmar el **teléfono de la oficina** que se le muestra al guardia
      cuando su cuenta queda bloqueada. Hoy está el público (+56 9 8988 7614) y
      marcado como por confirmar, en Documentos → Datos de la empresa.
