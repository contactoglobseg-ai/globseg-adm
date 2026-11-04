

-- El anexo de contrato pasa a decir QUÉ CAMBIA.
--
-- Hasta hoy el anexo era una transcripción del que trajo el gerente —el de
-- Héctor Mera, que cambiaba función y sueldo— y por eso decía siempre las
-- mismas tres cosas: que el trabajador pasa a desempeñar tal función, que la
-- empresa le reajusta el sueldo, y dónde presta servicios. Todo eso salía del
-- contrato, así que un anexo por cambio de instalación habría salido diciendo
-- que se le reajusta el sueldo al mismo monto que ya tenía y que pasa al mismo
-- cargo que ya tenía, con la fecha de inicio del contrato en vez de la del
-- cambio. Un documento que se firma no puede afirmar eso.
--
-- Ahora las cláusulas son condicionales y van numeradas por el armador
-- (`{{n}}` en src/plantillas.js): el anexo que solo mueve de instalación lleva
-- dos cláusulas y dice PRIMERO y SEGUNDO. Con los ordinales escritos a mano
-- habría saltado de PRIMERO a TERCERO, que es exactamente el error que traían
-- los contratos originales, donde CUARTO era seguido de SEXTO.
--
-- Se corre más de una vez sin problema: es un update y dos `add column if not
-- exists`.

-- ---------------------------------------------------------------- la bandera
-- Qué plantillas modifican condiciones del contrato. Es una columna y no el
-- código 'anexo_contrato' escrito dentro del servidor porque mañana puede
-- haber un anexo de otra clase —traslado de razón social, pacto de horas
-- extra— y agregarlo tiene que ser una fila, no un despliegue.
alter table plantillas_documento
  add column if not exists cambia_contrato boolean not null default false;

comment on column plantillas_documento.cambia_contrato is
  'La plantilla se arma con lo que cambia del contrato (instalación, cargo, sueldo, turno) y no solo con lo que el contrato dice hoy. El formulario pide qué cambia y desde cuándo rige.';

-- ------------------------------------------------- cuándo se aplicó el anexo
-- Un anexo firmado dice que desde el día tal la persona trabaja en otro
-- parque. Si el sistema no se entera, el estado de pago, el F30-1 y la
-- rotación siguen contándola donde ya no está. Aplicarlo es una decisión de la
-- oficina y por eso es un botón, pero **tiene que quedar dicho si se apretó**:
-- sin esto nadie puede saber qué anexos quedaron en el papel y no en la base.
alter table documentos_generados
  add column if not exists aplicado_en timestamptz;
alter table documentos_generados
  add column if not exists aplicado_por text;

comment on column documentos_generados.aplicado_en is
  'Cuándo se llevó al contrato lo que este anexo modifica. Null es «todavía está solo en el papel».';

-- La vista se rehace para traer esa columna: la lista de documentos tiene que
-- poder mostrar cuál anexo quedó sin aplicar, que es la pregunta que se le
-- hace. Va con drop y no con `create or replace`, que no sabe agregar una
-- columna en medio.
drop view if exists v_documentos_generados;
create view v_documentos_generados as
select g.id, g.numero, g.plantilla, g.titulo, g.estado,
       g.trabajador_id, t.nombre as trabajador, t.rut as trabajador_rut,
       g.contrato_id, g.documento_id, g.por_confirmar,
       g.creado_por, g.creado_en, g.anulado_motivo,
       g.envio_id, g.tipo_documento, g.firma_todas_hojas,
       g.archivo_nombre, g.archivo_paginas,
       g.aplicado_en, g.aplicado_por,
       (g.archivo_ruta is not null) as tiene_archivo,
       td.nombre as tipo_nombre,
       p.nombre as plantilla_nombre, p.clase, p.firmantes, p.fuente,
       p.cambia_contrato,
       (select count(*) from firmas_documento f where f.documento_id = g.id) as firmas,
       (select count(*) from firmas_documento f
         where f.documento_id = g.id and f.cuerpo_hash <> g.cuerpo_hash) as firmas_descuadradas
  from documentos_generados g
  join plantillas_documento p on p.codigo = g.plantilla
  left join trabajadores t on t.id = g.trabajador_id
  left join tipos_documento td on td.codigo = g.tipo_documento;

comment on view v_documentos_generados is
  'Listado de documentos generados. No trae el cuerpo ni las imágenes de las firmas: esos se piden de a uno.';

-- --------------------------------------------------------- el anexo de nuevo
--
-- Las cláusulas que no se usan desaparecen enteras con {{#campo}}…{{/campo}},
-- y {{n}} pone el ordinal que corresponda a las que quedaron.
--
-- Lo que a propósito NO dice:
--  · No cita el artículo 12 (ius variandi), que es la facultad del empleador
--    de cambiar el sitio por su cuenta. Esto es un acuerdo firmado por los
--    dos, así que cita el artículo 11, que es el que obliga a consignar por
--    escrito las modificaciones.
--  · No promete que el traslado no significa gasto ni tiempo de más para el
--    trabajador. Dice que se conviene de común acuerdo, que es lo que la firma
--    prueba, y nada más.
update plantillas_documento set
  nombre = 'Anexo de contrato (cambio de condiciones)',
  titulo = 'ANEXO DE CONTRATO DE TRABAJO',
  cambia_contrato = true,
  cuerpo =
$PLANTILLA$En {{ciudad}}, a {{fecha_contrato}}, entre {{razon_social}}, RUT N° {{empresa_rut}}, en adelante indistintamente "la Empresa" o "el Empleador", representada por don {{representante}}, cédula nacional de identidad N.º {{representante_rut}}, correo {{representante_correo}}, ambos domiciliados en {{empresa_domicilio}}, por una parte; y por la otra, don(ña) {{trabajador}}, cédula nacional de identidad N.º {{rut}}, correo {{correo}}, en adelante "el/la trabajador/a", se ha convenido en introducir al contrato individual de trabajo suscrito entre las partes{{#contrato_desde}} con fecha {{contrato_desde}}{{/contrato_desde}} las siguientes modificaciones:

{{#cambia_instalacion}}{{n}}.- Las partes acuerdan que, a contar del {{rige_desde}}, el/la trabajador/a pasará a prestar sus servicios en {{instalacion_nueva}}, ubicada en {{lugar_trabajo}}{{#instalacion_anterior}}, en reemplazo de {{instalacion_anterior}}, que era el lugar de trabajo convenido hasta esa fecha{{/instalacion_anterior}}. Las partes dejan constancia de que este cambio se conviene de común acuerdo, que las demás condiciones de prestación de los servicios se mantienen sin alteración, y que el/la trabajador/a mantiene su antigüedad para todos los efectos legales.{{/cambia_instalacion}}

{{#cambia_cargo}}{{n}}.- Las partes acuerdan que, a contar del {{rige_desde}}, el/la trabajador/a pasará a desempeñar la labor y/o función de {{cargo}}{{#cargo_anterior}}, en reemplazo del cargo de {{cargo_anterior}}{{/cargo_anterior}}, en los términos en que lo define la ley 3.607.{{/cambia_cargo}}

{{#cambia_sueldo}}{{n}}.- Las partes acuerdan que, a contar del {{rige_desde}}, el sueldo base mensual del/la trabajador/a será de $ {{sueldo}} ({{sueldo_palabras}}) brutos{{#sueldo_anterior}}, en reemplazo de $ {{sueldo_anterior}} ({{sueldo_anterior_palabras}}){{/sueldo_anterior}}. Se mantienen la forma y la oportunidad de pago convenidas en el contrato.{{/cambia_sueldo}}

{{#cambia_turno}}{{n}}.- Las partes acuerdan que, a contar del {{rige_desde}}, el/la trabajador/a cumplirá su jornada en la modalidad de turnos {{turno}}{{#turno_anterior}}, en reemplazo de {{turno_anterior}}{{/turno_anterior}}, respetando la normativa laboral vigente y la autorización del sistema excepcional de distribución de jornada y descansos cuando corresponda.{{/cambia_turno}}

{{#otra_glosa}}{{n}}.- {{otra_glosa}}{{/otra_glosa}}

{{n}}.- En todo aquello no modificado por el presente instrumento subsistirán íntegramente las estipulaciones del contrato individual de trabajo suscrito entre las partes y de sus anexos anteriores.

El presente anexo se extiende conforme a lo dispuesto en el artículo 11 del Código del Trabajo, se entenderá formar parte integrante del contrato individual de trabajo, y se firma en dos ejemplares de igual tenor y fecha, quedando uno en poder de cada parte, declarando el/la trabajador/a recibir en este acto su respectiva copia.$PLANTILLA$
where codigo = 'anexo_contrato';
