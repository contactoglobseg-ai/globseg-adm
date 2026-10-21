-- ¿Se aplicó la migración del módulo 4, o PostgREST todavía no la ve?
--
-- Desde fuera las dos cosas se ven igual: /api/diagnostico pregunta por la API
-- REST, y si PostgREST no refrescó su caché de esquema contesta que la tabla no
-- existe aunque esté creada. Esto mira el catálogo de Postgres, que no miente.
--
-- Se pega entero en el SQL Editor. No escribe nada.
--
-- OJO: si el navegador está traduciendo la página de Supabase, apáguela antes
-- («Ver original»). El editor es un CodeMirror y la traducción le reescribe el
-- contenido: se come saltos de línea y convierte `select` en `seleccione`.

-- 1. ¿Están las tablas, la vista y la columna?
--
-- Nada de esto nombra una tabla nueva directamente, así que **funciona igual si
-- no existe ninguna**. La versión anterior de este archivo contaba filas de
-- `plantillas_documento` y por eso moría con «la relación no existe», que es
-- justamente lo que venía a averiguar.
select t.nombre as objeto,
       case when to_regclass('public.' || t.nombre) is null
            then 'NO ESTÁ' else 'ok' end as estado,
       -- Cuántas filas tiene, sin nombrarla: si está vacía, la migración creó
       -- la tabla pero no alcanzó a sembrarla.
       case when to_regclass('public.' || t.nombre) is null then null
            else (xpath('/row/c/text()',
                   query_to_xml('select count(*) as c from public.' || t.nombre,
                                false, true, '')))[1]::text::int
       end as filas
  from (values ('plantillas_documento'), ('bloques_plantilla'),
               ('documentos_generados'), ('firmas_documento'),
               ('datos_empresa'), ('v_documentos_generados')) as t(nombre)
union all
select 'instalaciones.direccion (columna)',
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public'
                            and table_name = 'instalaciones'
                            and column_name = 'direccion')
            then 'ok' else 'NO ESTÁ' end,
       null
order by 1;

-- Lo que tiene que decir si la migración entró bien:
--   plantillas_documento              ok        3
--   bloques_plantilla                 ok        2
--   datos_empresa                     ok        8
--   documentos_generados              ok        0
--   firmas_documento                  ok        0
--   v_documentos_generados            ok        0
--   instalaciones.direccion (columna) ok
