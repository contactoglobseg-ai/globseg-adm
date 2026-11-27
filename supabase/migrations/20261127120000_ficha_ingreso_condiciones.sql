-- Ficha de ingreso: lo que pone la oficina antes de mandar el enlace, y las
-- fotos de los papeles que manda la persona.
--
-- 27-11-2026, pedido de gerencia. La lista que se le pedía a cada persona por
-- WhatsApp tenía dos mitades: lo que sabe el trabajador (sus datos, la foto
-- del carnet, los certificados de AFP y de salud) y lo que decide la empresa
-- (la obra y su dirección, el sueldo, la fecha de ingreso, el tipo de
-- contrato y el cargo). La segunda mitad ahora se llena al generar el enlace,
-- y al aceptar la ficha con eso se arma el contrato.
--
-- `condiciones`: lo de la empresa. No lo ve la persona: el enlace pudo irse a
--   un número equivocado, y el sueldo de alguien no tiene por qué viajar ahí.
-- `archivos`: clave del papel → { ruta, nombre, tipo, bytes, subido_en }.
--   Los archivos viven en el bucket privado `documentos-rrhh`, bajo
--   `ingreso/<id de esta fila>/`, y al aceptar la ficha pasan a ser documentos
--   de la persona sin copiarse: la fila nueva apunta a la misma ruta.
--
-- Se puede correr las veces que sea.

alter table fichas_ingreso add column if not exists condiciones jsonb;
alter table fichas_ingreso add column if not exists archivos jsonb not null default '{}'::jsonb;

comment on column fichas_ingreso.condiciones is
  'Lo que decide la empresa al generar el enlace: instalación, dirección de la obra, sueldo, fecha de ingreso, tipo de contrato y cargo. No se le muestra a la persona.';
comment on column fichas_ingreso.archivos is
  'Fotos o PDF que subió la persona (cédula, certificados de AFP y de salud). Ruta en el bucket privado documentos-rrhh.';

select 'ficha de ingreso: condiciones y archivos listos' as resultado,
       (select count(*) from fichas_ingreso) as fichas;
