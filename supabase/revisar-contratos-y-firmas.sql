

-- revisar-contratos-y-firmas.sql  (14-11-2026)
-- SOLO LEE. No escribe nada. Se pega en el SQL Editor de Supabase.
--
-- Para qué: saber, persona por persona, si la empresa puede PROBAR el contrato
-- de cada trabajador activo. Nace de los dos guardias que se iban a desvincular
-- y no tenían contrato ni renovaciones firmadas.
--
-- Una fila por trabajador activo. La columna "riesgo" ordena: lo rojo primero.
--   SIN CONTRATO      : no hay contrato vigente cargado en el sistema.
--   SIN FIRMA         : hay contrato, pero ni marcado firmado, ni PDF/enlace
--                       archivado, ni firmado con el dedo por ambas partes.
--   PLAZO VENCIDO     : plazo fijo con fecha de término pasada y sigue vigente:
--                       por art. 159 N°4 lo más probable es que ya sea indefinido.
--   2+ RENOVACIONES   : tuvo dos o más contratos a plazo: la segunda renovación
--                       lo convierte en indefinido.
--   VENCE <=15 DIAS   : plazo fijo que vence pronto: decidir antes de que pase.
--   OK                : contrato vigente con respaldo de firma.

with vig as (
  select distinct on (c.trabajador_id) c.*
    from contratos c
   where c.estado = 'vigente'
   order by c.trabajador_id, c.fecha_inicio desc, c.id desc
),
plazos as (
  select trabajador_id, count(*) as contratos_a_plazo
    from contratos
   where tipo <> 'indefinido' and estado <> 'anulado'
   group by trabajador_id
),
archivado as (                       -- PDF o enlace del contrato en la ficha
  select trabajador_id, bool_or(archivo_ruta is not null or enlace is not null) as tiene
    from documentos_trabajador
   where tipo = 'contrato' and vigente
   group by trabajador_id
),
con_dedo as (                        -- contrato generado y firmado por las dos partes
  select g.trabajador_id, bool_or(g.estado = 'firmado') as tiene
    from documentos_generados g
    join plantillas_documento p on p.codigo = g.plantilla
   where p.tipo_documento = 'contrato' and g.estado <> 'anulado'
   group by g.trabajador_id
),
anexos as (
  select g.trabajador_id,
         count(*) filter (where g.estado = 'firmado')    as anexos_firmados,
         count(*) filter (where g.estado = 'por_firmar') as anexos_sin_firmar
    from documentos_generados g
    join plantillas_documento p on p.codigo = g.plantilla
   where p.tipo_documento = 'anexo'
   group by g.trabajador_id
)
select
  case
    when v.id is null                                                   then '1 SIN CONTRATO'
    when not (coalesce(v.firmado,false) or coalesce(a.tiene,false)
              or coalesce(d.tiene,false))                               then '2 SIN FIRMA'
    when v.tipo <> 'indefinido' and v.fecha_termino < current_date      then '3 PLAZO VENCIDO'
    when coalesce(pl.contratos_a_plazo,0) >= 3                          then '4 2+ RENOVACIONES'
    when v.tipo <> 'indefinido' and v.fecha_termino <= current_date + 15 then '5 VENCE <=15 DIAS'
    else '9 OK'
  end                                   as riesgo,
  t.nombre, t.rut, t.cargo,
  i.nombre                              as instalacion,
  v.tipo, v.fecha_inicio, v.fecha_termino,
  coalesce(v.firmado,false)             as marcado_firmado,
  coalesce(a.tiene,false)               as pdf_archivado,
  coalesce(d.tiene,false)               as firmado_con_dedo,
  coalesce(pl.contratos_a_plazo,0)      as contratos_a_plazo,
  coalesce(x.anexos_firmados,0)         as anexos_firmados,
  coalesce(x.anexos_sin_firmar,0)       as anexos_sin_firmar
from trabajadores t
left join vig v           on v.trabajador_id = t.id
left join plazos pl       on pl.trabajador_id = t.id
left join archivado a     on a.trabajador_id = t.id
left join con_dedo d      on d.trabajador_id = t.id
left join anexos x        on x.trabajador_id = t.id
left join instalaciones i on i.id = t.instalacion_id
where t.activo
order by riesgo, instalacion nulls first, t.nombre;
