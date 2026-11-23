

-- La carpeta del estado de pago, completa (19-11-2026).
--
-- Pedido del gerente: la carpeta lleva siempre el F30 y el F30-1, el libro de
-- asistencia, la documentación al día de los trabajadores, los contratos y
-- anexos, «y varias cosas más». Esta migración agrega los papeles que faltaban
-- a la lista que acepta `estado_pago_archivos.clase`:
--
--   contratos               Contratos y anexos (los junta el sistema desde las fichas)
--   documentacion_personal  Documentación del personal al día (ídem)
--   comprobante_pago        Comprobante de pago de remuneraciones
--   finiquitos              Finiquitos del mes
--   entrega_epp             Registro de entrega de EPP
--   mutual                  Certificado de la mutual
--   seguro_vida             Póliza de seguro de vida del personal
--   directiva_os10          Directiva de funcionamiento OS-10
--
-- Si no se pega, la carpeta muestra los papeles nuevos igual y, al intentar
-- guardar uno, el aviso nombra este archivo. Los diez de antes siguen andando.
--
-- Se puede correr las veces que sea: la restricción se suelta antes de
-- rehacerse.
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
    'contratos',
    'documentacion_personal',
    'comprobante_pago',
    'finiquitos',
    'entrega_epp',
    'mutual',
    'seguro_vida',
    'directiva_os10',
    'previred',
    'factura',
    'otro'));
