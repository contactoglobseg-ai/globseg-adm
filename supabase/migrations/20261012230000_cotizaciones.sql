-- Módulo 2: cotizaciones.
--
-- Los datos del cliente se copian dentro de la cotización al crearla, en vez
-- de quedar solo referenciados. Una cotización es un documento que se envía y
-- queda: si mañana se corrige el nombre o el RUT de un cliente, la cotización
-- que ya salió no debe cambiar sola.
--
-- Los montos también se guardan calculados. Podrían recalcularse al vuelo,
-- pero entonces un cambio de tarifa alteraría una cotización ya enviada.

create table if not exists cotizaciones (
  id               bigint generated always as identity primary key,
  numero           text not null,
  cliente_id       bigint references clientes(id) on delete set null,
  cliente_nombre   text not null,
  cliente_rut      text,
  cliente_contacto text,
  cliente_email    text,
  instalacion      text,
  fecha            date not null default current_date,
  validez_dias     integer not null default 30 check (validez_dias between 1 and 365),
  condiciones      text,
  observaciones    text,
  estado           text not null default 'borrador'
                   check (estado in ('borrador','enviada','aceptada','rechazada')),
  neto             bigint not null default 0,
  iva              bigint not null default 0,
  total            bigint not null default 0,
  creado_por       text,
  creado_en        timestamptz not null default now(),
  actualizado_en   timestamptz,
  unique (numero)
);
create index if not exists idx_cotiz_estado on cotizaciones(estado);
create index if not exists idx_cotiz_fecha  on cotizaciones(fecha desc);

create table if not exists cotizacion_items (
  id              bigint generated always as identity primary key,
  cotizacion_id   bigint not null references cotizaciones(id) on delete cascade,
  orden           integer not null default 0,
  descripcion     text not null,
  unidad          text,
  cantidad        numeric not null default 1 check (cantidad > 0),
  precio_unitario bigint not null check (precio_unitario >= 0),
  subtotal        bigint not null
);
create index if not exists idx_items_cotiz on cotizacion_items(cotizacion_id, orden);

-- Listado con el conteo de líneas, para no pedir los ítems de cada una.
create or replace view v_cotizaciones with (security_invoker = true) as
select c.*,
       (select count(*) from cotizacion_items i where i.cotizacion_id = c.id) as n_items,
       (c.fecha + c.validez_dias)                                             as vence,
       (current_date > c.fecha + c.validez_dias)                              as vencida
from cotizaciones c;

alter table cotizaciones      enable row level security;
alter table cotizacion_items  enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on cotizaciones, cotizacion_items, v_cotizaciones from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on cotizaciones, cotizacion_items to service_role;
    grant all on v_cotizaciones to service_role;
  end if;
end $$;
