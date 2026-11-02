

-- Los dos papeles que faltaban en la carpeta del estado de pago (02-11-2026).
--
-- El gerente nombró lo que el mandante le exige, y la carpeta tenía cinco de
-- los siete: faltaban el **certificado de cotizaciones pagadas** (el de
-- Previred, que es lo que prueba que las imposiciones del mes se pagaron) y el
-- **certificado de deuda fiscal de la Tesorería**. Sin ellos la carpeta se
-- armaba igual y el mandante la devolvía.
--
-- `clase` es una restricción y no un catálogo en otra tabla a propósito: son
-- siete nombres que cambian una vez al año, y una tabla aparte obligaría a
-- leerla en cada pantalla para traducir un código a su nombre. El costo es
-- éste: agregar un papel es una migración. Por eso la pantalla **degrada** si
-- no se aplicó —el papel se ve en la carpeta y, al subirlo, el error nombra
-- este archivo en vez de decir «violates check constraint».
--
-- Se puede correr las veces que sea: la restricción se suelta antes de
-- rehacerse, que es lo que `create or replace` no sabe hacer con un check.
alter table estado_pago_archivos
  drop constraint if exists estado_pago_archivos_clase_check;

alter table estado_pago_archivos
  add constraint estado_pago_archivos_clase_check check (clase in (
    'libro_asistencia',
    'cotizaciones_pagadas',
    'libro_remuneraciones',
    'liquidaciones',
    'f30',
    'f30_1',
    'deuda_fiscal',
    'previred',
    'factura',
    'otro'));
