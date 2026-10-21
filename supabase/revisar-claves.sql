

-- Cómo está cada cuenta del sistema. No escribe nada: se puede pegar en el
-- SQL Editor de Supabase las veces que haga falta.
--
-- La contraseña misma no aparece en ninguna de las tres consultas, porque no
-- está guardada: la columna `clave` tiene una derivación PBKDF2 que no se
-- puede devolver al texto original. Lo que sí se puede saber es quién todavía
-- no eligió la suya y quién quedó bloqueado.
--
-- (Las dos líneas en blanco de arriba son de resguardo: si el editor se come
-- el primer carácter al pegar, se come un salto de línea y no SQL.)

-- 1. Cuentas de la oficina -----------------------------------------------
select usuario,
       nombre,
       rol,
       case when not activo                       then 'DADA DE BAJA'
            when debe_cambiar_clave               then 'SIGUE CON LA CLAVE INICIAL 123321'
            when ultimo_ingreso is null           then 'nunca ha entrado'
            else 'clave propia'
       end                                        as estado_de_la_clave,
       case when bloqueado_hasta > now()
            then 'BLOQUEADA hasta ' || to_char(bloqueado_hasta, 'HH24:MI')
            else '' end                           as bloqueo,
       intentos_fallidos                          as intentos_fallidos_seguidos,
       ultimo_ingreso
  from usuarios
 order by debe_cambiar_clave desc, usuario;

-- 2. Cuentas de los guardias ---------------------------------------------
-- `debe_cambiar_clave` en true quiere decir que sigue entrando con su RUT, y
-- mientras siga así el sistema no lo deja marcar turno ni firmar nada.
select usuario,
       nombre,
       cargo,
       case when not activo                       then 'DADO DE BAJA'
            when debe_cambiar_clave               then 'SIGUE CON EL RUT'
            when ultimo_ingreso is null           then 'nunca ha entrado'
            else 'clave propia'
       end                                        as estado_de_la_clave,
       case when bloqueado_hasta > now()
            then 'BLOQUEADA hasta ' || to_char(bloqueado_hasta, 'HH24:MI')
            else '' end                           as bloqueo,
       ultimo_ingreso
  from trabajadores
 order by debe_cambiar_clave desc, nombre;

-- 3. El resumen en una línea ---------------------------------------------
select 'oficina' as donde,
       count(*)                                        as cuentas,
       count(*) filter (where activo)                  as activas,
       count(*) filter (where activo and debe_cambiar_clave) as con_la_clave_inicial,
       count(*) filter (where bloqueado_hasta > now()) as bloqueadas
  from usuarios
union all
select 'guardias',
       count(*),
       count(*) filter (where activo),
       count(*) filter (where activo and debe_cambiar_clave),
       count(*) filter (where bloqueado_hasta > now())
  from trabajadores;
