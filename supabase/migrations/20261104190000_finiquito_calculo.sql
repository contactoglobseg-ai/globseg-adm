

-- Un tipo de documento para el cálculo de finiquito, que no es el finiquito.
--
-- El PDF que arma Sueldos → Finiquito es una estimación: lleva el desglose,
-- la causal y las fechas, y dice en el encabezado y en el pie que no es el
-- documento que se firma. Guardarlo bajo el tipo `finiquito` —que el catálogo
-- llama «Finiquito firmado y ratificado»— habría dejado en la ficha una fila
-- que afirma lo contrario de lo que el papel dice adentro. Se vio mirando la
-- ficha después de guardar uno, no leyendo el código.
--
-- Y tiene una segunda consecuencia, que es la que de verdad importa: un
-- documento de tipo `finiquito` **bloquea la edición del contrato**
-- (`finiquitoDe()` en src/rrhh.js), porque lo que se firmó ante ministro de fe
-- son esas condiciones. Un cálculo estimado no puede bloquear nada: se saca
-- para saber cuánto da antes de comprometerlo, y muchas veces se saca dos o
-- tres veces con causales distintas.
--
-- Se corre más de una vez sin problema.
insert into tipos_documento
  (codigo, nombre, grupo, obligatorio, vence, meses_validez, base_legal, orden)
values
  ('finiquito_calculo', 'Cálculo de finiquito (estimado)', 'termino', false, false, null,
   'No es el finiquito. El finiquito se ratifica ante ministro de fe y se paga dentro de 10 días hábiles desde la separación (art. 177 del Código del Trabajo).',
   15)
on conflict (codigo) do nothing;
