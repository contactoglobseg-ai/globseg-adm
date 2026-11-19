

-- Alertas de documentación pendiente, y lo que está subido a Pronexo
-- (17-11-2026).
--
-- Pedido del gerente: un aviso de la documentación pendiente de cada
-- trabajador, porque la empresa sube los papeles a PRONEXO (la plataforma
-- donde el mandante revisa la documentación del contratista) y eso tiene que
-- estar al día. Tres decisiones suyas, tomadas antes de escribir esto:
--   1. El aviso llega por CORREO, todos los días, a RRHH, y solo si hay algo
--      nuevo. La pantalla ya mostraba lo vencido; nadie entra a mirar lo que
--      no le llega.
--   2. El sistema lleva el registro de qué documento ya está SUBIDO A PRONEXO.
--   3. La lista de lo exigido es la misma para todos: los obligatorios del
--      catálogo `tipos_documento`, que ya existe.
--
-- Se puede correr más de una vez.

-- ------------------------------------------------------------------ Pronexo
-- Cuándo y quién marcó que este documento quedó subido a Pronexo. Va en el
-- documento y no en la persona porque lo que se sube es un papel: cuando la
-- credencial OS-10 se renueva, la nueva es otra fila, nace sin marca, y el
-- aviso dice que falta subir la versión nueva aunque la vieja estuviera allá.
alter table documentos_trabajador
  add column if not exists pronexo_subido_en timestamptz,
  add column if not exists pronexo_por       text;

comment on column documentos_trabajador.pronexo_subido_en is
  'Cuándo se marcó como subido a Pronexo. Null = no consta que esté subido.';

-- La vista se rehace con drop + create y no con create or replace: está
-- definida con d.*, que Postgres expande al crearla, así que las columnas
-- nuevas no aparecerían, y create or replace no puede agregarlas en medio
-- («cannot drop columns from view»). Ya pasó el 15-10-2026.
drop view if exists v_documentos;
create view v_documentos with (security_invoker = true) as
select
  d.*,
  t.nombre   as trabajador,
  t.rut      as trabajador_rut,
  t.cargo    as trabajador_cargo,
  t.activo   as trabajador_activo,
  td.nombre  as tipo_nombre,
  td.grupo   as tipo_grupo,
  td.obligatorio,
  td.base_legal,
  case
    when not d.vigente                     then 'anulado'
    when d.fecha_vencimiento is null       then 'sin_vencimiento'
    when d.fecha_vencimiento <  current_date then 'vencido'
    when d.fecha_vencimiento <= current_date + 30 then 'por_vencer'
    else 'vigente'
  end as estado,
  (d.fecha_vencimiento - current_date) as dias_para_vencer,
  (d.archivo_ruta is not null)         as tiene_archivo
from documentos_trabajador d
join trabajadores t    on t.id = d.trabajador_id
join tipos_documento td on td.codigo = d.tipo;

-- ------------------------------------------------------------ lo ya avisado
-- Una fila por cosa pendiente que ya salió en un correo. Es lo que hace que el
-- correo diario salga solo cuando hay algo nuevo: el mismo «falta el examen
-- preocupacional de Pérez» todos los días termina en la carpeta de spam de la
-- cabeza de quien lo recibe.
--
-- La clave dice qué y en qué tramo: «vence:123:30» es el documento 123 entrando
-- a los 30 días. Al pasar a los 7 la clave cambia y vuelve a avisar. Lo que ya
-- no está pendiente se borra de acá en la pasada siguiente, así que la tabla
-- nunca es más grande que lo pendiente de hoy, y si algo vuelve a faltar,
-- vuelve a ser nuevo.
create table if not exists avisos_documentos (
  clave       text primary key,
  enviado_en  timestamptz not null default now()
);
alter table avisos_documentos enable row level security;

-- Qué correo salió, a quién y si llegó a salir. Sin esto, «¿me llegó el aviso
-- de ayer?» no tiene respuesta, y un correo que falla todos los días en
-- silencio es peor que no tener correo: todos creen que alguien está avisado.
create table if not exists envios_alertas (
  id            bigserial primary key,
  enviado_en    timestamptz not null default now(),
  origen        text not null default 'diario' check (origen in ('diario', 'a_mano')),
  destinatarios text,
  asunto        text,
  nuevos        integer not null default 0,
  pendientes    integer not null default 0,
  ok            boolean not null default false,
  error         text,
  quien         text
);
alter table envios_alertas enable row level security;
create index if not exists envios_alertas_fecha on envios_alertas (enviado_en desc);

-- --------------------------------------------------------- a quién se avisa
-- Vive en datos_empresa para que se cambie desde la pantalla, sin desplegar.
-- Entra sin confirmar: Valeria está con licencia desde el 08-11 y Pablo la
-- reemplaza, así que van los dos, y RRHH decide.
insert into datos_empresa (codigo, valor, glosa, por_confirmar) values
  ('correo_alertas_rrhh', 'rrhh2.globseg@gmail.com, rrhhglobseg@gmail.com',
   'Correos que reciben el aviso diario de documentación pendiente, separados por coma', true)
on conflict (codigo) do nothing;
