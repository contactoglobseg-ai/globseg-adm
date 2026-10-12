-- Hace que la semilla sea de verdad repetible.
--
-- La migración inicial usaba "on conflict do nothing" sobre tarifas y clientes,
-- pero esas tablas no tenían ninguna restricción de unicidad: sin algo con qué
-- chocar, esa cláusula no hace nada y cada corrida vuelve a insertar todo.
-- Correrla dos veces dejaba el tarifario duplicado.
--
-- Primero se limpia lo que haya quedado repetido, después se ponen las
-- restricciones que faltaban.

-- ---------- tarifas: se queda la primera de cada código ----------
delete from tarifas t
 where t.codigo is not null
   and t.id > (select min(t2.id) from tarifas t2 where t2.codigo = t.codigo);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tarifas_codigo_unico') then
    alter table tarifas add constraint tarifas_codigo_unico unique (codigo);
  end if;
end $$;

-- ---------- clientes: se queda el primero de cada nombre ----------
-- Antes de borrar, lo que apuntaba a un duplicado se reapunta al que queda.
update instalaciones i
   set cliente_id = (select min(c2.id) from clientes c2
                      where c2.nombre = (select c.nombre from clientes c where c.id = i.cliente_id))
 where exists (select 1 from clientes c where c.id = i.cliente_id);

update cotizaciones q
   set cliente_id = (select min(c2.id) from clientes c2
                      where c2.nombre = (select c.nombre from clientes c where c.id = q.cliente_id))
 where q.cliente_id is not null
   and exists (select 1 from clientes c where c.id = q.cliente_id);

delete from clientes c
 where c.id > (select min(c2.id) from clientes c2 where c2.nombre = c.nombre);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clientes_nombre_unico') then
    alter table clientes add constraint clientes_nombre_unico unique (nombre);
  end if;
end $$;

-- ---------- instalaciones: no repetir el mismo nombre por cliente ----------
delete from instalaciones i
 where i.id > (select min(i2.id) from instalaciones i2
                where i2.nombre = i.nombre and i2.cliente_id = i.cliente_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'instalaciones_nombre_unico') then
    alter table instalaciones add constraint instalaciones_nombre_unico unique (cliente_id, nombre);
  end if;
end $$;

select (select count(*) from tarifas)       as tarifas,
       (select count(*) from clientes)      as clientes,
       (select count(*) from instalaciones) as instalaciones;
