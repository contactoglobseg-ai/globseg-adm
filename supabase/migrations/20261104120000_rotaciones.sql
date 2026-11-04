-- Rotación de patrullas: a qué parque va cada patrulla, cada día.
--
-- Nace de cómo se cubre de verdad un conjunto de parques del mismo cliente:
-- en Copec RM hay cuatro parques y una patrulla de dos personas que visita
-- uno por día, y el orden lo arma la oficina para que no sea el mismo todas
-- las semanas. Lo que el gerente pidió cuidar es que el orden no se pueda
-- anticipar desde afuera: un recorrido sabido de memoria es un recorrido que
-- se puede esperar.
--
-- Tres decisiones que explican la forma de estas tablas:
--
-- 1. **Un día, un parque.** `rotacion_dias` tiene una fila por rotación y
--    fecha, y el único índice que importa lo obliga. Es la decisión del
--    gerente —una patrulla, un parque al día— puesta donde no se puede
--    saltar. El día que haya dos patrullas a la vez, esto cambia acá y se
--    nota, en vez de quedar como dos filas que nadie sabe cómo leer.
-- 2. **La patrulla son dos columnas, no una tabla aparte.** El negocio entero
--    está cotizado en parejas de guardias; una tabla de n integrantes sería
--    un join más en cada pantalla para contestar siempre «dos».
--    Las dos quedan nulables a propósito: si un día va uno solo, el turno se
--    anota igual. Perder el registro es peor que anotarlo incompleto.
-- 3. **El parque del día no se amarra por la base a la lista de la rotación.**
--    `rotacion_puntos` dice cuáles son los parques de esa rotación y la
--    pantalla propone esos, pero un día hay que mandar la patrulla a otro
--    lado. El servidor lo avisa; la base no lo prohíbe.
--
-- Se puede correr las veces que sea.

create table if not exists rotaciones (
  id          bigint generated always as identity primary key,
  nombre      text not null,
  notas       text,
  activa      boolean not null default true,
  creado_por  text,
  creado_en   timestamptz not null default now(),

  constraint rotacion_nombre_no_vacio check (length(trim(nombre)) > 0)
);

-- Una rotación con dos nombres iguales son dos planillas para el mismo
-- conjunto de parques, y la segunda es la que nadie mira.
create unique index if not exists rotaciones_nombre_unico
  on rotaciones (lower(trim(nombre)));

-- --------------------------------------------- los parques de cada rotación
create table if not exists rotacion_puntos (
  rotacion_id    bigint not null references rotaciones (id) on delete cascade,
  instalacion_id bigint not null references instalaciones (id) on delete restrict,
  primary key (rotacion_id, instalacion_id)
);

-- ------------------------------------------------------------- la planilla
create table if not exists rotacion_dias (
  id             bigint generated always as identity primary key,
  rotacion_id    bigint not null references rotaciones (id) on delete cascade,
  fecha          date not null,

  -- En null significa que ese día no hay turno en esta rotación, que es
  -- distinto de que nadie lo haya escrito todavía: la fila existe y dice
  -- «libre».
  instalacion_id bigint references instalaciones (id) on delete restrict,

  guardia_1_id   bigint references trabajadores (id) on delete restrict,
  guardia_2_id   bigint references trabajadores (id) on delete restrict,

  notas          text,
  creado_por     text,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),

  -- La misma persona dos veces no es una patrulla de dos.
  constraint rotacion_patrulla_sin_repetido
    check (guardia_1_id is null or guardia_2_id is null
           or guardia_1_id <> guardia_2_id)
);

-- Un día, un parque: es la regla del módulo y vive acá.
create unique index if not exists rotacion_dias_unico
  on rotacion_dias (rotacion_id, fecha);
create index if not exists rotacion_dias_por_fecha on rotacion_dias (fecha);
create index if not exists rotacion_dias_por_guardia_1 on rotacion_dias (guardia_1_id);
create index if not exists rotacion_dias_por_guardia_2 on rotacion_dias (guardia_2_id);

-- ------------------------------------------------------------------- vista
--
-- Va con drop y no con `create or replace`: una vista definida hoy se rehace
-- mañana con columnas nuevas en medio, y `create or replace view` no sabe
-- reordenar columnas. Ya costó una vez, con v_documentos.
drop view if exists v_rotacion_dias;
create view v_rotacion_dias as
select d.*,
       r.nombre     as rotacion,
       r.activa     as rotacion_activa,
       i.nombre     as instalacion,
       i.comuna     as instalacion_comuna,
       -- `nombre` de trabajadores es el nombre completo como se muestra.
       g1.nombre  as guardia_1,
       g2.nombre  as guardia_2,
       -- Para avisar en pantalla si quedó asignado alguien que ya no trabaja
       -- acá: la fila no se borra, se muestra con el aviso al lado.
       g1.activo  as guardia_1_activo,
       g2.activo  as guardia_2_activo
  from rotacion_dias d
  join rotaciones r on r.id = d.rotacion_id
  left join instalaciones i on i.id = d.instalacion_id
  left join trabajadores g1 on g1.id = d.guardia_1_id
  left join trabajadores g2 on g2.id = d.guardia_2_id;

alter table rotaciones      enable row level security;
alter table rotacion_puntos enable row level security;
alter table rotacion_dias   enable row level security;
