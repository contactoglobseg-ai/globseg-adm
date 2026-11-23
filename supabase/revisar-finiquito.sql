-- ¿Por qué no aparece «Cotizaciones pagadas hasta» al armar un finiquito?
--
-- Ese campo —y con él la causal, la fecha de término, la forma de pago y las
-- otras sumas— vive en un bloque que la pantalla dibuja SOLO cuando se dan
-- las tres condiciones de `bloqueFiniquito` en public/rrhh.html:
--
--   1. la plantilla elegida tiene `usa_finiquito = true`  (línea 3644)
--   2. la cuenta puede generar documentos laborales, o sea tiene el módulo
--      `rrhh`                                              (línea 3689)
--   3. la persona tiene un contrato que el sistema encuentra (línea 3507)
--
-- Si falla cualquiera de las tres, el bloque no se dibuja, el campo no existe
-- en pantalla, y al generar el servidor rechaza el documento diciendo que le
-- falta «Mes hasta el que están pagadas las cotizaciones» — un campo que no
-- está en ninguna parte. Es exactamente lo que se ve.
--
-- Este archivo NO escribe nada. Son cuatro consultas, una por condición, y
-- cada una dice qué tiene que contestar. El arreglo va al final, comentado.

-- ---------------------------------------------------------------- 1 de 4
-- ¿Entró la migración 20261105120000_finiquito_documento.sql?
-- `columna_existe` tiene que dar true. Si da false, la migración no corrió.
select exists (
         select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name   = 'plantillas_documento'
            and column_name  = 'usa_finiquito'
       ) as columna_existe;

-- ---------------------------------------------------------------- 2 de 4
-- La plantilla misma. Se lee por `to_jsonb` para que la consulta funcione
-- igual aunque la columna no exista todavía.
--
-- La fila `finiquito` tiene que decir: activa = true, clase = laboral,
-- usa_finiquito = true. Si `usa_finiquito` sale en false o en blanco, ésa es
-- la causa y el arreglo es el `update` del final.
select codigo,
       nombre,
       clase,
       activa,
       to_jsonb(p) ->> 'usa_finiquito'     as usa_finiquito,
       to_jsonb(p) ->> 'requiere_contrato' as requiere_contrato,
       cuerpo like '%{{cotizaciones_hasta}}%' as el_texto_pide_cotizaciones
  from plantillas_documento p
 order by orden, codigo;

-- ---------------------------------------------------------------- 3 de 4
-- Los permisos por rol. `operaciones` —que es el rol de Joaquín— tiene que
-- traer `rrhh` en la lista. Sin ese módulo la plantilla del finiquito le sale
-- apagada en el desplegable y el bloque tampoco se dibuja.
select rol,
       permisos,
       'rrhh' = any(permisos) as abre_documentos_laborales
  from roles_permisos
 order by rol;

-- ---------------------------------------------------------------- 4 de 4
-- Los contratos de la gente dada de baja o con el término ya registrado, que
-- es a quien se le hace un finiquito. Si la persona que Joaquín eligió no
-- aparece acá con alguna fila, el bloque se reemplaza por el aviso «Esta
-- persona no tiene ningún contrato cargado» y el campo tampoco sale.
select t.rut,
       t.nombre || ' ' || coalesce(t.apellido_paterno, '') as persona,
       t.activo as cuenta_activa,
       c.id        as contrato_id,
       c.tipo,
       c.fecha_inicio,
       c.estado,
       c.termino_fecha,
       c.termino_causal
  from trabajadores t
  left join contratos c on c.trabajador_id = t.id
 where t.activo = false
    or c.estado = 'terminado'
 order by c.termino_fecha desc nulls last, t.rut, c.fecha_inicio desc, c.id desc;


-- ---------------------------------------------------------------- el arreglo
-- Correr SOLO si la consulta 2 mostró `usa_finiquito` en false o en blanco y
-- la 1 dio true. Es idempotente y es exactamente lo que dice la migración.
--
--   update plantillas_documento
--      set usa_finiquito = true, activa = true
--    where codigo = 'finiquito';
--
-- Si la consulta 1 dio false, no hay nada que actualizar: hay que pegar
-- supabase/migrations/20261105120000_finiquito_documento.sql entero, copiado
-- con  LC_CTYPE=UTF-8 pbcopy < archivo  (con `pbcopy` a secas los acentos se
-- rompen, y en esta plantilla ya pasó una vez).
