

-- Documentos de prevención de riesgos: se sube el PDF y se manda a firmar
-- (02-11-2026).
--
-- Pedido del gerente: que la prevencionista pueda ingresar el IRL —el derecho
-- a saber del DS 40 art. 21— y que los trabajadores lo firmen desde el libro
-- de asistencia, **con la firma en todas las hojas**.
--
-- Tres decisiones que explican toda la forma de esta migración:
--
--  1. **El documento no se arma desde una plantilla de texto: se sube hecho.**
--     El IRL lo redacta la prevencionista en Word, con los riesgos del puesto y
--     de la instalación, y cambia cada vez. Obligarla a escribirlo adentro del
--     sistema sería pedirle que rehaga en una caja de texto lo que ya tiene
--     listo. Por eso `documentos_generados` pasa a aceptar un archivo en vez de
--     un cuerpo, y `cuerpo` deja de ser obligatorio.
--
--  2. **El catálogo es `tipos_documento`, no una plantilla por tipo.** El grupo
--     `prevencion` ya tiene los seis papeles con su base legal y su
--     vencimiento: RIOHS, IRL (vence a los 12 meses), entrega de EPP,
--     capacitación, procedimiento de trabajo seguro y Ley Karin. Sembrar una
--     plantilla por cada uno sería escribir dos veces la misma lista; y como el
--     documento se archiva con ese código, **el vencimiento del IRL entra solo
--     en las alertas de RRHH** sin que nadie lo cargue a mano.
--
--  3. **Un envío, muchos documentos.** El IRL se firma de a uno por ley, pero
--     se entrega a todo un turno de una vez. `envio_id` agrupa las filas que
--     salieron juntas y **el archivo es uno solo**, compartido: mandar el mismo
--     PDF a doce guardias no sube doce copias al bucket. El costo está dicho en
--     src/prevencion.js: anular un documento no borra el archivo, porque es de
--     los otros once también.
--
-- Se puede correr las veces que sea: las restricciones se sueltan antes de
-- rehacerse, que es lo que `create or replace` no sabe hacer con un check.

-- ------------------------------------------------------- la plantilla fuente
--
-- `fuente` dice de dónde sale el documento. 'texto' es lo de siempre —el
-- contrato, el anexo, el arriendo— y 'archivo' es el PDF que alguien subió.
-- Con 'archivo' el cuerpo no existe, así que deja de ser obligatorio.
alter table plantillas_documento alter column cuerpo drop not null;

alter table plantillas_documento
  add column if not exists fuente text not null default 'texto';

-- Si la firma va repetida al pie de cada hoja. Es propio de prevención: lo que
-- en papel se visa hoja por hoja. Vive en la plantilla y no escrito en la
-- pantalla para que mañana se pueda pedir lo mismo de otro documento.
alter table plantillas_documento
  add column if not exists firma_todas_hojas boolean not null default false;

alter table plantillas_documento drop constraint if exists plantilla_clase_valida;
alter table plantillas_documento add constraint plantilla_clase_valida
  check (clase in ('laboral', 'general', 'prevencion'));

alter table plantillas_documento drop constraint if exists plantilla_fuente_valida;
alter table plantillas_documento add constraint plantilla_fuente_valida
  check (fuente in ('texto', 'archivo'));

alter table plantillas_documento drop constraint if exists plantilla_texto_con_cuerpo;
alter table plantillas_documento add constraint plantilla_texto_con_cuerpo
  check (fuente <> 'texto' or cuerpo is not null);

-- ------------------------------------------------------ el documento generado
alter table documentos_generados alter column cuerpo drop not null;

alter table documentos_generados
  add column if not exists archivo_ruta    text,
  add column if not exists archivo_nombre  text,
  add column if not exists archivo_tipo    text,
  add column if not exists archivo_bytes   bigint,
  -- Cuántas hojas tiene. Lo cuenta la pantalla que sube el archivo, que ya
  -- abre el PDF para mostrarlo antes de enviar; es informativo —sirve para
  -- decir «3 hojas» en la lista— y si falta no pasa nada. El sellado cuenta
  -- las hojas de verdad al armar la copia firmada.
  add column if not exists archivo_paginas integer,
  -- Con qué código se archiva en la ficha. Para los documentos de plantilla
  -- sigue saliendo de `plantillas_documento.tipo_documento`; acá lo elige quien
  -- envía, entre los del grupo `prevencion`.
  add column if not exists tipo_documento  text
    references tipos_documento(codigo) on delete set null,
  -- Qué envío los sacó juntos. Null para los de siempre.
  add column if not exists envio_id        text,
  -- Copiado de la plantilla al generar, como `por_confirmar`: lo que valía el
  -- día en que se mandó a firmar, no lo que diga la plantilla el año que viene.
  add column if not exists firma_todas_hojas boolean not null default false;

-- O tiene cuerpo, o tiene archivo. Un documento sin ninguno de los dos es una
-- firma puesta sobre nada.
alter table documentos_generados drop constraint if exists docgen_tiene_contenido;
alter table documentos_generados add constraint docgen_tiene_contenido
  check (cuerpo is not null or archivo_ruta is not null);

create index if not exists docgen_por_envio
  on documentos_generados (envio_id) where envio_id is not null;

-- ------------------------------------------------------------- la plantilla
--
-- Una sola, y el tipo se elige al enviar. No lleva cuerpo ni título fijo: el
-- título lo arma el envío con el nombre del tipo y el de la persona.
--
-- **Firma solo el trabajador.** Un IRL que sale a doce guardias obligaría a la
-- prevencionista a dibujar doce veces su firma en la pantalla, y lo que el DS
-- 40 pide es la constancia de quien recibió la información. Quién informó queda
-- igual escrito: `creado_por` lo guarda y la hoja de registro del PDF lo
-- imprime con la fecha. Si alguna vez se quiere la firma de la empresa, es
-- cambiar este campo a 'trabajador,empleador' y nada más.
insert into plantillas_documento
  (codigo, nombre, clase, fuente, firmantes, firma_todas_hojas, tipo_documento,
   requiere_contrato, titulo, orden, cuerpo)
values (
  'prevencion_archivo', 'Documento de prevención de riesgos', 'prevencion', 'archivo',
  'trabajador', true, null, false, 'DOCUMENTO DE PREVENCIÓN DE RIESGOS', 40, null)
on conflict (codigo) do update set
  clase = excluded.clase, fuente = excluded.fuente, firmantes = excluded.firmantes,
  firma_todas_hojas = excluded.firma_todas_hojas, nombre = excluded.nombre;

-- ---------------------------------------------------------------- las vistas
--
-- Va con drop y no con `create or replace`: las columnas nuevas quedan en
-- medio, y `create or replace view` no sabe reordenar ni agregar ahí.
drop view if exists v_documentos_generados;
create view v_documentos_generados as
select g.id, g.numero, g.plantilla, g.titulo, g.estado,
       g.trabajador_id, t.nombre as trabajador, t.rut as trabajador_rut,
       g.contrato_id, g.documento_id, g.por_confirmar,
       g.creado_por, g.creado_en, g.anulado_motivo,
       g.envio_id, g.tipo_documento, g.firma_todas_hojas,
       g.archivo_nombre, g.archivo_paginas,
       (g.archivo_ruta is not null) as tiene_archivo,
       td.nombre as tipo_nombre,
       p.nombre as plantilla_nombre, p.clase, p.firmantes, p.fuente,
       (select count(*) from firmas_documento f where f.documento_id = g.id) as firmas,
       (select count(*) from firmas_documento f
         where f.documento_id = g.id and f.cuerpo_hash <> g.cuerpo_hash) as firmas_descuadradas
  from documentos_generados g
  join plantillas_documento p on p.codigo = g.plantilla
  left join trabajadores t on t.id = g.trabajador_id
  left join tipos_documento td on td.codigo = g.tipo_documento;

comment on view v_documentos_generados is
  'Listado de documentos generados. No trae el cuerpo ni las imágenes de las firmas: esos se piden de a uno.';

-- Un envío por fila: lo que la prevencionista mandó de una pasada y en qué va.
-- Se consulta así y no contando en la pantalla porque la pregunta que se le
-- hace a esto es «¿quién falta por firmar el IRL de octubre?», y esa se
-- contesta con una consulta, no leyendo trescientas filas.
drop view if exists v_envios_prevencion;
create view v_envios_prevencion as
select g.envio_id,
       min(g.creado_en)                          as creado_en,
       min(g.creado_por)                         as creado_por,
       min(g.tipo_documento)                     as tipo_documento,
       min(td.nombre)                            as tipo_nombre,
       min(g.archivo_nombre)                     as archivo_nombre,
       min(g.archivo_paginas)                    as archivo_paginas,
       count(*)                                  as total,
       count(*) filter (where g.estado = 'firmado')    as firmados,
       count(*) filter (where g.estado = 'por_firmar') as por_firmar,
       count(*) filter (where g.estado = 'anulado')    as anulados
  from documentos_generados g
  left join tipos_documento td on td.codigo = g.tipo_documento
 where g.envio_id is not null
 group by g.envio_id;

comment on view v_envios_prevencion is
  'Los envíos de documentos de prevención, con cuántos firmaron. Un envío es un PDF mandado a varias personas de una vez.';
