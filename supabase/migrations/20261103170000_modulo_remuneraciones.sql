

-- Sueldos, transferencias y carga masiva salen de «Personas» (03-11-2026).
--
-- Decisión del gerente, el mismo día que se le hizo la pestaña a la
-- prevencionista: **que no vea sueldos, transferencias ni carga masiva**.
--
-- Esto corrige en parte lo del 22-10, cuando RRHH se abrió a las cuatro
-- cuentas de oficina. Aquella decisión sigue en pie para operaciones; lo que
-- cambia es que el permiso `rrhh` dejó de ser una sola cosa. Hasta hoy abría
-- las fichas **y** las remuneraciones, y no había forma de dar lo primero sin
-- lo segundo: por eso la prevencionista veía el sueldo, la liquidación y la
-- cuenta bancaria de cada guardia, que es lo que ella no necesita para su
-- trabajo.
--
-- Ahora son dos:
--   `rrhh`            — las fichas, los contratos, los documentos de cada
--                       persona y lo que está por vencer.
--   `remuneraciones`  — Sueldos (liquidación, finiquito y los parámetros de
--                       la ley), Transferencias y Carga masiva.
--
-- Se reparte igual que estaba, menos prevención: gerencia, operaciones y RRHH
-- lo tienen; prevención no. Nadie pierde nada que tuviera, salvo ella.
--
-- **Si esta migración no se pega, todo sigue como el 02-11**: el Worker ve que
-- la tabla no conoce el módulo y se lo da a quien tenga `rrhh`, que es
-- exactamente el reparto de antes. Lo que no puede pasar es que gerencia se
-- quede sin Sueldos esperando que alguien corra esto.
--
-- Se puede correr las veces que sea.

-- ------------------------------------------------- el módulo entra al catálogo
-- Las dos restricciones se sueltan y se rehacen: un `check` no se reemplaza.
alter table roles_permisos drop constraint if exists roles_permisos_modulos_validos;
alter table roles_permisos add constraint roles_permisos_modulos_validos
  check (permisos <@ array['facturacion','cotizaciones','personal',
                           'documentos','rrhh','remuneraciones','usuarios']::text[]);

alter table usuarios drop constraint if exists usuarios_permisos_extra_validos;
alter table usuarios add constraint usuarios_permisos_extra_validos
  check (permisos_extra <@ array['facturacion','cotizaciones','personal',
                                 'documentos','rrhh','remuneraciones','usuarios']::text[]);

-- ------------------------------------------------------------- el reparto
-- A quien ya tenía `rrhh`, menos a prevención. `array_append` con el `where`
-- deja correr esto dos veces sin duplicar el módulo en la lista.
update roles_permisos
   set permisos = array_append(permisos, 'remuneraciones')
 where rol in ('gerencia', 'operaciones', 'rrhh')
   and not ('remuneraciones' = any (permisos));

-- Y la glosa de `rrhh`, que hasta hoy prometía los sueldos que ya no abre.
update roles_permisos
   set descripcion = 'Fichas, contratos, documentos y vencimientos de cada persona.'
 where rol = 'rrhh' and descripcion is not null;
