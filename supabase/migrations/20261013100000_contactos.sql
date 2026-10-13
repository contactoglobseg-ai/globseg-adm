-- Contactos que llegan desde la web pública.
--
-- Se guardan en la base antes de intentar cualquier aviso por correo: si el
-- correo falla, el contacto igual queda. Al revés se perderían clientes.

create table if not exists contactos (
  id          bigint generated always as identity primary key,
  nombre      text not null,
  telefono    text,
  email       text,
  empresa     text,
  comuna      text,
  que_cuidar  text,
  servicio    text,
  turno       text,
  detalle     text,
  origen      text,
  estado      text not null default 'nuevo'
              check (estado in ('nuevo','contactado','cotizado','cerrado','descartado')),
  notas       text,
  avisado     boolean not null default false,
  creado_en   timestamptz not null default now(),
  atendido_por text,
  atendido_en  timestamptz
);
create index if not exists idx_contactos_estado on contactos(estado);
create index if not exists idx_contactos_fecha  on contactos(creado_en desc);

alter table contactos enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on contactos from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on contactos to service_role;
  end if;
end $$;

select 'contactos lista' as resultado, count(*) as filas from contactos;
