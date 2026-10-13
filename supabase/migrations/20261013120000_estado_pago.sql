-- Estado de cobranza, separado del estado del documento.
--
-- Hasta ahora un periodo con factura emitida quedaba "cerrado" y en verde,
-- aunque el cliente no hubiera pagado. Eso oculta justo lo que importa: la
-- diferencia entre haber facturado y haber cobrado.
--
-- Son dos cosas distintas y se siguen por separado:
--   documento : en_curso -> solicitar_oc -> pendiente_facturacion -> cerrado
--   dinero    : por_cobrar -> pagado | factorizado
--
-- "factorizado" es vender la factura a una empresa de factoring para cobrarla
-- antes. La plata entra, pero no la paga el cliente y casi nunca es el monto
-- completo, por eso se guarda aparte cuánto se recibió de verdad.

alter table ciclos add column if not exists pago_estado text not null default 'por_cobrar';
alter table ciclos add column if not exists pago_fecha  date;
alter table ciclos add column if not exists pago_monto  bigint;
alter table ciclos add column if not exists factoring   text;
alter table ciclos add column if not exists pago_notas  text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ciclos_pago_estado_valido') then
    alter table ciclos add constraint ciclos_pago_estado_valido
      check (pago_estado in ('por_cobrar','pagado','factorizado'));
  end if;
end $$;

create index if not exists idx_ciclos_pago on ciclos(pago_estado);

comment on column ciclos.pago_monto is
  'Lo que entró de verdad. En factoring suele ser menor que el total por el descuento.';

-- La vista suma los días desde la factura: una factura de hace 70 días sin
-- pagar es un problema distinto a una de hace 5.
--
-- Se elimina y se crea de nuevo en vez de reemplazarla: al agregar columnas a
-- ciclos, el "c.*" cambia la lista de columnas de la vista y Postgres no
-- permite reemplazarla en ese caso.
drop view if exists v_ciclos;
create view v_ciclos with (security_invoker = true) as
select
  c.*,
  s.nombre                        as servicio,
  i.nombre                        as instalacion,
  i.comuna,
  cl.nombre                       as cliente,
  coalesce(e.extras_neto, 0)      as extras_neto,
  coalesce(e.extras_n, 0)         as extras_n,
  coalesce(c.monto_neto, 0) + coalesce(e.extras_neto, 0)              as total_neto,
  round((coalesce(c.monto_neto,0) + coalesce(e.extras_neto,0)) * 0.19) as iva,
  (current_date - c.hasta)        as dias_desde_cierre,
  case when c.factura_fecha is not null then current_date - c.factura_fecha end
                                  as dias_desde_factura
from ciclos c
join servicios s     on s.id  = c.servicio_id
join instalaciones i on i.id  = s.instalacion_id
join clientes cl     on cl.id = i.cliente_id
left join lateral (
  select sum(x.monto_neto) as extras_neto, count(*) as extras_n
  from extras x where x.ciclo_id = c.id
) e on true;

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on v_ciclos from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on v_ciclos to service_role;
  end if;
end $$;

select 'listo' as resultado,
       (select count(*) from ciclos where pago_estado = 'por_cobrar') as por_cobrar;
