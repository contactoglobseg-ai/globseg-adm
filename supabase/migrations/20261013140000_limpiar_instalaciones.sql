-- Saca las instalaciones y el cliente que sembré yo.
--
-- Las puse al armar el sistema, sacadas de un documento de la empresa, para
-- que la pantalla no naciera vacía. Pero Joaquín va a ir creando los parques
-- a medida que correspondan, y una lista precargada que nadie revisó termina
-- siendo una fuente de errores: nombres que no calzan con los de verdad.
--
-- Solo borra lo que nadie esté usando. Si alguna ya tiene un servicio o un
-- servicio extra asociado, se queda: borrarla destruiría datos reales.

delete from instalaciones i
 where i.nombre in ('PMGD San Ramón','PMGD Rengo','PMGD Puelche',
                    'PMGD Loncura','PMGD El Cauce')
   and not exists (select 1 from servicios s where s.instalacion_id = i.id)
   and not exists (select 1 from extras e    where e.instalacion_id = i.id);

delete from clientes c
 where c.nombre = 'Cliente PMGD — falta confirmar el nombre'
   and not exists (select 1 from instalaciones i where i.cliente_id = c.id)
   and not exists (select 1 from cotizaciones q where q.cliente_id = c.id);

select (select count(*) from instalaciones) as instalaciones_restantes,
       (select count(*) from clientes)      as clientes_restantes,
       (select count(*) from tarifas)       as tarifas;
