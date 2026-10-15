-- Correcciones de la oficina en el libro de asistencia.
--
-- El problema real: el guardia entra, termina su turno y se va sin marcar la
-- salida. Esa jornada queda "sin salida" para siempre y sus horas no se pueden
-- contar. Va a pasar seguido, y no se puede resolver dejando que la oficina
-- edite el libro: lo que hace que el libro sirva de respaldo frente a un
-- reclamo es justamente que nadie lo retoca.
--
-- La salida es agregar, nunca sobrescribir. La corrección es una marca MÁS,
-- con la hora real, firmada por quien la puso y con el motivo escrito. La
-- marca del guardia queda intacta al lado.
--
-- Por qué columnas acá y no una tabla `correcciones` aparte:
--   - `marcas` ya es append-only. Nada se sobrescribe de las dos maneras, así
--     que una tabla aparte no agrega ninguna garantía que esta no dé.
--   - Con una tabla aparte, `libro()` tendría que mezclar dos líneas de tiempo
--     para armar una jornada y sumar horas. Dos respuestas posibles a "¿a qué
--     hora salió?" es exactamente el tipo de duda que el libro debe evitar.
--   - Una marca de la oficina es una marca: misma hora, misma fecha de turno,
--     misma instalación. Lo único distinto es quién la escribió y por qué, y
--     eso son tres columnas.
--
-- Cuándo se hizo la corrección no necesita columna nueva: `cuando` es la hora
-- real del turno (en el pasado) y `creada_en` es el instante en que la oficina
-- la tecleó. Ya estaban las dos, y juntas cuentan la historia completa.

alter table marcas add column if not exists origen         text not null default 'guardia';
alter table marcas add column if not exists registrada_por text;
alter table marcas add column if not exists motivo         text;

-- Las marcas que ya existen son todas del guardia: el default las cubre.

alter table marcas drop constraint if exists marcas_origen_valido;
alter table marcas add  constraint marcas_origen_valido
  check (origen in ('guardia', 'oficina'));

-- Una corrección sin autor o sin motivo no es una corrección: es el libro
-- editado. La base lo rechaza aunque el día de mañana alguien escriba en la
-- tabla sin pasar por el Worker.
alter table marcas drop constraint if exists marcas_correccion_firmada;
alter table marcas add  constraint marcas_correccion_firmada
  check (
    origen <> 'oficina'
    or (registrada_por is not null and motivo is not null and btrim(motivo) <> '')
  );

-- Y al revés: una marca del guardia no lleva firma de la oficina. Si la lleva,
-- alguien la puso a mano y el libro estaría diciendo algo que no es.
alter table marcas drop constraint if exists marcas_guardia_sin_firma;
alter table marcas add  constraint marcas_guardia_sin_firma
  check (origen <> 'guardia' or (registrada_por is null and motivo is null));

-- Las correcciones son pocas y se consultan por sí solas ("¿qué corrigió la
-- oficina este mes?"), así que el índice va filtrado y no pesa nada.
create index if not exists idx_marcas_corregidas on marcas(creada_en desc)
  where origen = 'oficina';

comment on column marcas.origen is
  'guardia = la marcó él en asistencia.seggarridos.com; oficina = la agregó la oficina como corrección.';
comment on column marcas.registrada_por is
  'Usuario de la oficina que agregó la corrección. Nulo en las marcas del guardia.';
comment on column marcas.motivo is
  'Por qué se agregó. Obligatorio en las correcciones: una corrección sin motivo es el libro editado.';

select 'correcciones listas' as resultado,
       (select count(*) from marcas where origen = 'guardia') as del_guardia,
       (select count(*) from marcas where origen = 'oficina') as de_la_oficina;
