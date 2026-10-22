-- Activos y EPP: qué tiene la empresa y quién lo tiene puesto.
--
-- Nace de dos cosas distintas que terminan en la misma tabla:
--  · El DS 594 art. 53 obliga a entregar los elementos de protección sin costo
--    y a dejar registro. Hoy ese registro es un papel en una carpeta, y cuando
--    el mandante lo pide hay que ir a buscarlo.
--  · Un chaleco antibalas vence, y una radio que se fue con alguien que ya no
--    trabaja acá es plata perdida que nadie anota.
--
-- Se puede correr las veces que sea.

create table if not exists articulos (
  id            bigint generated always as identity primary key,
  nombre        text not null,
  categoria     text not null default 'epp',
  -- La talla es parte del artículo y no de la entrega: un pantalón talla 52 y
  -- uno talla 48 son dos cosas con stock propio, y pedirlos juntos no sirve.
  talla         text,
  unidad        text not null default 'unidad',

  -- El stock lo mueve el sistema: baja al entregar y sube al recibir de vuelta.
  -- Las compras y las pérdidas entran por un ajuste a mano, que queda en la
  -- bitácora con el motivo. No se deduce de una tabla de movimientos porque la
  -- oficina no lleva una, y un número que nadie puede cuadrar con la bodega es
  -- peor que uno que alguien corrige cuando lo cuenta.
  stock         integer not null default 0,
  stock_minimo  integer not null default 0,

  -- Lo que caduca: un chaleco antibalas o anticorte tiene vida útil, y pasada
  -- esa fecha deja de proteger aunque se vea igual.
  vence         boolean not null default false,
  meses_vida    integer,

  activo        boolean not null default true,
  notas         text,
  creado_por    text,
  creado_en     timestamptz not null default now(),

  constraint articulo_categoria_valida
    check (categoria in ('epp','uniforme','equipo','vehiculo','otro')),
  constraint articulo_stock_no_negativo check (stock >= 0),
  constraint articulo_vida_con_vencimiento
    check (not vence or meses_vida is null or meses_vida > 0)
);

create unique index if not exists articulo_sin_repetir
  on articulos (lower(nombre), coalesce(lower(talla), ''));

create table if not exists entregas (
  id             bigint generated always as identity primary key,
  trabajador_id  bigint not null references trabajadores(id) on delete restrict,
  articulo_id    bigint not null references articulos(id) on delete restrict,
  cantidad       integer not null default 1,

  entregada_en   date not null,
  -- Cuándo deja de servir lo entregado. Se propone con la vida útil del
  -- artículo al entregarlo, y se puede corregir: la fecha del fabricante manda
  -- sobre la del catálogo.
  vence_en       date,

  estado         text not null default 'entregado',
  devuelta_en    date,
  devolucion_estado text,

  -- El acta firmada con el dedo, cuando se genere desde Documentos. Queda
  -- nulable: la entrega se registra igual aunque el acta venga después, y lo
  -- que no se puede es perder el registro por estar esperando una firma.
  documento_id   bigint references documentos_generados(id) on delete set null,

  observacion    text,
  creado_por     text,
  creado_en      timestamptz not null default now(),

  constraint entrega_cantidad_positiva check (cantidad > 0),
  constraint entrega_estado_valido
    check (estado in ('entregado','devuelto','perdido','dado_de_baja')),
  constraint entrega_devolucion_estado
    check (devolucion_estado is null or devolucion_estado in ('bueno','dañado','inservible')),
  -- Una entrega devuelta sin fecha de devolución no se puede contar ni cobrar.
  constraint entrega_devuelta_con_fecha
    check (estado <> 'devuelto' or devuelta_en is not null),
  constraint entrega_fechas_en_orden
    check (devuelta_en is null or devuelta_en >= entregada_en)
);

create index if not exists entregas_por_trabajador on entregas (trabajador_id);
create index if not exists entregas_por_articulo   on entregas (articulo_id);

-- La vista que lee la pantalla: la entrega con el nombre de quien la tiene y
-- de qué es, más el estado de vencimiento calculado acá y no en el navegador.
-- Va con `drop` y no con `create or replace` porque una migración que mañana
-- le agregue una columna no podría reemplazarla: ya pasó con `v_documentos`.
drop view if exists v_entregas;
create view v_entregas with (security_invoker = true) as
select e.*,
       t.nombre    as trabajador,
       t.rut       as trabajador_rut,
       t.activo    as trabajador_activo,
       a.nombre    as articulo,
       a.talla,
       a.categoria,
       a.unidad,
       case
         when e.estado <> 'entregado'            then e.estado
         when e.vence_en is null                 then 'vigente'
         when e.vence_en <  current_date         then 'vencido'
         when e.vence_en <= current_date + 30    then 'por_vencer'
         else 'vigente'
       end as situacion,
       (e.vence_en - current_date) as dias_para_vencer
  from entregas e
  join trabajadores t on t.id = e.trabajador_id
  join articulos    a on a.id = e.articulo_id;

alter table articulos enable row level security;
alter table entregas  enable row level security;

comment on table articulos is
  'Catálogo de EPP, uniformes y equipos, con su stock en bodega.';
comment on table entregas is
  'Qué se le entregó a quién, cuándo vence y si volvió. DS 594 art. 53.';

-- --------------------------------------------------------------- el catálogo
--
-- Lo que un guardia de parque usa de verdad. Son un punto de partida para que
-- la pantalla no abra vacía; la oficina los corrige y agrega los suyos. Los
-- stocks van en cero: el que hay se cuenta en la bodega, no se inventa acá.
insert into articulos (nombre, categoria, unidad, vence, meses_vida, stock_minimo, notas)
values
  ('Chaleco reflectante',       'epp',      'unidad', false, null, 5, null),
  ('Casco de seguridad',        'epp',      'unidad', true,  60,   3,
   'Vida útil desde la entrega; la del fabricante manda si viene marcada.'),
  ('Zapatos de seguridad',      'epp',      'par',    false, null, 3, null),
  ('Guantes',                   'epp',      'par',    false, null, 10, null),
  ('Parka',                     'uniforme', 'unidad', false, null, 3, null),
  ('Camisa institucional',      'uniforme', 'unidad', false, null, 5, null),
  ('Pantalón institucional',    'uniforme', 'unidad', false, null, 5, null),
  ('Linterna',                  'equipo',   'unidad', false, null, 3, null),
  ('Radio portátil',            'equipo',   'unidad', false, null, 2, null),
  ('Teléfono celular',          'equipo',   'unidad', false, null, 1, null),
  ('Bitácora de turno',         'otro',     'unidad', false, null, 2, null)
on conflict do nothing;
