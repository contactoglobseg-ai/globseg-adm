

-- Cotizar en UF.
--
-- (Las dos líneas en blanco de arriba son a propósito: si el editor de
-- Supabase vuelve a comerse el primer carácter al pegar, se come un salto de
-- línea y no SQL. Pasó el 21-10 con los documentos y costó un guion.)
--
-- Una cotización en UF no es una cotización en pesos con otro rótulo: lo que
-- se pacta es la cantidad de unidades, y los pesos los pone el valor de la UF
-- del día en que se factura. Por eso los montos se guardan en la moneda en que
-- se cotizó y no convertidos: convertirlos al guardar sería congelar un precio
-- que justamente se acordó variable.
--
-- Dos cosas cambian en la tabla:
--  1. `moneda` dice en qué está escrita cada cifra de esa cotización.
--  2. Los montos pasan de bigint a numeric. Un peso no se parte, pero una UF
--     se cotiza con dos decimales ("1,8 UF el turno"), y con bigint esa cifra
--     se redondeaba a 2 y la cotización salía con otro precio.
--
-- `uf_valor` es el valor de la UF del día en que se cotizó. Se congela dentro
-- del documento igual que el nombre del cliente: la equivalencia en pesos que
-- se imprimió en el PDF es la de ese día, y tiene que seguir diciendo lo mismo
-- cuando la UF cambie. Queda nulo si nadie lo tenía cargado, y entonces la
-- cotización sale en UF sin equivalencia, que es mejor que una inventada.

-- La vista se va primero y se rehace al final. No es solo por las columnas
-- nuevas: está definida con `c.*`, así que depende de neto, iva y total, y
-- Postgres se niega a cambiarles el tipo mientras la vista exista
-- («cannot alter type of a column used by a view or rule»).
drop view if exists v_cotizaciones;

alter table cotizaciones
  add column if not exists moneda    text not null default 'clp',
  add column if not exists uf_valor  numeric(12,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cotizaciones_moneda_check') then
    alter table cotizaciones
      add constraint cotizaciones_moneda_check check (moneda in ('clp','uf'));
  end if;
end $$;

alter table cotizaciones
  alter column neto  type numeric(14,2),
  alter column iva   type numeric(14,2),
  alter column total type numeric(14,2);

alter table cotizacion_items
  alter column precio_unitario type numeric(14,2),
  alter column subtotal        type numeric(14,2);

create view v_cotizaciones with (security_invoker = true) as
select c.*,
       (select count(*) from cotizacion_items i where i.cotizacion_id = c.id) as n_items,
       (c.fecha + c.validez_dias)                                             as vence,
       (current_date > c.fecha + c.validez_dias)                              as vencida
from cotizaciones c;

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on v_cotizaciones from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on v_cotizaciones to service_role;
  end if;
end $$;
