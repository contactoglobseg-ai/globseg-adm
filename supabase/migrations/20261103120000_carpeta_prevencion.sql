

-- La carpeta de prevención: los papeles que no son de nadie (03-11-2026).
--
-- Pedido del gerente, al día siguiente de que entrara el IRL: una pestaña de
-- prevención de riesgos «donde la prevencionista suba todo». Lo que tenía
-- repartido ya existía —mandar a firmar, los documentos de cada ficha, la
-- entrega de EPP—, y faltaba justamente lo que no cuelga de una persona: la
-- matriz de riesgos, el programa anual, las actas del comité paritario, el
-- plan de emergencia de cada parque, lo que prescribe la mutual.
--
-- **Son de la empresa o de una instalación, no de un trabajador.** Esa es toda
-- la razón de que sea una tabla propia y no una fila más en
-- `documentos_trabajador`: ahí `trabajador_id` es obligatorio, y colgar el
-- MIPER de Puelche de una persona cualquiera haría que desapareciera el día
-- que esa persona se va. `instalacion_id` en null significa «de toda la
-- empresa», que es el caso del RIOHS y del programa anual.
--
-- `clase` es una restricción y no un catálogo en otra tabla, por lo mismo que
-- en los estados de pago: son nombres que cambian una vez al año y una tabla
-- aparte habría que leerla en cada pantalla para traducir un código. El costo
-- —agregar un papel es una migración— se paga con **`otro`**: lo que no esté
-- en la lista entra ahí con su título escrito a mano, así que la
-- prevencionista nunca queda sin poder subir algo.
--
-- Se puede correr las veces que sea.

create table if not exists documentos_prevencion (
  id            bigint generated always as identity primary key,
  clase         text not null,
  -- Lo que dice el papel, escrito por quien lo sube. Con `clase` = 'otro' es
  -- lo único que lo identifica, así que es obligatorio siempre.
  titulo        text not null,
  -- Null = de toda la empresa. Con instalación = de ese parque.
  instalacion_id bigint references instalaciones(id) on delete set null,

  fecha_emision     date,
  -- El MIPER y el programa se actualizan cada año; un acta no vence. Por eso
  -- es opcional, y cuando está, la pantalla lo muestra junto a lo que vence de
  -- las personas: la prevencionista persigue una sola lista.
  fecha_vencimiento date,

  archivo_ruta   text,
  archivo_nombre text,
  archivo_tipo   text,
  archivo_bytes  bigint,

  observacion   text,
  -- Un documento no se borra: se da de baja. El MIPER del año pasado es el que
  -- estaba vigente cuando ocurrió lo que haya ocurrido, y borrarlo perdería
  -- justamente la versión que habría que mostrar.
  vigente       boolean not null default true,

  creado_por    text,
  creado_en     timestamptz not null default now(),

  constraint docprev_fechas_en_orden
    check (fecha_vencimiento is null or fecha_emision is null
           or fecha_vencimiento >= fecha_emision)
);

alter table documentos_prevencion drop constraint if exists docprev_clase_valida;
alter table documentos_prevencion add constraint docprev_clase_valida
  check (clase in (
    'miper',            -- matriz de identificación de peligros y evaluación de riesgos
    'programa',         -- programa anual de prevención
    'riohs',            -- el reglamento vigente (el documento, no su recepción)
    'comite_paritario', -- acta del comité paritario
    'plan_emergencia',  -- plan de emergencia y evacuación
    'mutual',           -- informe o prescripción del organismo administrador
    'investigacion',    -- investigación de accidente o incidente
    'charla',           -- registro de una charla o capacitación grupal
    'procedimiento',    -- procedimiento de trabajo seguro
    'otro'));

create index if not exists docprev_por_instalacion
  on documentos_prevencion (instalacion_id, clase) where vigente;
create index if not exists docprev_vence
  on documentos_prevencion (fecha_vencimiento)
  where vigente and fecha_vencimiento is not null;

-- La vista pega el nombre de la instalación y calcula el estado con la misma
-- regla que `v_documentos`, para que las dos listas de vencimientos que mira
-- la prevencionista digan lo mismo con las mismas palabras.
drop view if exists v_documentos_prevencion;
create view v_documentos_prevencion as
select d.*,
       i.nombre as instalacion,
       case
         when not d.vigente                            then 'anulado'
         when d.fecha_vencimiento is null              then 'sin_vencimiento'
         when d.fecha_vencimiento <  current_date      then 'vencido'
         when d.fecha_vencimiento <= current_date + 30 then 'por_vencer'
         else 'vigente'
       end as estado,
       (d.fecha_vencimiento - current_date) as dias_para_vencer,
       (d.archivo_ruta is not null)         as tiene_archivo
  from documentos_prevencion d
  left join instalaciones i on i.id = d.instalacion_id;

comment on view v_documentos_prevencion is
  'Los papeles de prevención que son de la empresa o de una instalación, no de una persona.';
