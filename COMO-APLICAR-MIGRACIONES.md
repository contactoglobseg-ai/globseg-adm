# Cómo se aplican las migraciones (y qué hacer ahora)

Esto reemplaza a "la integración de Supabase las corre sola", que dejó de ser
cierto el 14-10-2026.

> **Ni la integración de Supabase ni el workflow de Actions están aplicando
> nada.** Comprobado con un push de verdad el 20-10-2026: el Worker se desplegó
> en menos de un minuto y tres minutos después las tablas nuevas seguían en
> `false`. Toda migración hay que pegarla a mano en el SQL Editor hasta que se
> haga el paso 2 de esta guía.

## Qué falta hoy (21-10-2026, recién consultado)

RRHH y la ficha de ingreso **ya están aplicadas**: alguien las pegó entre el 18
y el 20, y `/api/diagnostico` responde `true` en todas sus tablas y vistas.

Falta **una sola migración**, la del módulo de documentos y firma con el dedo
(`20261020180000_documentos_firma.sql`). Estas siete están en `false`:

```
plantillas_documento        documentos_generados    datos_empresa
bloques_plantilla           firmas_documento        v_documentos_generados
instalaciones_con_direccion
```

**Para pegarla no hay que buscar nada:** está lista y con su cabecera en
`CORRER-EN-SUPABASE-21-10-2026.sql`, en la carpeta de la empresa, un nivel
arriba de esta. Se copia entera al portapapeles con:

```bash
pbcopy < "/Users/macbookpro/Desktop/EMPRESAS/Seguridad Garridos/CORRER-EN-SUPABASE-21-10-2026.sql"
```

y se pega en
`https://supabase.com/dashboard/project/hjoljdjjsobweqbvlijr/sql/new`.
Se puede correr las veces que sea.

Mientras no se pegue, el panel avisa en la pantalla de Documentos con el nombre
del archivo y **todo lo demás sigue andando igual**, incluido marcar turno.

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

Al terminar muestra la lista. Al 21-10-2026 tiene que dar **19 filas**, de
`inicial` a `ficha_ingreso`, y `documentos_firma` NO debe aparecer: es
justamente la que falta aplicar. (Si se pega antes el SQL de más arriba, serán
20 y no faltará ninguna.)

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
**Migraciones** → **Run workflow**. Eso aplica lo que falte — hoy,
`documentos_firma`, si no se pegó antes a mano.

Después, mirar otra vez
`https://adm.seggarridos.com/api/diagnostico`: las siete de la lista de arriba
tienen que haber pasado a `true`.

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
