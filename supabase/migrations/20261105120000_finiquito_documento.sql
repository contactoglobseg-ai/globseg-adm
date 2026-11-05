

-- El finiquito que SÍ se firma.
--
-- Hasta hoy el sistema calculaba el finiquito y lo imprimía como estimación
-- —«Cálculo de finiquito (estimado)», el PDF del 04-11-2026— y ahí se
-- terminaba: el documento con cláusulas, el que se ratifica ante ministro de
-- fe y le da poder liberatorio al empleador, había que escribirlo en Word.
-- Esta migración lo trae al sistema como una plantilla más, igual que el
-- contrato y el anexo, para que se genere con los números del cálculo, se
-- firme con el dedo y quede archivado en la ficha.
--
-- Lo que esto cambia de verdad, y conviene saberlo antes de usarlo: cuando el
-- finiquito firmado se archiva, entra a la ficha con el tipo `finiquito`, y un
-- documento de ese tipo **bloquea la edición del contrato** (ver `finiquitoDe`
-- en src/rrhh.js). Eso es lo correcto y es la diferencia con el cálculo
-- estimado, que a propósito no bloquea nada: lo que se firmó ante ministro de
-- fe son esas condiciones, y corregirlas después dejaría al sistema diciendo
-- una cosa y al papel otra.
--
-- Se corre más de una vez sin problema: un `add column if not exists` y un
-- insert con `on conflict do update`.

-- ---------------------------------------------------------------- la bandera
-- Qué plantillas se arman con el cálculo del finiquito. Es una columna y no el
-- código 'finiquito' escrito dentro del servidor, por lo mismo que
-- `cambia_contrato`: mañana puede haber un segundo finiquito —uno por mutuo
-- acuerdo con texto propio, por ejemplo— y agregarlo tiene que ser una fila y
-- no un despliegue.
alter table plantillas_documento
  add column if not exists usa_finiquito boolean not null default false;

comment on column plantillas_documento.usa_finiquito is
  'La plantilla se arma con el cálculo del finiquito (causal, antigüedad, indemnizaciones, feriado y total). El formulario pide la causal y la fecha de término, y el servidor recalcula: los montos nunca llegan desde la pantalla.';

-- ------------------------------------------------------------- la plantilla
--
-- Lo que este texto a propósito NO hace:
--
--  · No da por pagadas las cotizaciones. La declaración del inciso quinto del
--    artículo 162 es obligatoria y es del empleador, no del sistema: el
--    sistema no sabe si están pagadas. Por eso la cláusula lleva un campo con
--    el mes hasta el que lo están, y sin ese dato el documento no se genera
--    —queda un hueco, y acá un hueco impide generar—. Declarar en un papel
--    firmado algo que nadie comprobó es exactamente lo que este proyecto no
--    hace en ninguna otra pantalla.
--
--  · No inventa la reserva de derechos. Si el trabajador no reserva nada, la
--    cláusula desaparece entera en vez de salir con una línea de guiones o,
--    peor, afirmando que no reserva nada cuando nadie se lo preguntó.
--
--  · No dice que se firma ante ministro de fe, porque no es verdad: acá se
--    firma con el dedo desde un teléfono, y eso es firma electrónica simple de
--    la Ley 19.799. Lo que el texto dice es que **falta** ratificarlo, y que
--    mientras no se ratifique el empleador no puede invocarlo (art. 177 inc.
--    2.º). Decir lo otro habría hecho creer que el trámite ya está hecho, que
--    es justo el que todavía falta.
--
--  · No promete que el pago se hizo. Dice «paga en este acto», que es lo que
--    la ratificación presencia, y deja escrito el plazo de diez días hábiles
--    del artículo 177. El sistema no mueve plata.
--
--  · No cubre la muerte del trabajador (art. 159 N° 3). Ahí el finiquito no lo
--    firma el trabajador sino sus herederos, con las reglas del artículo 60, y
--    los firmantes de esta plantilla son el trabajador y el empleador. El
--    servidor rechaza esa causal con el motivo escrito, en vez de emitir un
--    documento que nadie puede firmar.
insert into plantillas_documento
  (codigo, nombre, clase, firmantes, tipo_documento, requiere_contrato,
   usa_finiquito, titulo, por_confirmar, orden, cuerpo)
values (
  'finiquito', 'Finiquito de contrato de trabajo', 'laboral',
  'trabajador,empleador', 'finiquito', true, true,
  'FINIQUITO DE CONTRATO DE TRABAJO',
  'Las sumas salen del cálculo del sistema, que conoce la indemnización por años de servicio, el mes de aviso y el feriado pendiente. No conoce la remuneración de los días trabajados del último mes, las horas extraordinarias, los bonos del mes ni los anticipos: si corresponden, agréguelos abajo antes de generar. Revise además que las cotizaciones estén pagadas hasta el mes que se declara.',
  30,
$PLANTILLA$En {{ciudad}}, a {{fecha_contrato}}, entre {{razon_social}}, RUT N° {{empresa_rut}}, en adelante "el Empleador", representada por don {{representante}}, cédula nacional de identidad N.º {{representante_rut}}, ambos domiciliados en {{empresa_domicilio}}, por una parte; y por la otra, don(ña) {{trabajador}}, cédula nacional de identidad N.º {{rut}}, domiciliado(a) en {{domicilio}}, comuna de {{comuna}}, en adelante "el/la trabajador/a", se deja constancia del siguiente finiquito de contrato de trabajo:

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

{{/reserva}}{{n}}.- DE LA RATIFICACIÓN. Las partes dejan constancia de que este instrumento se suscribe mediante firma electrónica simple, conforme a la Ley 19.799, y de que deberá ser ratificado ante alguno de los ministros de fe que señala el artículo 177 del Código del Trabajo. Mientras no sea ratificado, el empleador no podrá invocarlo. Se extiende en dos ejemplares de igual tenor y fecha, declarando el/la trabajador/a recibir uno de ellos.$PLANTILLA$
)
on conflict (codigo) do update set
  nombre            = excluded.nombre,
  clase             = excluded.clase,
  firmantes         = excluded.firmantes,
  tipo_documento    = excluded.tipo_documento,
  requiere_contrato = excluded.requiere_contrato,
  usa_finiquito     = excluded.usa_finiquito,
  titulo            = excluded.titulo,
  por_confirmar     = excluded.por_confirmar,
  orden             = excluded.orden,
  cuerpo            = excluded.cuerpo,
  activa            = true;
