-- El archivo de cada documento de RRHH.
--
-- Hasta acá, `documentos_trabajador` guardaba que el papel existe, cuándo vence
-- y un enlace a una carpeta de Drive. Eso resolvía el aviso, que era lo que
-- faltaba; no resolvía el otro problema: cuando el mandante pide la credencial
-- OS-10 de una persona, alguien tiene que ir a buscarla a otro lado. Ahora el
-- archivo puede vivir acá mismo.
--
-- El enlace a Drive NO se saca. Hay documentos que van a seguir viviendo allá
-- —carpetas compartidas, escaneos que ya están ordenados— y romperlos sería
-- perder lo ya cargado para ganar prolijidad. Un documento puede tener archivo,
-- enlace, los dos o ninguno.

alter table documentos_trabajador add column if not exists archivo_ruta       text;
alter table documentos_trabajador add column if not exists archivo_nombre     text;
alter table documentos_trabajador add column if not exists archivo_tipo       text;
alter table documentos_trabajador add column if not exists archivo_bytes      bigint;
alter table documentos_trabajador add column if not exists archivo_subido_por text;
alter table documentos_trabajador add column if not exists archivo_subido_en  timestamptz;

comment on column documentos_trabajador.archivo_ruta is
  'Ruta dentro del bucket privado de Storage. No es una URL: el archivo solo sale por el Worker, que antes mira la sesión.';
comment on column documentos_trabajador.enlace is
  'Carpeta o archivo en Drive. Convive con archivo_ruta: hay documentos que siguen viviendo allá.';

-- Media fila es peor que ninguna: una ruta sin nombre no se puede mostrar y
-- una sin autor no se puede explicar. La base lo rechaza aunque mañana alguien
-- escriba en la tabla sin pasar por el Worker.
alter table documentos_trabajador drop constraint if exists doc_archivo_completo;
alter table documentos_trabajador add  constraint doc_archivo_completo
  check (
    archivo_ruta is null
    or (archivo_nombre     is not null
        and archivo_tipo   is not null
        and archivo_bytes  is not null
        and archivo_subido_por is not null
        and archivo_subido_en  is not null)
  );

-- Dos documentos no pueden apuntar al mismo archivo: borrar uno dejaría al
-- otro mostrando un archivo que ya no está.
create unique index if not exists idx_doc_archivo_ruta
  on documentos_trabajador(archivo_ruta) where archivo_ruta is not null;

-- ---------------------------------------------------------------- la vista
--
-- `v_documentos` se creó con `d.*`, que Postgres expande a la lista de columnas
-- que había **en ese momento**. Agregar columnas a la tabla no las agrega a la
-- vista, y la pantalla de RRHH lee de la vista: sin esto, el archivo quedaría
-- guardado y sin aparecer en ninguna parte.
--
-- Va `drop` y no `create or replace` porque las columnas nuevas se meten en
-- medio de las que ya tenía —antes de `trabajador`, `tipo_nombre` y el resto—
-- y `create or replace` solo admite agregar al final.
drop view if exists v_documentos;
create view v_documentos with (security_invoker = true) as
select
  d.*,
  t.nombre   as trabajador,
  t.rut      as trabajador_rut,
  t.cargo    as trabajador_cargo,
  t.activo   as trabajador_activo,
  td.nombre  as tipo_nombre,
  td.grupo   as tipo_grupo,
  td.obligatorio,
  td.base_legal,
  case
    when not d.vigente                     then 'anulado'
    when d.fecha_vencimiento is null       then 'sin_vencimiento'
    when d.fecha_vencimiento <  current_date then 'vencido'
    when d.fecha_vencimiento <= current_date + 30 then 'por_vencer'
    else 'vigente'
  end as estado,
  (d.fecha_vencimiento - current_date) as dias_para_vencer,
  (d.archivo_ruta is not null)         as tiene_archivo
from documentos_trabajador d
join trabajadores t    on t.id = d.trabajador_id
join tipos_documento td on td.codigo = d.tipo;

-- ---------------------------------------------------------------- el bucket
--
-- Se crea desde acá y no a mano en el panel para que quede escrito qué es y
-- por qué: privado, con tope de tamaño y con la lista de tipos aceptados. Si
-- alguien lo deja público por error, la próxima vez que corra esta migración
-- vuelve a quedar privado.
--
-- El `if exists` es para las pruebas locales: la réplica es Postgres con
-- PostgREST y no tiene el esquema `storage`, así que acá no hace nada. En
-- producción sí existe.
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('documentos-rrhh', 'documentos-rrhh', false, 10485760,
            array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])
    on conflict (id) do update set
      public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;

-- Sin políticas de Storage a propósito, igual que el resto de las tablas: al
-- bucket privado solo entra la clave de servicio, que es la que usa el Worker.
-- Quién puede ver qué se decide en el Worker, donde está la sesión.

select 'archivos de rrhh listos' as resultado,
       (select count(*) from documentos_trabajador where archivo_ruta is not null) as con_archivo,
       (select count(*) from documentos_trabajador) as documentos;
