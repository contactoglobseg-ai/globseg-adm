-- Límite de envíos del formulario público.
--
-- /api/contacto es la única ruta sin sesión que escribe en la base, y esta
-- tabla es la bandeja de entrada comercial. El daño de un script suelto no es
-- que se caiga algo: es que el contacto real quede sepultado entre basura.
-- La cuenta se lleva contra esta misma tabla, mirando creado_en por remitente,
-- para no agregar otra pieza que pueda faltar (ver src/limite.js).
--
-- No se guarda la IP sino su huella: SHA-256 de la IP con el secreto de
-- sesiones de sal. Alcanza para contar y no deja un dato personal legible en
-- la tabla. Dura dos días —el límite más largo mira 24 horas, el resto es
-- margen— y la borra el Worker cuando entra un contacto bueno.

alter table contactos add column if not exists ip_huella text;

-- Solo las filas con huella: las viejas y las ya limpiadas no se consultan
-- nunca por esta vía y no tienen para qué ocupar el índice.
create index if not exists idx_contactos_huella
  on contactos(ip_huella, creado_en desc)
  where ip_huella is not null;

select 'limite de contacto listo' as resultado;
