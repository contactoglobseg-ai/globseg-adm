-- El ciclo se cuenta por mes, no por 30 días.
--
-- El problema real (reportado el 14-10-2026): un servicio que parte el 15 de
-- junio tiene que cobrarse el 15 de cada mes. Sumando 30 días el aniversario
-- se atrasa uno por cada mes de 31, y en un año el cobro se corre seis días.
--
--   30 días:  15-06 · 15-07 · 14-08 · 13-09 · 12-10 ...
--   mensual:  15-06 · 15-07 · 15-08 · 15-09 · 15-10 ...
--
-- Se guarda el tipo, no las fechas calculadas, para que los periodos se puedan
-- rehacer si alguno quedó mal grabado.
--
-- `dias` sigue existiendo: sirve para lo que de verdad se cobra por bloques,
-- como una quincena o una cantidad de turnos.
--
-- Los servicios que ya existen quedan en 'mensual', que es lo que la oficina
-- quiso siempre. Sus periodos ya grabados **no se tocan acá**: pueden estar
-- facturados. La pantalla de Servicios avisa cuáles quedaron descuadrados y
-- ofrece recalcularlos, que solo mueve los que no tengan factura.

alter table servicios add column if not exists ciclo_tipo text not null default 'mensual';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'servicios_ciclo_tipo_valido') then
    alter table servicios add constraint servicios_ciclo_tipo_valido
      check (ciclo_tipo in ('mensual','dias'));
  end if;
end $$;

comment on column servicios.ciclo_tipo is
  'mensual = mismo día de cada mes (recortado si el mes no lo tiene). dias = bloques de dias_ciclo.';

select ciclo_tipo, count(*) from servicios group by ciclo_tipo;
