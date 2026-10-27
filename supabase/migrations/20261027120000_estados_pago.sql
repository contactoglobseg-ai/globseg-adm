

-- Estados de pago por instalación, remuneraciones del mes y nómina de
-- transferencias (27-10-2026).
--
-- Tres cosas que van juntas porque salen del mismo cierre de mes:
--   1. `remuneraciones_mes`: la liquidación de cada persona, CONGELADA. Hasta
--      hoy la liquidación se calculaba al vuelo y no se guardaba, lo que sirve
--      para estimar y no sirve para respaldar: el libro de remuneraciones y el
--      estado de pago que recibe el mandante tienen que seguir diciendo lo
--      mismo el año que viene, aunque cambien la UF, el contrato o el sueldo.
--   2. `estados_pago`: la carpeta de un mes y una instalación, con los papeles
--      que el mandante exige (libro de asistencia, libro de remuneraciones,
--      liquidaciones, F30 y F30-1).
--   3. `bancos`: el código de banco destino que pide la nómina de
--      transferencias masivas. Sembrado y **sin confirmar**: un código errado
--      es una transferencia rechazada.

-- ------------------------------------------------------------ remuneraciones
create table if not exists remuneraciones_mes (
  id              bigserial primary key,
  mes             text   not null check (mes ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  trabajador_id   bigint not null references trabajadores(id) on delete restrict,
  -- La instalación se congela acá y no se lee de la ficha: un estado de pago
  -- es por instalación, y si la persona se traslada en noviembre, el de
  -- octubre tiene que seguir saliendo donde trabajó.
  instalacion_id  bigint references instalaciones(id) on delete restrict,
  contrato_id     bigint references contratos(id) on delete restrict,
  cargo           text,
  dias_trabajados integer,
  -- Lo que se tecleó encima del contrato ese mes (horas extra, bonos, anticipos).
  extra           jsonb  not null default '{}'::jsonb,
  -- La liquidación completa tal como la calculó el sistema ese día.
  detalle         jsonb  not null default '{}'::jsonb,
  total_haberes   numeric(14,2) not null default 0,
  total_descuentos numeric(14,2) not null default 0,
  liquido         numeric(14,2) not null default 0,
  costo_empresa   numeric(14,2) not null default 0,
  estado          text   not null default 'borrador'
                   check (estado in ('borrador', 'cerrado')),
  creado_en       timestamptz not null default now(),
  creado_por      text,
  cerrado_en      timestamptz,
  cerrado_por     text
);
create unique index if not exists remuneraciones_mes_unica
  on remuneraciones_mes (mes, trabajador_id);
create index if not exists remuneraciones_mes_instalacion
  on remuneraciones_mes (mes, instalacion_id);
alter table remuneraciones_mes enable row level security;

-- ----------------------------------------------------------- estados de pago
create table if not exists estados_pago (
  id              bigserial primary key,
  mes             text   not null check (mes ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  instalacion_id  bigint not null references instalaciones(id) on delete restrict,
  estado          text   not null default 'armando'
                   check (estado in ('armando', 'enviado', 'aprobado', 'pagado')),
  enviado_en      date,
  folio_factura   text,
  nota            text,
  creado_en       timestamptz not null default now(),
  creado_por      text,
  actualizado_en  timestamptz not null default now()
);
create unique index if not exists estados_pago_unico
  on estados_pago (mes, instalacion_id);
alter table estados_pago enable row level security;

-- Los papeles de la carpeta. El archivo vive en el bucket privado
-- `documentos-rrhh` y entra y sale solo por el Worker, como el de RRHH.
create table if not exists estado_pago_archivos (
  id              bigserial primary key,
  estado_pago_id  bigint not null references estados_pago(id) on delete cascade,
  clase           text   not null check (clase in (
                     'libro_asistencia', 'libro_remuneraciones', 'liquidaciones',
                     'f30', 'f30_1', 'previred', 'factura', 'otro')),
  nombre          text   not null,
  archivo_ruta    text,
  archivo_tipo    text,
  archivo_bytes   bigint,
  nota            text,
  subido_en       timestamptz not null default now(),
  subido_por      text
);
create index if not exists estado_pago_archivos_padre
  on estado_pago_archivos (estado_pago_id);
alter table estado_pago_archivos enable row level security;

create or replace view v_estados_pago as
  select e.id, e.mes, e.instalacion_id, e.estado, e.enviado_en, e.folio_factura,
         e.nota, e.creado_en, e.creado_por, e.actualizado_en,
         i.nombre as instalacion,
         c.nombre as cliente,
         (select count(*) from estado_pago_archivos a where a.estado_pago_id = e.id)
           as archivos
    from estados_pago e
    join instalaciones i on i.id = e.instalacion_id
    left join clientes c on c.id = i.cliente_id;

-- ------------------------------------------------------------------- bancos
-- El código que pide la columna «Código banco destino» de la nómina. Van todos
-- con `por_confirmar`: el listado de la plaza es público, pero el que vale es
-- el de la nómina del banco con que se paga, y una transferencia con el código
-- errado se rechaza. Se confirman desde la pantalla.
create table if not exists bancos (
  codigo         text primary key,
  nombre         text not null,
  por_confirmar  boolean not null default true,
  activo         boolean not null default true,
  orden          integer not null default 100
);
alter table bancos enable row level security;

insert into bancos (codigo, nombre, orden) values
  ('012', 'BancoEstado',               10),
  ('001', 'Banco de Chile',            20),
  ('037', 'Banco Santander',           30),
  ('016', 'Banco de Crédito e Inversiones (BCI)', 40),
  ('027', 'Banco Itaú Corpbanca',      50),
  ('039', 'Banco Itaú',                55),
  ('014', 'Scotiabank Chile',          60),
  ('028', 'Banco BICE',                70),
  ('049', 'Banco Security',            80),
  ('051', 'Banco Falabella',           90),
  ('053', 'Banco Ripley',             100),
  ('055', 'Banco Consorcio',          110),
  ('009', 'Banco Internacional',      120),
  ('504', 'Banco BBVA',               130),
  ('672', 'Coopeuch',                 140),
  ('730', 'Tenpo',                    150),
  ('729', 'Mercado Pago',             160)
on conflict (codigo) do nothing;

-- Con qué cuenta se paga. Van en `datos_empresa`, donde ya viven la razón
-- social y el representante, y con la misma regla: mientras no se confirmen
-- salen en ámbar y la nómina avisa en vez de inventar un número.
insert into datos_empresa (codigo, valor, glosa, por_confirmar) values
  ('cuenta_origen', '', 'Cuenta corriente desde la que se pagan las remuneraciones. Es la columna «Cuenta origen» de la nómina de transferencias.', true),
  ('banco_origen',  '', 'Banco de esa cuenta. Si el banco destino es el mismo, la nómina no exige código de banco ni RUT.', true)
on conflict (codigo) do nothing;
