-- ¿Qué cotizaciones pudieron salir con un PDF de montos viejos?
-- (19-10-2026, después del arreglo del subtotal de la línea)
--
-- Se pega en el SQL Editor de Supabase. No escribe nada: son dos consultas.
--
-- Qué estaba mal: al guardar una cotización QUE YA EXISTÍA, la pantalla no
-- volvía a pedir lo guardado, así que el PDF descargado en esa misma pasada
-- imprimía los montos de antes de la edición —y $0 en una línea recién
-- agregada—. Lo guardado en la base siempre estuvo bien: el servidor recalcula
-- y congela los montos. El daño posible es un PDF ya enviado a un cliente.
--
-- Por qué esto es una lista de candidatas y no la respuesta: el PDF se arma en
-- el navegador con jsPDF y no pasa por el servidor, así que no queda registro
-- de ninguna descarga. Lo que sí queda es qué cotizaciones se volvieron a
-- guardar desde el editor, que es la única pasada donde el PDF podía mentir.
-- Las que NO aparecen acá nunca estuvieron en riesgo.
--
-- El filtro va por la bitácora y no por cotizaciones.actualizado_en porque un
-- cambio de estado hecho desde la barra de selección (Marcar enviada, aceptada)
-- también toca esa columna y no tiene nada que ver: el editor anota 'editada'
-- y el lote anota 'estado en lote'.

-- 1. Las candidatas, de la edición más reciente a la más antigua.
select c.numero,
       c.cliente_nombre                               as cliente,
       c.cliente_email                                as correo,
       c.fecha,
       c.estado,
       c.total                                        as total_hoy,
       count(b.id)                                    as veces_editada,
       max(b.cuando) at time zone 'America/Santiago'  as ultima_edicion,
       string_agg(distinct b.quien, ', ')             as quienes
from cotizaciones c
join bitacora b
  on b.entidad = 'cotizacion'
 and b.entidad_id = c.id
 and b.accion like 'editada%'
group by c.id
order by max(b.cuando) desc;

-- 2. Para comparar una contra el PDF que se envió: cambiar el número.
--    Si el PDF enviado dice estos mismos montos, esa cotización está bien.
select i.orden, i.descripcion, i.cantidad, i.unidad,
       i.precio_unitario, i.subtotal,
       c.neto, c.iva, c.total
from cotizacion_items i
join cotizaciones c on c.id = i.cotizacion_id
where c.numero = '2026-001'
order by i.orden;
