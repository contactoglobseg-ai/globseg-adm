-- =============================================================================
-- Planilla de turnos (adm.seggarridos.com → Operaciones → Planilla de turnos)
--
-- Una tabla semanal: cada instalación por fila, cada día por columna, y en cada
-- casilla un turno de día y uno de noche con los guardias que van. Se arma
-- arrastrando a los guardias. Es lo que SE PLANEÓ, no lo que pasó: lo que pasó
-- son las marcas del libro de asistencia.
--
-- La abren solo cuatro cuentas (Joaquín, José, Sebastián y vislaj), con un
-- permiso nuevo, `planilla`, que se reparte desde Sistema → Usuarios como los
-- demás.
--
-- Solo AGREGA: una tabla nueva, el permiso nuevo en las dos listas que la base
-- acepta, y ese permiso a esas cuatro cuentas. No borra nada.
-- =============================================================================

-- 1. Las asignaciones -----------------------------------------------------------
create table if not exists planilla_turnos (
  id              bigint generated always as identity primary key,
  fecha           date not null,
  turno           text not null check (turno in ('dia', 'noche')),
  instalacion_id  bigint not null references instalaciones(id) on delete cascade,
  trabajador_id   bigint not null references trabajadores(id) on delete cascade,
  creado_por      text,
  creado_en       timestamptz not null default now(),

  -- Un guardia no puede estar en dos partes el mismo día y el mismo turno. Lo
  -- cuida la base, no solo la pantalla: dos personas moviendo la tabla a la
  -- vez no pueden dejarlo duplicado.
  constraint planilla_una_vez_por_turno unique (fecha, turno, trabajador_id)
);

create index if not exists idx_planilla_fecha on planilla_turnos(fecha);
create index if not exists idx_planilla_inst  on planilla_turnos(instalacion_id, fecha);

comment on table planilla_turnos is
  'Planilla semanal de turnos: qué guardia va a qué instalación cada día, de día o de noche. Es planificación, no asistencia.';

alter table planilla_turnos enable row level security;

-- 2. El permiso `planilla` ------------------------------------------------------
alter table usuarios drop constraint if exists usuarios_permisos_extra_validos;
alter table usuarios add constraint usuarios_permisos_extra_validos
  check (permisos_extra <@ array['facturacion', 'cotizaciones', 'personal', 'documentos',
                                 'rrhh', 'remuneraciones', 'usuarios', 'planilla']);

alter table roles_permisos drop constraint if exists roles_permisos_modulos_validos;
alter table roles_permisos add constraint roles_permisos_modulos_validos
  check (permisos <@ array['facturacion', 'cotizaciones', 'personal', 'documentos',
                           'rrhh', 'remuneraciones', 'usuarios', 'planilla']);

-- 3. A quién se le da -----------------------------------------------------------
-- Como permiso propio de cada cuenta y no del rol: vislaj es practicante, y el
-- resto de la gerencia que se cree después no lo recibe sin que alguien lo marque.
update usuarios
   set permisos_extra = array(select distinct unnest(coalesce(permisos_extra, '{}') || array['planilla']))
 where usuario in ('jgarridob', 'jgarridoh', 'sgarridob', 'vislaj');
