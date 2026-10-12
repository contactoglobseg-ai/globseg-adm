-- Administración Seguridad Garridos (GLOBSEG SPA)
-- Módulo 1: control de servicios prestados y facturación.
--
-- Seguridad: todas las tablas quedan con RLS activo y SIN políticas. Eso
-- significa que ni la clave anónima ni un usuario autenticado pueden leer
-- nada directamente. El único que entra es el Worker, con la clave de
-- servicio, y ahí se decide por rol qué ve cada persona. Acá hay sueldos y
-- exámenes de salud: la base no se expone al navegador.

-- ---------------------------------------------------------------- tablas

create table if not exists usuarios (
  email  text primary key,
  nombre text not null,
  rol    text not null check (rol in ('gerencia','operaciones','rrhh','prevencion')),
  activo boolean not null default true
);

create table if not exists clientes (
  id        bigint generated always as identity primary key,
  nombre    text not null,
  rut       text,
  contacto  text,
  email     text,
  activo    boolean not null default true,
  creado_en timestamptz not null default now()
);

-- Las faenas: cada parque fotovoltaico, bodega u obra que se resguarda.
create table if not exists instalaciones (
  id         bigint generated always as identity primary key,
  cliente_id bigint not null references clientes(id) on delete restrict,
  nombre     text not null,
  comuna     text,
  region     text,
  activa     boolean not null default true
);
create index if not exists idx_inst_cliente on instalaciones(cliente_id);

-- El servicio continuo que se factura cada N días.
create table if not exists servicios (
  id             bigint generated always as identity primary key,
  instalacion_id bigint not null references instalaciones(id) on delete restrict,
  nombre         text not null,
  fecha_inicio   date not null,
  dias_ciclo     integer not null default 30 check (dias_ciclo between 1 and 365),
  monto_neto     bigint,
  activo         boolean not null default true,
  creado_por     text,
  creado_en      timestamptz not null default now()
);
create index if not exists idx_serv_inst on servicios(instalacion_id);

-- Tarifario, tomado del sistema contable.
create table if not exists tarifas (
  id     bigint generated always as identity primary key,
  codigo text,
  nombre text not null,
  unidad text,
  precio bigint not null,
  grupo  text,
  activo boolean not null default true
);

-- Cada periodo que hay que cobrar. Es el corazón del módulo:
--   en_curso -> solicitar_oc -> pendiente_facturacion -> cerrado
create table if not exists ciclos (
  id             bigint generated always as identity primary key,
  servicio_id    bigint not null references servicios(id) on delete cascade,
  numero         integer not null,
  desde          date not null,
  hasta          date not null,
  estado         text not null default 'en_curso'
                 check (estado in ('en_curso','solicitar_oc','pendiente_facturacion','cerrado')),
  oc_numero      text,
  oc_fecha       date,
  factura_folio  text,
  factura_fecha  date,
  monto_neto     bigint,
  notas          text,
  actualizado_en timestamptz,
  unique (servicio_id, numero)
);
create index if not exists idx_ciclos_estado on ciclos(estado);
create index if not exists idx_ciclos_hasta  on ciclos(hasta);

-- Servicios extraordinarios: horas, jornadas y coberturas programadas.
-- Es lo que se estaba perdiendo sin facturar.
create table if not exists extras (
  id              bigint generated always as identity primary key,
  instalacion_id  bigint not null references instalaciones(id) on delete restrict,
  ciclo_id        bigint references ciclos(id) on delete set null,
  fecha           date not null,
  tarifa_id       bigint references tarifas(id),
  item            text not null,
  cantidad        numeric not null default 1 check (cantidad > 0),
  precio_unitario bigint not null,
  monto_neto      bigint not null,
  detalle         text,
  creado_por      text,
  creado_en       timestamptz not null default now()
);
create index if not exists idx_extras_ciclo on extras(ciclo_id);
create index if not exists idx_extras_fecha on extras(fecha);

-- Quién hizo qué. Existe precisamente porque hubo dudas sobre el orden de
-- los servicios extra: acá queda el rastro.
create table if not exists bitacora (
  id         bigint generated always as identity primary key,
  cuando     timestamptz not null default now(),
  quien      text not null,
  entidad    text not null,
  entidad_id bigint,
  accion     text not null,
  detalle    text
);
create index if not exists idx_bitacora_cuando on bitacora(cuando desc);

-- ---------------------------------------------------------------- vista

-- El panel en una sola consulta, con los extras ya sumados a cada periodo.
create or replace view v_ciclos with (security_invoker = true) as
select
  c.*,
  s.nombre                        as servicio,
  i.nombre                        as instalacion,
  i.comuna,
  cl.nombre                       as cliente,
  coalesce(e.extras_neto, 0)      as extras_neto,
  coalesce(e.extras_n, 0)         as extras_n,
  coalesce(c.monto_neto, 0) + coalesce(e.extras_neto, 0)            as total_neto,
  round((coalesce(c.monto_neto,0) + coalesce(e.extras_neto,0)) * 0.19) as iva,
  (current_date - c.hasta)        as dias_desde_cierre
from ciclos c
join servicios s     on s.id  = c.servicio_id
join instalaciones i on i.id  = s.instalacion_id
join clientes cl     on cl.id = i.cliente_id
left join lateral (
  select sum(x.monto_neto) as extras_neto, count(*) as extras_n
  from extras x where x.ciclo_id = c.id
) e on true;

-- Los extras con el nombre de la instalación ya resuelto.
create or replace view v_extras with (security_invoker = true) as
select e.*, i.nombre as instalacion
from extras e
join instalaciones i on i.id = e.instalacion_id;

-- Las instalaciones con su cliente.
create or replace view v_instalaciones with (security_invoker = true) as
select i.id, i.nombre, i.comuna, i.region, i.activa, cl.nombre as cliente
from instalaciones i
join clientes cl on cl.id = i.cliente_id;

-- ---------------------------------------------------------------- RLS

alter table usuarios      enable row level security;
alter table clientes      enable row level security;
alter table instalaciones enable row level security;
alter table servicios     enable row level security;
alter table tarifas       enable row level security;
alter table ciclos        enable row level security;
alter table extras        enable row level security;
alter table bitacora      enable row level security;
-- Sin políticas a propósito: solo la clave de servicio, usada por el Worker,
-- puede leer o escribir. Si alguna vez se quiere acceso directo desde el
-- navegador, hay que escribir políticas explícitas y revisarlas con cuidado.

-- ---------------------------------------------------------------- datos

-- Tarifario: sale de "servicios globseg.xlsx", export del sistema contable.
-- Todo está cotizado en parejas de guardias.
insert into tarifas (codigo, nombre, unidad, precio, grupo) values
  ('1',  '2 guardias por hora hábil',                   'hora',   26000,   'Horas'),
  ('2',  '2 guardias por hora (sábado)',                'hora',   30333,   'Horas'),
  ('3',  '2 guardias por hora (domingo y feriado)',     'hora',   34667,   'Horas'),
  ('4',  '2 guardias por hora (feriado irrenunciable)', 'hora',   43333,   'Horas'),
  ('5',  '2 guardias por día hábil',                    'día',    200000,  'Jornadas'),
  ('6',  '2 guardias por día (sábado)',                 'día',    233333,  'Jornadas'),
  ('7',  '2 guardias por día (domingo y feriados)',     'día',    266667,  'Jornadas'),
  ('8',  '2 guardias por día (feriado irrenunciable)',  'día',    333333,  'Jornadas'),
  ('13', 'Supervisor diario',                           'día',    70000,   'Jornadas'),
  ('9',  'Arriendo de vehículo mensual',                'mes',    1000000, 'Vehículo'),
  ('10', 'Arriendo de vehículo semanal',                'semana', 425000,  'Vehículo'),
  ('11', 'Arriendo de vehículo diario',                 'día',    100000,  'Vehículo'),
  ('12', 'Combustible',                                 'global', 50000,   'Vehículo')
on conflict do nothing;

-- Instalaciones: salen de "servicios extra ordinarios .docx".
-- El nombre del cliente no aparece en esos documentos: renombrarlo desde la app.
insert into clientes (nombre) values ('Cliente PMGD — falta confirmar el nombre')
on conflict do nothing;

insert into instalaciones (cliente_id, nombre, comuna, region)
select c.id, v.nombre, v.comuna, v.region
from clientes c,
     (values ('PMGD San Ramón','Paine','Metropolitana'),
             ('PMGD Rengo','Rengo','O''Higgins'),
             ('PMGD Puelche','Los Ángeles','Biobío'),
             ('PMGD Loncura','Puchuncaví','Valparaíso'),
             ('PMGD El Cauce','Calama','Antofagasta')) as v(nombre, comuna, region)
where c.nombre = 'Cliente PMGD — falta confirmar el nombre'
  and not exists (select 1 from instalaciones i where i.nombre = v.nombre);

-- Usuarios. El acceso lo da Cloudflare Access; acá se define el rol.
-- Falta el correo de la prevencionista.
insert into usuarios (email, nombre, rol) values
  ('contacto.globseg@gmail.com', 'José Garrido',    'gerencia'),
  ('sgarrido@proverde.cl',       'José Garrido',    'gerencia'),
  ('joaquinglobseg@gmail.com',   'Joaquín Garrido', 'operaciones'),
  ('rrhhglobseg@gmail.com',      'Valeria Torres',  'rrhh')
on conflict (email) do update
  set nombre = excluded.nombre, rol = excluded.rol;
