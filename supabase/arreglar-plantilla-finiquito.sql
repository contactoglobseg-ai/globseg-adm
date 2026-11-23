

-- Arreglar la plantilla del finiquito: los acentos y una palabra cortada.
--
-- Qué arregla, comprobado comparando lo que hay hoy en la base contra
-- `supabase/migrations/20261105120000_finiquito_documento.sql`:
--
--  1. La mojibake de `pbcopy` sin locale UTF-8 («RATIFICACI√ìN», «cl√°usula»).
--     Está en el cuerpo y también en el aviso de `por_confirmar`, que es el
--     texto en ámbar que se lee antes de generar.
--  2. «cula nacional de identidad» en la primera cláusula, donde dice el RUT
--     del representante legal: se perdieron dos letras y quedó una palabra que
--     no existe, dentro de un documento que se firma. Esto no es mojibake, es
--     texto faltante, y no se arregla volviendo a copiar.
--
-- Lo demás del texto es idéntico al del repositorio, carácter por carácter:
-- no se cambió ninguna cláusula, ningún artículo citado ni ninguna marca
-- {{...}}.
--
-- No toca el contrato ni el anexo. La última consulta de este archivo revisa
-- si a ellos les pasó lo mismo; no escribe nada.
--
-- Se puede correr más de una vez.

update plantillas_documento set
  cuerpo        = $PLANTILLA$En {{ciudad}}, a {{fecha_contrato}}, entre {{razon_social}}, RUT N° {{empresa_rut}}, en adelante "el Empleador", representada por don {{representante}}, cédula nacional de identidad N.º {{representante_rut}}, ambos domiciliados en {{empresa_domicilio}}, por una parte; y por la otra, don(ña) {{trabajador}}, cédula nacional de identidad N.º {{rut}}, domiciliado(a) en {{domicilio}}, comuna de {{comuna}}, en adelante "el/la trabajador/a", se deja constancia del siguiente finiquito de contrato de trabajo:

{{n}}.- DE LA RELACIÓN LABORAL. El/la trabajador/a prestó servicios para el Empleador desde el {{fecha_ingreso}}, desempeñando el cargo de {{cargo}}{{#lugar_trabajo}}, en {{lugar_trabajo}}{{/lugar_trabajo}}, en virtud del contrato individual de trabajo suscrito entre las partes{{#contrato_desde}} con fecha {{contrato_desde}}{{/contrato_desde}}.

{{n}}.- DEL TÉRMINO. La relación laboral terminó con fecha {{fecha_termino}}, por la causal contemplada en el {{causal_texto}}.{{#causal_detalle}} Los hechos en que se funda la causal son los siguientes: {{causal_detalle}}{{/causal_detalle}} A la fecha de término, el/la trabajador/a registra una antigüedad de {{antiguedad}}.

{{n}}.- DE LAS SUMAS QUE SE PAGAN. El Empleador paga en este acto al trabajador/a, y éste/a declara recibir a su entera satisfacción, las siguientes sumas por los conceptos que se indican:

{{detalle_pagos}}

{{#detalle_descuentos}}De las sumas anteriores se deducen los siguientes conceptos, que el/la trabajador/a acepta expresamente:

{{detalle_descuentos}}

{{/detalle_descuentos}}El total líquido que el/la trabajador/a recibe en este acto asciende a la suma de $ {{total}} ({{total_palabras}}).

{{n}}.- DE LA FORMA DE PAGO. {{forma_pago}} Las partes dejan constancia de que el finiquito debe ser pagado dentro de los diez días hábiles siguientes a la separación del trabajador, conforme al inciso final del artículo 177 del Código del Trabajo.

{{n}}.- DE LAS COTIZACIONES PREVISIONALES. El Empleador declara que las cotizaciones previsionales, de salud y de seguro de cesantía del/la trabajador/a se encuentran íntegramente declaradas y pagadas hasta {{cotizaciones_hasta}}, conforme a lo dispuesto en el inciso quinto del artículo 162 del Código del Trabajo, y acompaña en este acto los comprobantes que así lo acreditan.

{{n}}.- DE LA DECLARACIÓN DEL TRABAJADOR. El/la trabajador/a declara que, pagadas las sumas indicadas en este instrumento, no tiene cargo ni cobro alguno que formular en contra del Empleador por concepto de remuneraciones, sobresueldos, horas extraordinarias, feriados legales o proporcionales, gratificaciones, asignaciones, indemnizaciones, cotizaciones de seguridad social, ni por ningún otro concepto derivado de la relación laboral que los unió o de su término, otorgándole en consecuencia el más amplio y total finiquito.

{{#reserva}}{{n}}.- DE LA RESERVA DE DERECHOS. Sin perjuicio de lo señalado en la cláusula anterior, el/la trabajador/a formula expresa reserva de derechos respecto de lo siguiente: {{reserva}}

{{/reserva}}{{n}}.- DE LA RATIFICACIÓN. Las partes dejan constancia de que este instrumento se suscribe mediante firma electrónica simple, conforme a la Ley 19.799, y de que deberá ser ratificado ante alguno de los ministros de fe que señala el artículo 177 del Código del Trabajo. Mientras no sea ratificado, el empleador no podrá invocarlo. Se extiende en dos ejemplares de igual tenor y fecha, declarando el/la trabajador/a recibir uno de ellos.$PLANTILLA$,
  por_confirmar = $AVISO$Las sumas salen del cálculo del sistema, que conoce la indemnización por años de servicio, el mes de aviso y el feriado pendiente. No conoce la remuneración de los días trabajados del último mes, las horas extraordinarias, los bonos del mes ni los anticipos: si corresponden, agréguelos abajo antes de generar. Revise además que las cotizaciones estén pagadas hasta el mes que se declara.$AVISO$
where codigo = 'finiquito';


-- ------------------------------------------------------------ comprobación
-- Las tres columnas tienen que dar `false`. Si alguna da `true`, el texto
-- volvió a entrar con los acentos rotos: se copió con `pbcopy` a secas en vez
-- de `LC_CTYPE=UTF-8 pbcopy < archivo`.
select codigo,
       nombre,
       cuerpo        like '%√%' as cuerpo_roto,
       por_confirmar like '%√%' as aviso_roto,
       cuerpo        like '%cula nacional%' as palabra_cortada,
       length(cuerpo) as largo
  from plantillas_documento
 order by codigo;
