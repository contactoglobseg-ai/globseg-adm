-- Tareas entre las cuentas de la oficina.
--
-- 27-11-2026, pedido de gerencia: «Joaquín me pide algo a mí, o yo a Arturo,
-- y que me quede como tarea pendiente». Hasta hoy eso vivía en WhatsApp y se
-- perdía entre mensajes. Ahora una cuenta le pide algo a otra desde el panel,
-- a quien se lo piden le queda en «Mis tareas» de su portada y le llega un
-- correo, y quien lo pidió ve cuándo se cerró y con qué nota.
--
-- Decisiones:
-- · Se piden por el usuario de la cuenta (`usuarios.usuario`), no por el
--   correo: el correo puede cambiar y el usuario es la llave que ya usa la
--   bitácora. Solo cuentas de oficina; los guardias no entran al panel.
-- · Una tarea la ven quien la pidió y a quien se la pidieron. Nadie más:
--   un pedido puede llevar un sueldo o un problema con una persona.
-- · No se borra. Se cierra como hecha, se devuelve (no me corresponde) o la
--   anula quien la pidió. Lo hecho queda para poder mirarlo después.
-- · El archivo va al bucket privado `documentos-rrhh`, bajo `tareas/`, y
--   entra y sale solo por el Worker, igual que el resto.
--
-- Se puede correr las veces que sea.

create table if not exists tareas (
  id            bigint generated always as identity primary key,
  titulo        text not null,
  detalle       text,
  para_usuario  text not null,
  pedida_por    text not null,
  prioridad     text not null default 'normal',
  vence         date,
  estado        text not null default 'pendiente',
  nota_cierre   text,
  cerrada_por   text,
  cerrada_en    timestamptz,
  creado_en     timestamptz not null default now(),

  archivo_ruta   text,
  archivo_nombre text,
  archivo_tipo   text,
  archivo_bytes  bigint,

  constraint tarea_prioridad_valida check (prioridad in ('normal', 'urgente')),
  constraint tarea_estado_valido check (estado in ('pendiente', 'hecha', 'devuelta', 'anulada')),
  constraint tarea_titulo_no_vacio check (length(btrim(titulo)) > 0)
);

create index if not exists idx_tareas_para   on tareas (para_usuario, estado, creado_en desc);
create index if not exists idx_tareas_pedida on tareas (pedida_por, estado, creado_en desc);

create table if not exists tareas_comentarios (
  id        bigint generated always as identity primary key,
  tarea_id  bigint not null references tareas (id) on delete cascade,
  autor     text not null,
  texto     text not null,
  creado_en timestamptz not null default now(),
  constraint comentario_no_vacio check (length(btrim(texto)) > 0)
);

create index if not exists idx_tareas_coment on tareas_comentarios (tarea_id, creado_en);

comment on table tareas is
  'Pedidos entre cuentas de la oficina. Los ve solo quien pidió y a quien se le pidió; se cierran, no se borran.';

-- RLS activo y sin políticas, como todo lo demás: entra solo el Worker.
alter table tareas             enable row level security;
alter table tareas_comentarios enable row level security;

do $$
declare r text; tbl text;
begin
  foreach tbl in array array['tareas', 'tareas_comentarios'] loop
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on %I from %I', tbl, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant all on %I to service_role', tbl);
    end if;
  end loop;
end $$;

select 'tareas listas' as resultado, (select count(*) from tareas) as tareas;
