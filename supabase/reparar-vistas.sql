

-- Rehace tres vistas que desaparecieron de producción.
--
-- Encontrado el 29-10-2026, al verificar el despliegue del módulo de usuarios:
-- `/api/diagnostico` daba `false` en `v_documentos`, `v_documentos_generados`
-- y `v_estados_pago`, mientras las tres tablas de las que cuelgan
-- —`documentos_trabajador`, `documentos_generados` y `estados_pago`— seguían
-- en `true`. El 27-10 no quedaba nada en `false`, así que se perdieron entre
-- esa fecha y esta.
--
-- **No se sabe qué las borró**, y conviene decirlo así en vez de inventar una
-- causa. Lo que sí quedó descartado, probándolo y no razonándolo:
--   - No es el módulo de usuarios. Con las 25 migraciones aplicadas de cero
--     sobre un Postgres 16 local, incluida la nueva corrida tres veces, las
--     seis vistas existen y PostgREST las contesta con la misma consulta que
--     usa el diagnóstico.
--   - No es haber vuelto a pegar `20261015170000_rrhh.sql`, que era la
--     sospecha primera por el tropiezo del `create or replace view` anotado en
--     CLAUDE.md: se reaplicó sobre la base completa y las tres vistas quedaron
--     en pie.
-- Queda para mirar si vuelve a pasar: lo que haya corrido en el SQL Editor
-- entre el 27 y el 29 de octubre.
--
-- Qué se rompe mientras falten:
--   v_documentos            → Personas: los documentos de cada trabajador, y
--                             los avisos de OS-10 y contratos por vencer.
--   v_documentos_generados  → Documentos: la lista de lo generado y firmado.
--   v_estados_pago          → Estados de pago: la carpeta por instalación.
--
-- Las definiciones son **copia textual** de las migraciones donde cada una se
-- define por última vez, para que esto deje la base exactamente como la
-- dejarían las migraciones y no una versión parecida:
--   v_documentos            → 20261015200000_archivos_rrhh.sql
--   v_documentos_generados  → 20261020180000_documentos_firma.sql
--   v_estados_pago          → 20261027120000_estados_pago.sql
--
-- Se puede correr las veces que haga falta. No toca ningún dato: las vistas no
-- guardan nada, son una forma de mirar las tablas.
--
-- (Las dos líneas en blanco de arriba son de resguardo: si el editor se come
-- el primer carácter al pegar, se come un salto de línea y no SQL.)

-- ---------------------------------------------------------------- v_documentos
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

-- ------------------------------------------------- v_documentos_generados
drop view if exists v_documentos_generados;
create view v_documentos_generados as
select g.id, g.numero, g.plantilla, g.titulo, g.estado,
       g.trabajador_id, t.nombre as trabajador, t.rut as trabajador_rut,
       g.contrato_id, g.documento_id, g.por_confirmar,
       g.creado_por, g.creado_en, g.anulado_motivo,
       p.nombre as plantilla_nombre, p.clase, p.firmantes,
       (select count(*) from firmas_documento f where f.documento_id = g.id) as firmas,
       (select count(*) from firmas_documento f
         where f.documento_id = g.id and f.cuerpo_hash <> g.cuerpo_hash) as firmas_descuadradas
  from documentos_generados g
  join plantillas_documento p on p.codigo = g.plantilla
  left join trabajadores t on t.id = g.trabajador_id;

-- ---------------------------------------------------------- v_estados_pago
drop view if exists v_estados_pago;
create view v_estados_pago as
  select e.id, e.mes, e.instalacion_id, e.estado, e.enviado_en, e.folio_factura,
         e.nota, e.creado_en, e.creado_por, e.actualizado_en,
         i.nombre as instalacion,
         c.nombre as cliente,
         (select count(*) from estado_pago_archivos a where a.estado_pago_id = e.id)
           as archivos
    from estados_pago e
    join instalaciones i on i.id = e.instalacion_id
    left join clientes c on c.id = i.cliente_id;

-- El Worker entra con la clave de servicio, así que lo que importa es que ese
-- rol las pueda leer. `service_role` no existe en una réplica local, y un
-- `grant` contra un rol que no existe aborta la pasada entera.
do $$
declare v text;
begin
  foreach v in array array['v_documentos', 'v_documentos_generados', 'v_estados_pago'] loop
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant all on %I to service_role', v);
    end if;
  end loop;
end $$;

-- Para que PostgREST las vea sin esperar a que se le caduque el recuerdo del
-- esquema. Supabase lo hace solo con un disparador, pero decirlo no cuesta.
notify pgrst, 'reload schema';

select 'vistas rehechas' as resultado,
       (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'v'
           and c.relname in ('v_documentos','v_documentos_generados','v_estados_pago'))
         as de_tres_quedaron;
