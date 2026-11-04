-- Dependencias: los lugares separados que cuelgan de una instalación.
--
-- Salió el 04-11-2026, con la rotación recién pegada y todavía sin usar. El
-- gerente lo dijo así: «dentro de una instalación existen varias dependencias
-- y dentro de estas son las rotaciones». Copec RM no es un parque: es el
-- contrato, y adentro hay cuatro parques con su propia dirección y comuna,
-- entre los que la patrulla rota.
--
-- Lo que eso fija, y es lo que decide toda la forma de esto:
--  · **Lo que se cobra sigue siendo la instalación.** El estado de pago y el
--    F30-1 son de Copec RM entera, con toda su gente junta. La dependencia no
--    parte la carpeta.
--  · **El guardia pertenece a la instalación**, no a una dependencia: su
--    contrato dice Copec RM y la dependencia le cambia cada día. Por eso
--    `trabajadores.instalacion_id` NO se toca.
--  · **La rotación reparte dependencias**, no instalaciones. Es el único
--    lugar del sistema donde la dependencia manda.
--
-- Por qué una tabla nueva y no una columna `padre_id` en `instalaciones`: con
-- jerarquía adentro, cada pantalla que hoy lista instalaciones tendría que
-- acordarse de filtrar las hijas, y la que se olvide ofrece cobrarle un
-- servicio a un parque suelto o asignarle un trabajador. Son diez pantallas y
-- bastaría que una fallara. Separadas, lo que no sabe de dependencias sigue
-- viendo exactamente lo que veía.
--
-- Se puede correr las veces que sea.

create table if not exists dependencias (
  id             bigint generated always as identity primary key,
  instalacion_id bigint not null references instalaciones (id) on delete restrict,
  nombre         text not null,

  -- Cada una tiene la suya: son lugares separados y hay que trasladarse.
  direccion      text,
  comuna         text,
  region         text,

  activa         boolean not null default true,
  notas          text,
  creado_por     text,
  creado_en      timestamptz not null default now(),

  constraint dependencia_nombre_no_vacio check (length(trim(nombre)) > 0)
);

-- Dos dependencias con el mismo nombre en la misma instalación son la misma
-- contada dos veces, y la rotación empieza a mandar gente a la que no es.
create unique index if not exists dependencias_nombre_unico
  on dependencias (instalacion_id, lower(trim(nombre)));
create index if not exists dependencias_por_instalacion
  on dependencias (instalacion_id);

-- ------------------------------------------- la rotación pasa a ser de una
-- Queda nulable a propósito: si quedó una rotación de antes sin ningún punto
-- cargado, no hay de dónde deducir su instalación, y una migración que falla
-- por un dato viejo deja la base a medias. El servidor sí la exige al crear.
alter table rotaciones add column if not exists instalacion_id bigint
  references instalaciones (id) on delete restrict;

-- --------------------------------------- los puntos pasan a ser dependencias
alter table rotacion_puntos add column if not exists dependencia_id bigint
  references dependencias (id) on delete cascade;
alter table rotacion_dias add column if not exists dependencia_id bigint
  references dependencias (id) on delete restrict;

-- La vista vieja lee `rotacion_dias.instalacion_id`, así que mientras exista
-- Postgres no deja soltar esa columna («cannot drop column ... because other
-- objects depend on it»). Se cae acá y se rehace al final. Comprobado contra
-- la base, no deducido.
drop view if exists v_rotacion_dias;

-- Lo que hubiera cargado antes se convierte en vez de perderse: cada
-- instalación que la rotación estuviera usando pasa a ser una dependencia de
-- sí misma, que es exactamente lo que era. Si no hay nada cargado —que es el
-- caso el 04-11, con la migración recién pegada— esto no hace nada.
do $$
declare
  hay_viejo boolean;
begin
  select exists (select 1 from information_schema.columns
                  where table_name = 'rotacion_puntos' and column_name = 'instalacion_id')
    into hay_viejo;
  if not hay_viejo then return; end if;

  -- la instalación de cada rotación: la del primero de sus puntos
  execute $sql$
    update rotaciones r set instalacion_id = (
      select p.instalacion_id from rotacion_puntos p
       where p.rotacion_id = r.id and p.instalacion_id is not null limit 1)
     where r.instalacion_id is null $sql$;

  execute $sql$
    insert into dependencias (instalacion_id, nombre, direccion, comuna, region, creado_por)
    select i.id, i.nombre, i.direccion, i.comuna, i.region, 'migración 20261104170000'
      from instalaciones i
     where i.id in (select instalacion_id from rotacion_puntos where instalacion_id is not null
                    union
                    select instalacion_id from rotacion_dias   where instalacion_id is not null)
       and not exists (select 1 from dependencias d
                        where d.instalacion_id = i.id and lower(trim(d.nombre)) = lower(trim(i.nombre)))
    $sql$;

  execute $sql$
    update rotacion_puntos p set dependencia_id = d.id
      from dependencias d
     where d.instalacion_id = p.instalacion_id
       and lower(trim(d.nombre)) = (select lower(trim(i.nombre)) from instalaciones i where i.id = p.instalacion_id)
       and p.dependencia_id is null $sql$;

  execute $sql$
    update rotacion_dias x set dependencia_id = d.id
      from dependencias d
     where d.instalacion_id = x.instalacion_id
       and lower(trim(d.nombre)) = (select lower(trim(i.nombre)) from instalaciones i where i.id = x.instalacion_id)
       and x.dependencia_id is null $sql$;

  -- La clave de rotacion_puntos era (rotacion_id, instalacion_id): se rehace
  -- sobre la dependencia antes de soltar la columna.
  execute 'alter table rotacion_puntos drop constraint if exists rotacion_puntos_pkey';
  execute 'alter table rotacion_puntos drop column instalacion_id';
  execute 'alter table rotacion_dias   drop column instalacion_id';
end $$;

-- `dependencia_id` no puede ser null en los puntos: un punto es una
-- dependencia y nada más. En los días sí, que es el día libre.
alter table rotacion_puntos alter column dependencia_id set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rotacion_puntos_pkey') then
    alter table rotacion_puntos add constraint rotacion_puntos_pkey
      primary key (rotacion_id, dependencia_id);
  end if;
end $$;

-- ------------------------------------------------------------------- vistas
drop view if exists v_rotacion_dias;
create view v_rotacion_dias as
select x.*,
       r.nombre     as rotacion,
       r.activa     as rotacion_activa,
       r.instalacion_id,
       i.nombre     as instalacion,
       d.nombre     as dependencia,
       d.comuna     as dependencia_comuna,
       d.activa     as dependencia_activa,
       g1.nombre    as guardia_1,
       g2.nombre    as guardia_2,
       g1.activo    as guardia_1_activo,
       g2.activo    as guardia_2_activo
  from rotacion_dias x
  join rotaciones r on r.id = x.rotacion_id
  left join instalaciones i on i.id = r.instalacion_id
  left join dependencias  d on d.id = x.dependencia_id
  left join trabajadores g1 on g1.id = x.guardia_1_id
  left join trabajadores g2 on g2.id = x.guardia_2_id;

drop view if exists v_dependencias;
create view v_dependencias as
select d.*, i.nombre as instalacion, i.cliente_id,
       (select count(*) from rotacion_puntos p where p.dependencia_id = d.id) as en_rotaciones
  from dependencias d
  join instalaciones i on i.id = d.instalacion_id;

alter table dependencias enable row level security;
