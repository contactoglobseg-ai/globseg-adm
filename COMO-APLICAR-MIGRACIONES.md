# Cómo se aplican las migraciones (y qué hacer ahora)

Esto reemplaza a "la integración de Supabase las corre sola", que dejó de ser
cierto el 14-10-2026.

## Lo primero: hoy RRHH no existe en la base

`https://adm.seggarridos.com/api/diagnostico` responde, al 18-10-2026:

```
contratos: false          tipos_documento: false     ficha_rrhh: false
documentos_trabajador: false  parametros_rrhh: false  v_personal: false
ausencias: false          afps: false                v_documentos: false
                          tramos_impuesto: false     bucket_documentos: false
```

El módulo de Recursos Humanos está desplegado en el Worker y **no tiene ni una
tabla detrás**. Las dos migraciones que lo crean —`20261015170000_rrhh.sql` y
`20261015200000_archivos_rrhh.sql`— nunca se aplicaron. Quien entre a las
pestañas de RRHH se va a encontrar con errores, no con pantallas vacías.

Es exactamente el problema que esto viene a resolver, otra vez: el código subió,
la base no, y nada avisó.

## Los tres pasos

### 1. Reparar el historial (hay que hacerlo antes que nada)

Las migraciones que se pegaron a mano en el SQL Editor quedaron en la base pero
**no** en `supabase_migrations.schema_migrations`, que es la libreta donde
Supabase anota lo que ya aplicó. Para cualquier herramienta, esas migraciones
siguen pendientes.

Si se lanza `supabase db push` con la libreta así, intenta correr la historia
entera desde el principio y se estrella en la primera:

```
ERROR:  cannot drop columns from view
```

(Comprobado, no es una suposición: `20261012120000_inicial.sql` trae un
`create or replace view v_ciclos`, y desde que `20261013120000_estado_pago.sql`
le agregó columnas a `ciclos`, esa vista ya no se puede reemplazar.)

**Qué hacer:** abrir el SQL Editor del panel de Supabase y pegar entero
`supabase/reparar-historial.sql`. Anota como aplicada cada migración, pero solo
después de comprobar en el catálogo que lo que esa migración crea está
realmente en la base — no se cree una lista escrita a mano, mira. Se puede
correr las veces que sea.

Al terminar muestra la lista. Hoy tiene que dar **16 filas**, de `inicial` a
`limite_contacto`, y las dos de RRHH NO deben aparecer: son justamente las que
falta aplicar.

### 2. Elegir quién las aplica de ahora en adelante

Son dos caminos y hay que tomar **uno solo**. Los dos corriendo a la vez se
pisan.

**a) Arreglar la integración de Supabase.** En
`https://supabase.com/dashboard/project/hjoljdjjsobweqbvlijr` →
Settings → Integrations → GitHub. Qué mirar:

- ¿La conexión con `contactoglobseg-ai/globseg-adm` sigue ahí, o se cayó?
- ¿Qué rama mira? Tiene que ser `main`.
- ¿Hay un historial de corridas con errores? Si hay un error, ahí está la
  respuesta a por qué dejó de aplicar.
- Si pide un plan de pago para aplicar migraciones a la base de producción
  (va junto con Branching), ese es el motivo y no se arregla apretando nada.

En GitHub, en `https://github.com/organizations/contactoglobseg-ai/settings/installations`:
¿sigue instalada la GitHub App de Supabase y con acceso a `globseg-adm`?

Hasta hoy el repositorio **no tenía `supabase/config.toml`**, que es el archivo
por el que la CLI y la integración reconocen la carpeta como un proyecto de
Supabase. Ya quedó agregado, con el identificador del proyecto y nada más.

**b) GitHub Actions** (`.github/workflows/migraciones.yml`, ya está escrito).
Corre en cada push a `main` que toque `supabase/migrations/`, y también a mano.
La diferencia que importa: **cuando falla se ve**. El commit queda con una marca
roja y GitHub manda correo a quien hizo el push. Lo anterior fallaba callado.

Para que funcione hay que crear **un secreto** en
`https://github.com/contactoglobseg-ai/globseg-adm/settings/secrets/actions`:

- Nombre: `SUPABASE_DB_URL`
- Valor: la cadena de conexión que entrega el panel de Supabase en el botón
  **Connect**, pestaña **Session pooler**, con la contraseña de la base puesta
  donde dice `[YOUR-PASSWORD]`.

Dos cuidados con esa cadena, que es donde se pierde la tarde:

- Tiene que ser la del **pooler**, no la conexión directa. Las máquinas de
  GitHub Actions no tienen IPv6, y la conexión directa de los proyectos nuevos
  de Supabase solo responde por IPv6.
- Puerto **5432** (session), no 6543 (transaction). El de transacciones no
  aguanta todo lo que hace una migración.

### 3. Aplicar lo que falta y comprobar

Con el historial reparado y el secreto puesto: en GitHub, pestaña **Actions** →
**Migraciones** → **Run workflow**. Eso aplica las dos de RRHH.

Después, mirar otra vez
`https://adm.seggarridos.com/api/diagnostico`: `contratos`, `tipos_documento`,
`ficha_rrhh`, `v_personal`, `v_documentos` y `documentos_con_archivo` tienen que
haber pasado a `true`.

`bucket_documentos` es aparte: va en la misma migración pero por otro camino
(Storage, no la base). Si queda en `false`, hay que crear el bucket privado
`documentos-rrhh` desde el panel.

Las dos migraciones de RRHH se probaron contra una réplica local con exactamente
el estado que hoy tiene producción, y entran limpias las dos.

## La regla que queda

Toda migración se escribe para poder correrse dos veces sin romper nada:
`create table if not exists`, `add column if not exists`, `on conflict do
nothing`, y `drop view if exists` antes de cada `create view` —nunca
`create or replace view`, que no sabe quitar ni reordenar columnas—. Hoy las 18
cumplen, salvo `20261012120000_inicial.sql`, que es anterior a la regla y se
deja así: solo molesta si alguien reaplica la historia completa.

Esa disciplina es lo que hace que reparar el historial sea seguro, y lo que hizo
que pegarlas a mano en octubre no dejara la base a medias.
