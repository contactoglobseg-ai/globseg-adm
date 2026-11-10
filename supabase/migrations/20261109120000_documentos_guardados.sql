

-- Los documentos de prevención se guardan una vez, y la firma va donde
-- corresponde (09-11-2026).
--
-- Dos pedidos del gerente, mirando el IRL de verdad de la empresa:
--
--  1. **Que quede almacenado** y se pueda mandar a firmar sin volver a subirlo
--     cada vez. El IRL son 34 hojas y 5,5 MB: subirlo cada mes es el trámite
--     que hace que no se mande.
--  2. **Que la firma vaya donde corresponde.** Hoy se estampa al pie de todas
--     las hojas, y eso era lo correcto mientras el sistema no supiera nada del
--     documento. El IRL de la empresa tiene **un solo recuadro de firma, en la
--     hoja 1** —«IDENTIFICACIÓN DEL TRABAJADOR», al lado de «INSTRUCTOR»—, así
--     que estampar 34 veces no solo sobra: deja la firma en 33 lugares donde
--     el documento no la pide.
--
-- **Las posiciones se marcan sobre el PDF, no se configuran con números.**
-- Nadie sabe de memoria que la firma del IRL va al 62% del ancho y al 78% del
-- alto de la hoja 1. Se abre el documento, se hace clic donde va, y queda. Por
-- eso se guardan en **proporción del tamaño de la página** (0 a 1) y no en
-- puntos: así valen igual en una hoja carta que en una oficio, y el mismo
-- número sirve para dibujar el recuadro en pantalla y para estampar en el PDF.
--
-- `firmas` vacío significa **al pie de todas las hojas**, que es lo que hacía
-- el sistema hasta hoy. Un documento guardado sin marcar sigue funcionando
-- como antes en vez de quedarse sin firma.
--
-- Se puede correr las veces que sea.

create table if not exists documentos_guardados (
  id            bigint generated always as identity primary key,
  -- Con qué código se archiva en la ficha de cada uno, igual que en el envío.
  tipo_documento text references tipos_documento(codigo) on delete set null,
  -- Cómo lo llama la oficina: «IRL GLOBSEG 2026». Es lo que se elige al mandar.
  nombre        text not null,

  archivo_ruta   text not null,
  archivo_nombre text,
  archivo_tipo   text,
  archivo_bytes  bigint,
  archivo_paginas integer,
  -- SHA-256 de los bytes. El mismo que después guarda cada firma, así que un
  -- documento guardado y los que salieron de él comparten huella.
  cuerpo_hash   text not null,

  -- Dónde va cada firma: [{"pagina":1,"x":0.62,"y":0.78,"ancho":0.22}].
  -- `x` e `y` son la esquina superior izquierda del recuadro, en proporción,
  -- medidas **desde arriba** como se ven en pantalla; el sellado las da vuelta
  -- para pdf-lib, que mide desde abajo. Vacío = al pie de todas las hojas.
  firmas        jsonb not null default '[]'::jsonb,

  -- Un documento no se borra: se da de baja. El IRL del año pasado es el que
  -- firmó la gente del año pasado, y su archivo tiene que seguir ahí.
  vigente       boolean not null default true,

  creado_por    text,
  creado_en     timestamptz not null default now(),
  actualizado_por text,
  actualizado_en  timestamptz,

  constraint docguard_firmas_es_lista check (jsonb_typeof(firmas) = 'array')
);

create index if not exists docguard_vigentes
  on documentos_guardados (tipo_documento) where vigente;

-- ------------------------------------------------ de dónde salió cada envío
alter table documentos_generados
  -- De qué documento guardado salió, cuando salió de uno. Null si se subió
  -- un PDF suelto, que sigue siendo un camino válido.
  add column if not exists guardado_id bigint
    references documentos_guardados(id) on delete set null,
  -- Las posiciones **congeladas al enviar**, por lo mismo que el cuerpo de un
  -- contrato: si mañana alguien mueve el recuadro de firma del documento
  -- guardado, lo que ya se firmó tiene que seguir sellándose donde se firmó.
  add column if not exists firmas_posicion jsonb;

-- ---------------------------------------------------------------- la vista
-- Va con drop y no con `create or replace`: las columnas nuevas quedan en
-- medio y `create or replace view` no sabe agregarlas ahí.
drop view if exists v_documentos_generados;
create view v_documentos_generados as
select g.id, g.numero, g.plantilla, g.titulo, g.estado,
       g.trabajador_id, t.nombre as trabajador, t.rut as trabajador_rut,
       g.contrato_id, g.documento_id, g.por_confirmar,
       g.creado_por, g.creado_en, g.anulado_motivo,
       g.envio_id, g.tipo_documento, g.firma_todas_hojas,
       g.archivo_nombre, g.archivo_paginas,
       g.guardado_id,
       -- Dónde va la firma en ESTE envío, congelado el día que salió. Lo lee
       -- la pantalla que arma el PDF sellado: sin esta columna en la vista,
       -- el sellado cae siempre al pie de todas las hojas aunque la
       -- biblioteca diga otra cosa.
       g.firmas_posicion,
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

drop view if exists v_documentos_guardados;
create view v_documentos_guardados as
select d.*,
       td.nombre as tipo_nombre,
       jsonb_array_length(d.firmas) as puntos_de_firma,
       (select count(*) from documentos_generados g where g.guardado_id = d.id) as veces_enviado
  from documentos_guardados d
  left join tipos_documento td on td.codigo = d.tipo_documento;

comment on view v_documentos_guardados is
  'La biblioteca de documentos de prevención listos para mandar a firmar, con cuántas veces salió cada uno.';
