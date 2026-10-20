-- Pone al día el historial de migraciones de Supabase. Se pega entero en el
-- SQL Editor del panel. Se puede correr las veces que sea.
--
-- Por qué hace falta: las migraciones que se pegaron a mano en el SQL Editor
-- entre el 14 y el 15 de octubre quedaron en la base, pero NO en la tabla
-- `supabase_migrations.schema_migrations`, que es donde Supabase anota lo que
-- ya aplicó. Para la CLI siguen pendientes. Si se lanza `supabase db push`
-- con el historial así, intenta correr toda la historia desde el principio y
-- se estrella en `20261012120000_inicial.sql`, que trae un
-- `create or replace view v_ciclos` y ya no puede reemplazar esa vista desde
-- que `20261013120000_estado_pago.sql` le agregó columnas a `ciclos`.
--
-- Qué hace: anota como aplicada cada migración, PERO solo si comprueba en el
-- catálogo que lo que esa migración crea está realmente en la base. No se cree
-- una lista escrita a mano; mira. Así no puede marcar como aplicada una que no
-- lo esté y dejarla sin correr para siempre, que es el único daño posible acá.
--
-- Al 18-10-2026 esto deja las 16 primeras anotadas y las dos de RRHH
-- pendientes, que es lo correcto: RRHH no está en producción.

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version    text primary key,
  statements text[],
  name       text
);

do $$
declare m record;
begin
  for m in
    select * from (values
      -- version,          nombre,                 ¿está en la base?
      ('20261012120000', 'inicial',            to_regclass('public.servicios')  is not null),
      ('20261012160000', 'cerrar_vistas',      to_regclass('public.v_ciclos')   is not null),
      ('20261012170000', 'usuarios',           to_regclass('public.usuarios')   is not null),
      -- Las tres que siguen no crean ningún objeto: dan permisos, rehacen las
      -- claves y corrigen un nombre. Lo único que se puede comprobar es que la
      -- tabla sobre la que operan exista.
      ('20261012190000', 'permisos_servicio',  to_regclass('public.usuarios')   is not null),
      ('20261012210000', 'rehacer_claves',     to_regclass('public.usuarios')   is not null),
      ('20261012220000', 'nombre_sgarridob',   to_regclass('public.usuarios')   is not null),
      ('20261012230000', 'cotizaciones',       to_regclass('public.cotizaciones') is not null),
      ('20261013000000', 'evitar_duplicados',  to_regclass('public.cotizaciones') is not null),
      ('20261013100000', 'contactos',          to_regclass('public.contactos')  is not null),
      -- De acá en adelante son columnas agregadas a tablas que ya existían: la
      -- tabla no sirve de prueba, hay que preguntar por la columna. Son las
      -- mismas comprobaciones que hace /api/diagnostico.
      ('20261013120000', 'estado_pago',        exists (select 1 from information_schema.columns
                                                        where table_schema='public' and table_name='ciclos'
                                                          and column_name='pago_estado')),
      ('20261013160000', 'permiso_borrar',     exists (select 1 from information_schema.columns
                                                        where table_schema='public' and table_name='usuarios'
                                                          and column_name='puede_borrar')),
      ('20261014100000', 'ciclo_mensual',      exists (select 1 from information_schema.columns
                                                        where table_schema='public' and table_name='servicios'
                                                          and column_name='ciclo_tipo')),
      ('20261014190000', 'asistencia',         to_regclass('public.trabajadores') is not null),
      ('20261014210000', 'correccion_marcas',  exists (select 1 from information_schema.columns
                                                        where table_schema='public' and table_name='marcas'
                                                          and column_name='origen')),
      ('20261014230000', 'clave_trabajador',   exists (select 1 from information_schema.columns
                                                        where table_schema='public' and table_name='trabajadores'
                                                          and column_name='debe_cambiar_clave')),
      ('20261015130000', 'limite_contacto',    exists (select 1 from information_schema.columns
                                                        where table_schema='public' and table_name='contactos'
                                                          and column_name='ip_huella')),
      -- Las dos de RRHH van en la lista aunque hoy estén sin aplicar: si
      -- alguien las pega a mano antes de correr esto, quedan anotadas igual.
      ('20261015170000', 'rrhh',               exists (select 1 from information_schema.columns
                                                        where table_schema='public' and table_name='trabajadores'
                                                          and column_name='fecha_ingreso')),
      ('20261015200000', 'archivos_rrhh',      exists (select 1 from information_schema.columns
                                                        where table_schema='public' and table_name='documentos_trabajador'
                                                          and column_name='archivo_ruta'))
    ) as t(version, nombre, aplicada)
  loop
    if m.aplicada then
      insert into supabase_migrations.schema_migrations (version, name)
      values (m.version, m.nombre)
      on conflict (version) do nothing;
    end if;
  end loop;
end $$;

-- `20261013140000_limpiar_instalaciones.sql` se borró del repositorio el
-- 13-10-2026 (sacaba las instalaciones de ejemplo). Si alcanzó a quedar
-- anotada, el historial remoto tiene una versión que ya no existe en el
-- repositorio y `supabase db push` se niega a avanzar hasta que se repare.
-- Se saca del historial; la base no se toca, porque esa migración solo
-- borraba filas que ya no están.
delete from supabase_migrations.schema_migrations where version = '20261013140000';

-- Cómo quedó. Lo que aparezca acá es lo que la CLI va a dar por aplicado, y
-- lo que NO aparezca es lo que el próximo `db push` va a intentar correr.
select version, name
  from supabase_migrations.schema_migrations
 order by version;
