-- =============================================================================
-- Documentos desde plantilla y firma con el dedo (módulo 4)
--
-- El problema real: los contratos se escriben a mano en Word, copiando el del
-- anterior, y se firman en papel en el cambio de turno. Lo que se pierde no es
-- tiempo: es que nadie puede decir después quién firmó qué y cuándo.
--
-- Tres decisiones que explican la forma de estas tablas:
--
--  1. **El texto se congela al generar, no al imprimir.** `documentos_generados`
--     guarda el cuerpo ya armado, no la plantilla más los datos. Si mañana RRHH
--     corrige la plantilla, lo ya firmado sigue diciendo lo que la persona leyó
--     cuando firmó. Guardar la receta en vez del plato obligaría a confiar en
--     que la receta no cambió, que es justo lo que no se puede probar.
--
--  2. **El PDF es una impresión, no el registro.** El registro es el cuerpo
--     congelado más las firmas. Por eso el PDF se puede volver a generar igual
--     cuantas veces se quiera, y por eso perderlo no pierde nada. Para los
--     contratos de trabajo se archiva igual como documento de la persona
--     (`documentos_trabajador`, bucket privado), porque la oficina necesita un
--     archivo que mandar a la Dirección del Trabajo y que entregarle al
--     trabajador.
--
--  3. **La firma guarda con qué se la puede defender.** La firma electrónica
--     simple de la Ley 19.799 vale, pero su valor probatorio depende de poder
--     demostrar quién firmó y cuándo. Ver el comentario de `firmas_documento`.
-- =============================================================================

-- --------------------------------------------------------------- la empresa
--
-- Los datos del empleador estaban escritos dentro de cada contrato de Word, y
-- por eso los tres ejemplos que dejó el gerente traen el mismo correo del
-- representante, que ya no es el que usa. Acá viven una vez.
--
-- `por_confirmar` es el mismo trato que los parámetros de sueldos: lo que el
-- sistema no puede verificar se muestra en ámbar y marca todo documento que lo
-- use, en vez de afirmarlo.
create table if not exists datos_empresa (
  codigo        text primary key,
  valor         text not null,
  glosa         text,
  por_confirmar boolean not null default false,
  actualizado_por text,
  actualizado_en  timestamptz not null default now()
);

insert into datos_empresa (codigo, valor, glosa, por_confirmar) values
  ('razon_social', 'GLOBSEG SPA',
   'Razón social. Los contratos en Word dicen «SEGURIDAD GARRIDOS SpA», que es el nombre de fantasía, con el RUT de GLOBSEG SPA. En un contrato de trabajo manda la razón social: hay que confirmar cuál se firma.', true),
  ('nombre_fantasia', 'Seguridad Garridos', 'Nombre comercial.', false),
  ('rut', '78.095.104-4', 'RUT de la empresa.', false),
  ('domicilio', 'Av. Fontt N° 262, oficina C, comuna de Colina, Santiago',
   'Domicilio de la empresa, el que va en el encabezado del contrato.', false),
  ('representante', 'José Misael Garrido Huinca', 'Representante legal.', false),
  ('representante_rut', '10.705.894-K', 'Cédula del representante legal.', false),
  ('representante_correo', 'contacto.globseg@gmail.com',
   'Correo del representante. Los contratos viejos traen José.garridoh@gmail.com: hay que confirmar cuál va.', true),
  ('ciudad_contrato', 'Santiago de Chile',
   'Ciudad donde se firma y cuyos tribunales se prorrogan.', false)
on conflict (codigo) do nothing;

-- ------------------------------------------------------------- las plantillas
--
-- El cuerpo vive en la base y no en el código por la misma razón que
-- `tipos_documento`: el texto de un contrato cambia por una ley, por una
-- exigencia de un mandante o porque el gerente quiere decirlo de otra manera, y
-- nada de eso debería esperar un despliegue.
--
-- `clase` decide quién puede generarla. 'laboral' lleva sueldo y cuenta
-- bancaria adentro, así que exige el permiso `rrhh`; 'general' se conforma con
-- `documentos`, que es el del prevencionista.
create table if not exists plantillas_documento (
  codigo        text primary key,
  nombre        text not null,
  clase         text not null default 'general',
  -- Qué firma cada quién. El orden es el de la página: el trabajador primero,
  -- la empresa al final, porque la empresa firma lo que el otro ya aceptó.
  firmantes     text not null default 'trabajador,empleador',
  -- Con qué código entra a `documentos_trabajador` cuando se archiva.
  tipo_documento text references tipos_documento(codigo) on delete set null,
  -- Si necesita un contrato cargado para poder armarse.
  requiere_contrato boolean not null default false,
  titulo        text not null,
  cuerpo        text not null,
  -- Lo que el gerente todavía no confirma de esta plantilla. Se muestra en
  -- ámbar antes de generar y queda copiado dentro del documento generado.
  por_confirmar text,
  orden         integer not null default 100,
  activa        boolean not null default true,
  actualizado_por text,
  actualizado_en  timestamptz not null default now(),
  constraint plantilla_clase_valida check (clase in ('laboral', 'general'))
);

-- Los bloques intercambiables. Hoy son las funciones del cargo: el contrato de
-- un guardia y el de un supervisor son el mismo documento salvo esta lista, así
-- que son una plantilla con un bloque y no dos plantillas que hay que mantener
-- en paralelo.
create table if not exists bloques_plantilla (
  codigo  text primary key,
  grupo   text not null default 'funciones',
  rotulo  text not null,
  cuerpo  text not null,
  orden   integer not null default 100,
  activo  boolean not null default true
);

-- ------------------------------------------------------ documentos generados
create table if not exists documentos_generados (
  id          bigint generated always as identity primary key,
  numero      text not null unique,            -- 2026-0001, correlativo por año
  plantilla   text not null references plantillas_documento(codigo) on delete restrict,
  titulo      text not null,

  -- Para los laborales. Un arriendo de camioneta no tiene trabajador, y por eso
  -- las dos columnas son nulables.
  trabajador_id bigint references trabajadores(id) on delete set null,
  contrato_id   bigint references contratos(id) on delete set null,

  -- Lo que se usó para armarlo, tal como estaba ese día. Sirve para explicar de
  -- dónde salió cada cifra sin tener que adivinar qué decía la ficha entonces.
  datos       jsonb not null default '{}'::jsonb,
  -- El texto final. Esto es lo que la persona leyó y lo que el PDF imprime.
  cuerpo      text not null,
  -- SHA-256 del cuerpo. Cada firma guarda el suyo: si alguna vez no calzan, el
  -- sistema puede decir que el texto cambió después de firmado en vez de
  -- mostrar un documento firmado que ya no es el que se firmó.
  cuerpo_hash text not null,
  -- Copiado de la plantilla al generar, para que quede dicho dentro del
  -- documento y no solo en la pantalla que lo creó.
  por_confirmar text,

  estado      text not null default 'por_firmar',
  -- Dónde quedó archivado el PDF, cuando corresponde.
  documento_id bigint references documentos_trabajador(id) on delete set null,

  creado_por  text,
  creado_en   timestamptz not null default now(),
  anulado_por text,
  anulado_en  timestamptz,
  anulado_motivo text,

  constraint docgen_estado_valido
    check (estado in ('por_firmar', 'firmado', 'anulado')),
  -- Anular sin motivo deja un documento muerto que nadie sabe por qué murió.
  constraint docgen_anulado_con_motivo
    check (estado <> 'anulado' or anulado_motivo is not null)
);

create index if not exists docgen_por_trabajador
  on documentos_generados (trabajador_id, estado);

-- ------------------------------------------------------------------- firmas
--
-- Qué se guarda además del trazo, y por qué cada cosa:
--
--   imagen      el trazo en PNG. Solo, no prueba nada: se copia y se pega.
--   firmado_en  la hora del servidor, no la del teléfono. La del aparato la
--               cambia cualquiera en Ajustes, y una firma que no se puede
--               fechar no sirve de respaldo. Es el mismo criterio con que se
--               construyó el libro de asistencia.
--   quien       la cuenta que tenía la sesión abierta. Para el trabajador es su
--               cuenta del libro de asistencia, con la clave que él mismo
--               eligió al primer ingreso: es lo más fuerte que tiene hoy la
--               empresa para amarrar una firma a una persona.
--   nombre/rut  congelados acá, no leídos de la ficha al mostrarlos. Si alguien
--               corrige el RUT en la ficha el año que viene, el documento tiene
--               que seguir diciendo con qué RUT se firmó.
--   cuerpo_hash qué texto estaba firmando. Ver documentos_generados.cuerpo_hash.
--   ip_huella   SHA-256 de la IP con SESION_SECRETO de sal, recortada, igual
--               que en los contactos de la web. La IP pelada no se guarda: una
--               huella sin sal se revierte probando las IPv4 que existen.
--   agente      el navegador y el aparato, tal como se presentó. Es lo que
--               permite decir «se firmó desde un teléfono Android», que es
--               parte de reconstruir el acto.
--
-- Nada de esto convierte la firma en firma electrónica avanzada. Es firma
-- electrónica simple (Ley 19.799, art. 3): vale entre las partes, y lo que se
-- discute en un juicio es si se puede demostrar quién firmó y cuándo. Estas
-- columnas son exactamente para poder demostrarlo.
create table if not exists firmas_documento (
  id          bigint generated always as identity primary key,
  documento_id bigint not null references documentos_generados(id) on delete cascade,
  rol         text not null,
  nombre      text not null,
  rut         text,
  imagen      text not null,
  cuerpo_hash text not null,
  firmado_en  timestamptz not null default now(),
  origen      text not null default 'panel',   -- asistencia | panel
  quien       text,
  ip_huella   text,
  agente      text,
  -- Una firma no se repite ni se corrige: si estaba mal, se anula el documento
  -- y se genera otro. Dejar reescribir una firma sería dejar reescribir la
  -- prueba.
  constraint firma_una_por_rol unique (documento_id, rol),
  constraint firma_origen_valido check (origen in ('asistencia', 'panel'))
);

-- ---------------------------------------------------------------- las vistas
--
-- Va con drop y no con `create or replace`: una migración posterior que le
-- agregue una columna no podría reemplazarla, y reaplicar esta fallaría con
-- «cannot drop columns from view». Ya pasó con v_documentos.
drop view if exists v_documentos_generados;
create view v_documentos_generados as
select g.id, g.numero, g.plantilla, g.titulo, g.estado,
       g.trabajador_id, t.nombre as trabajador, t.rut as trabajador_rut,
       g.contrato_id, g.documento_id, g.por_confirmar,
       g.creado_por, g.creado_en, g.anulado_motivo,
       p.nombre as plantilla_nombre, p.clase, p.firmantes,
       (select count(*) from firmas_documento f where f.documento_id = g.id) as firmas,
       (select count(*) from firmas_documento f
         where f.documento_id = g.id and f.cuerpo_hash <> g.cuerpo_hash) as firmas_descuadradas
  from documentos_generados g
  join plantillas_documento p on p.codigo = g.plantilla
  left join trabajadores t on t.id = g.trabajador_id;

comment on view v_documentos_generados is
  'Listado de documentos generados. No trae el cuerpo ni las imágenes de las firmas: esos se piden de a uno.';

-- =========================================================== las plantillas
--
-- El texto fijo sale de los tres contratos reales que entregó el gerente
-- (Magda González y Juan Patricio Garrido para el contrato nuevo, Héctor Mera
-- para el anexo). Se respetó palabra por palabra salvo tres cosas:
--   - la numeración, que saltaba de CUARTO a SEXTO;
--   - «San Bernando» y «Región de Metropolitana», que ahora salen de los datos
--     de la instalación y no del texto;
--   - la razón social y el correo del representante, que pasaron a
--     `datos_empresa` marcados por confirmar.
--
-- Marcas que entiende el armador (ver src/plantillas.js):
--   {{campo}}            el valor, o «_______» si falta
--   {{#campo}}…{{/campo}} el bloque entero solo si el campo tiene valor
--   {{=bloque}}          el bloque intercambiable elegido (las funciones)

insert into plantillas_documento
  (codigo, nombre, clase, firmantes, tipo_documento, requiere_contrato, titulo, por_confirmar, orden, cuerpo)
values (
  'contrato_trabajo', 'Contrato de trabajo', 'laboral',
  'trabajador,empleador', 'contrato', true, 'CONTRATO DE TRABAJO',
  null,
  10,
$PLANTILLA$En {{ciudad}}, a {{fecha_contrato}} entre {{razon_social}}, RUT N° {{empresa_rut}}, en adelante indistintamente, "la Empresa" o "el Empleador", representada por don {{representante}}, cédula nacional de identidad N.º {{representante_rut}}, correo {{representante_correo}}, ambos domiciliados en {{empresa_domicilio}}, y Sr(a). {{trabajador}}, nacido el {{nacimiento}}, {{nacionalidad}}, cédula nacional de identidad N.º {{rut}}, correo {{correo}}, domiciliado en {{domicilio}}, comuna {{comuna}}, Ciudad {{ciudad_trabajador}}, quién en adelante se denominará "el trabajador", se ha convenido el siguiente Contrato de Trabajo:

PRIMERO. – Por el presente instrumento el Empleador contrata al trabajador para que se desempeñe como {{cargo}}, en los términos en que lo define la ley 3.607, u otro trabajo o función similar, que tenga directa relación con el cargo ya indicado, ubicado en {{lugar_trabajo}}, quien los acepta, y para desarrollar la labor y/o función de:

{{=funciones}}

No obstante, lo anterior, las partes acuerdan que el trabajador pueda ser trasladado de instalación, atendida la naturaleza de los servicios que presta el empleador, esto es proveer servicios de seguridad a terceros que lo requieren, y sin que ello importe menoscabo para el trabajador. Para ello, el empleador dará los avisos en forma y tiempos que exige la ley.

SEGUNDO. - El trabajador cumplirá su jornada de trabajo bajo el sistema excepcional de distribución de jornada y descansos, autorizado por el Director del Trabajo en uso de las facultades conferidas por el artículo 38 del Código del Trabajo, la autorización de un sistema excepcional de distribución de jornada de trabajo y descansos para el personal de guardias de seguridad y vigilantes privados.

LUNES A DOMINGO: 08:00 HORAS A 20:00 HORAS
LUNES A DOMINGO: 20:00 HORAS A 08:00 HORAS

{{turno_glosa}}
{{#resolucion_dt}}Resolución que autoriza el sistema excepcional: N° {{resolucion_dt}}{{#resolucion_vence}}, vigente hasta el {{resolucion_vence}}{{/resolucion_vence}}.{{/resolucion_dt}}

TERCERO. – El trabajador, percibirá un sueldo base mensual de $ {{sueldo}}. ({{sueldo_palabras}}), que será liquidado y pagado, por períodos vencidos hasta el día 5 (cinco), del mes siguiente, y en caso de caer feriado, sábado o domingo, se pagará el día hábil más cercano indicado por calendario.

Gratificación y Asignaciones

{{gratificacion_glosa}}
{{#movilizacion}}Asignación de Movilización: El empleador pagara mensualmente al trabajador el equivalente al valor de $ {{movilizacion}} ({{movilizacion_palabras}}).{{/movilizacion}}
{{#colacion}}Asignación de Colación: El empleador pagara mensualmente al trabajador el equivalente al valor de $ {{colacion}} ({{colacion_palabras}}).{{/colacion}}
{{#asignacion_monto}}{{asignacion_glosa}}: El empleador pagara mensualmente al trabajador el equivalente al valor de $ {{asignacion_monto}} ({{asignacion_palabras}}).{{/asignacion_monto}}
{{#bono_imponible_monto}}{{bono_imponible_glosa}}: El empleador pagara mensualmente al trabajador el equivalente al valor de $ {{bono_imponible_monto}} ({{bono_imponible_palabras}}).{{/bono_imponible_monto}}

Las deducciones que el Empleador podrá según los casos, practicar a las remuneraciones, son todas aquellas que dispone el articulo 58 del Código del Trabajo.

La forma de pago, se enmarcará como lo indica la ley, en efectivo, vía cheque bancario, vale vista bancario o por medio de transferencia bancaria o similar y en caso de que el trabajador por su beneficio y facilidad solicite al EMPLEADOR, alguna otra forma de pago dentro de los sistemas bancarios y/o financieros dispuestos para tales efectos, los valores que la institución financiera le cobre a cada trabajador por efectuar giros y/o cualquier trámite, producto de determinaciones personales del trabajador, éstas serán de absoluto cargo del TRABAJADOR.

De mutuo acuerdo el TRABAJADOR y EL EMPLEADOR, acuerdan que el pago de las remuneraciones al TRABAJADOR, se efectuarán como se indica a continuación:

El pago de la remuneración se hará por transferencia bancaria a:
Banco: {{banco}}
Tipo de cuenta: {{cuenta_tipo}}
Número de cuenta: {{cuenta_numero}}
Rut: {{rut}}
Correo electrónico: {{correo}}

CUARTO. – El trabajador se compromete y obliga expresamente a cumplir las instrucciones que le sean impartidas por su jefe inmediato o por la gerencia de la empresa, en relación con su trabajo y acatar en todas sus partes las normas del Reglamento Interno de Orden, Higiene y Seguridad, las que declara conocer y que forman parte integrante del presente contrato, reglamento del cual se le entrega un ejemplar.

QUINTO: Las partes declaran y dejan expresa constancia que Sr(a). {{trabajador}} ingresó al servicio de la Empresa con fecha: {{fecha_ingreso}}.

SEXTO: {{vigencia_texto}}

SÉPTIMO. - El presente contrato se firma en Dos ejemplares, declarando el trabajador haber recibido en este acto un ejemplar de dicho instrumento, que es el fiel reflejo de la relación laboral convenida.

El empleador se obliga a mantener en el lugar de trabajo un ejemplar firmado de este contrato, asimismo, deberá registrar este contrato en el sitio web de la Dirección del Trabajo (www.direcciondeltrabajo.cl).

OCTAVO. - Para todos los efectos derivados del presente contrato las partes fijan domicilio en la ciudad de {{ciudad_jurisdiccion}} y se someten a la Jurisdicción de sus Tribunales.$PLANTILLA$
) on conflict (codigo) do nothing;

insert into plantillas_documento
  (codigo, nombre, clase, firmantes, tipo_documento, requiere_contrato, titulo, por_confirmar, orden, cuerpo)
values (
  'anexo_contrato', 'Anexo: actualización de contrato', 'laboral',
  'trabajador,empleador', 'anexo', true,
  'ANEXO CONTRATO DE TRABAJO' || chr(10) || '(ACTUALIZACIÓN DE CONTRATO)',
  null, 20,
$PLANTILLA$En {{ciudad}}, a {{fecha_contrato}} entre {{razon_social}}, RUT N° {{empresa_rut}}, en adelante indistintamente, "la Empresa" o "el Empleador", representada por don {{representante}}, cédula nacional de identidad N.º {{representante_rut}}, correo {{representante_correo}}, ambos domiciliados en {{empresa_domicilio}}, quien en adelante se denominará indistintamente el "empleador" o la "empresa", por una parte, y por la otra, don(ña) {{trabajador}}, RUT N° {{rut}}, correo {{correo}}, quien en adelante se denominará "el/la trabajador/a", se ha convenido en introducir al contrato de trabajo las siguientes modificaciones:

PRIMERO.- Por el presente acto, las partes acuerdan que a contar del {{desde_funcion}}, don(ña) {{trabajador}}, acepta prestar sus servicios personales a {{razon_social}}, quien los acepta; para desarrollar la labor y/o función de: {{cargo}}.

{{#sueldo}}SEGUNDO.- Por el presente acto e instrumento las partes acuerdan que, a contar del {{desde_sueldo}}, la empresa reajustará el sueldo base del/la trabajador/a, quedando éste en $ {{sueldo}} ({{sueldo_palabras}}) brutos mensuales.{{/sueldo}}

TERCERO: {{vigencia_texto}}

CUARTO: Las partes acuerdan que el trabajador prestará sus funciones en las dependencias de la empresa ubicadas en {{lugar_trabajo}}.

QUINTO: En todo aquello no modificado por el presente instrumento, subsistirán íntegramente las estipulaciones del contrato de trabajo suscrito entre las partes.

El presente Anexo al Contrato Individual de Trabajo se entenderá formar parte integrante del mismo y se extiende en dos ejemplares de igual tenor y fecha, quedando uno en poder de cada parte, declarando el trabajador recibir en este acto su respectiva copia.$PLANTILLA$
) on conflict (codigo) do nothing;

-- ------------------------------------------------- arriendo de camioneta
--
-- De esta no había ejemplo: se redactó. Lleva lo que corresponde a un arriendo
-- de vehículo en Chile —partes, individualización con patente, plazo, renta y
-- forma de pago, uso permitido, multas, seguros, entrega y restitución, término
-- anticipado— y **todo lo que compromete plata o responsabilidad de la empresa
-- y que el gerente no ha confirmado va en `por_confirmar`**, que la pantalla
-- muestra en ámbar antes de generar.
--
-- Lo que a propósito NO dice, porque sería comprometer a la empresa sin que
-- nadie lo haya decidido: no fija garantía, no fija multa por atraso en la
-- restitución, no promete un seguro que la empresa no tiene contratado, y no
-- dice quién paga las mantenciones mayores. Esas cuatro están en la lista de lo
-- que hay que confirmar, y mientras no se confirmen el documento las deja
-- escritas como opción con el valor en blanco.
insert into plantillas_documento
  (codigo, nombre, clase, firmantes, tipo_documento, requiere_contrato, titulo, por_confirmar, orden, cuerpo)
values (
  'arriendo_vehiculo', 'Contrato de arriendo de camioneta', 'general',
  'arrendador,empleador', null, false, 'CONTRATO DE ARRENDAMIENTO DE VEHÍCULO',
  'Esta plantilla se redactó sin un ejemplo previo de la empresa. Antes de usarla, confirme: (1) quién paga las mantenciones periódicas y quién las reparaciones mayores; (2) si se entrega garantía y de cuánto; (3) qué seguro tiene el vehículo y quién lo contrata; (4) si habrá multa por atraso en la restitución. Mientras no se confirmen, el contrato las deja en blanco en vez de comprometer a la empresa.',
  30,
$PLANTILLA$En {{ciudad}}, a {{fecha_contrato}}, entre {{arrendador}}, cédula nacional de identidad N.º {{arrendador_rut}}, domiciliado en {{arrendador_domicilio}}, en adelante "el Arrendador", por una parte; y {{razon_social}}, RUT N° {{empresa_rut}}, representada por don {{representante}}, cédula nacional de identidad N.º {{representante_rut}}, ambos domiciliados en {{empresa_domicilio}}, en adelante "la Arrendataria", por la otra, se ha convenido el siguiente contrato de arrendamiento de vehículo motorizado:

PRIMERO: DEL VEHÍCULO. El Arrendador es dueño del vehículo que se individualiza a continuación, y lo da en arrendamiento a la Arrendataria:
Marca: {{marca}}
Modelo: {{modelo}}
Año: {{anio}}
Placa patente única: {{patente}}
N° de motor: {{motor}}
N° de chasis: {{chasis}}
Color: {{color}}

El Arrendador declara que el vehículo se encuentra a su nombre en el Registro Nacional de Vehículos Motorizados, libre de gravámenes, prohibiciones, embargos y medidas precautorias, y que no pesa sobre él impedimento alguno para ser entregado en arriendo.

SEGUNDO: DESTINO Y USO. El vehículo se destinará exclusivamente al traslado de personal, equipos y materiales propios del giro de la Arrendataria, esto es, servicios de seguridad y vigilancia, incluyendo rondas y traslados a las instalaciones que la Arrendataria resguarda. La Arrendataria no podrá subarrendar ni ceder el vehículo a ningún título sin autorización escrita del Arrendador.

Solo podrán conducir el vehículo trabajadores de la Arrendataria con licencia de conducir vigente de la clase que corresponda, autorizados por escrito por la Arrendataria.

TERCERO: PLAZO. El presente contrato regirá desde el {{desde}} hasta el {{hasta}}. {{renovacion_glosa}}

CUARTO: RENTA Y FORMA DE PAGO. La renta de arrendamiento será la suma de $ {{renta}} ({{renta_palabras}}) mensuales, que la Arrendataria pagará por mes vencido, dentro de los primeros {{dia_pago}} días del mes siguiente, mediante transferencia bancaria a la cuenta que el Arrendador indique. El Arrendador deberá emitir el documento tributario que corresponda.

QUINTO: ENTREGA. El vehículo se entrega en este acto en el estado en que se encuentra, que la Arrendataria declara conocer y aceptar. Se deja constancia del kilometraje de entrega: {{kilometraje}} km, y que el vehículo se entrega con {{combustible}} de combustible. Las partes levantarán un acta de entrega con el estado y los accesorios, que se entenderá parte integrante de este contrato.

SEXTO: COMBUSTIBLE, PEAJES Y MANTENCIÓN. El combustible, los peajes y el lavado serán de cargo de la Arrendataria. {{mantencion_glosa}}

SÉPTIMO: MULTAS E INFRACCIONES. Las infracciones de tránsito, multas, partes empadronados y cualquier sanción que se curse durante la vigencia de este contrato por hechos ocurridos mientras el vehículo esté en poder de la Arrendataria serán de cargo exclusivo de ésta, aunque se notifiquen al Arrendador por figurar como propietario registral. La Arrendataria se obliga a pagarlas dentro de los plazos legales y a reembolsar al Arrendador cualquier suma que éste deba desembolsar por tal concepto.

Los impuestos, el permiso de circulación y la revisión técnica serán de cargo del Arrendador, por ser obligaciones del propietario.

OCTAVO: SEGUROS. El Arrendador declara que el vehículo cuenta con el seguro obligatorio de accidentes personales (SOAP) vigente, cuya mantención será de su cargo. {{seguro_glosa}}

NOVENO: RESPONSABILIDAD. La Arrendataria responderá de los daños que sufra el vehículo mientras esté en su poder, salvo los derivados del uso normal y del desgaste natural, y salvo caso fortuito o fuerza mayor. En caso de siniestro, robo o hurto, la Arrendataria dará aviso al Arrendador dentro de las 24 horas siguientes y hará la denuncia que corresponda ante la autoridad competente.

DÉCIMO: RESTITUCIÓN. Al término del contrato la Arrendataria restituirá el vehículo al Arrendador en el domicilio de éste, en el mismo estado en que lo recibió, salvo el desgaste natural por el uso legítimo, con sus documentos y accesorios. {{atraso_glosa}}

UNDÉCIMO: TÉRMINO ANTICIPADO. Cualquiera de las partes podrá poner término anticipado al contrato dando aviso por escrito a la otra con a lo menos {{aviso_dias}} días de anticipación, sin derecho a indemnización alguna. Sin perjuicio de lo anterior, el Arrendador podrá poner término inmediato si la Arrendataria no paga la renta dentro de los plazos pactados, destina el vehículo a un uso distinto del convenido, o lo subarrienda o cede sin autorización.

DUODÉCIMO: GARANTÍA. {{garantia_glosa}}

DÉCIMO TERCERO: DOMICILIO. Para todos los efectos legales derivados del presente contrato, las partes fijan domicilio en la comuna y ciudad de {{ciudad_jurisdiccion}} y se someten a la jurisdicción de sus Tribunales de Justicia.

DÉCIMO CUARTO: EJEMPLARES. El presente contrato se firma en dos ejemplares de igual tenor y fecha, quedando uno en poder de cada parte.$PLANTILLA$
) on conflict (codigo) do nothing;

-- --------------------------------------------------- los bloques por cargo
-- Copiados tal cual de los dos contratos reales.
insert into bloques_plantilla (codigo, grupo, rotulo, orden, cuerpo) values
('funciones_guardia', 'funciones', 'Guardia de seguridad', 10,
$BLOQUE$Vigilancia y resguardo de instalaciones
- Realizar vigilancia preventiva y disuasiva en el interior de las instalaciones asignadas.
- Efectuar rondas continuas durante todo el turno, sin excepciones, cubriendo las áreas determinadas por la empresa.
- Controlar accesos de personas, vehículos y materiales, verificando autorizaciones cuando corresponda.

Reportes y comunicación
- Enviar al inicio de cada ronda un reporte con ubicación georreferenciada y fotografía que certifique presencia en la instalación.
- Informar de manera inmediata cualquier novedad, anomalía, incidente o situación de riesgo detectada durante el servicio.
- Completar informes diarios al finalizar el turno, dejando constancia de las actividades realizadas y observaciones relevantes.

Cumplimiento de normas y protocolos
- Acatar estrictamente las normas de seguridad de la empresa y de la instalación a resguardar.
- Usar correctamente el uniforme y los implementos de seguridad personal entregados por la empresa.
- Mantener una conducta intachable, respetuosa y profesional con clientes, usuarios, visitas y compañeros de trabajo.
- No abandonar el puesto ni delegar funciones sin autorización expresa.

Reacción ante emergencias
- Responder de manera inmediata ante emergencias como incendios, accidentes, desórdenes, intentos de intrusión u otros eventos que pongan en riesgo a las personas o bienes.
- Dar aviso oportuno a Carabineros, Bomberos, SAMU u otras autoridades competentes, según corresponda.
- Apoyar los planes de evacuación y seguridad establecidos por la empresa y/o el cliente.

Otras responsabilidades
- Velar por la correcta conservación de los equipos, herramientas y dispositivos entregados para la labor (radios, linternas, cámaras, chalecos, etc.).
- Cumplir con la política de confidencialidad, absteniéndose de divulgar información relativa a las instalaciones o servicios prestados.
- Participar en capacitaciones y entrenamientos cuando la empresa lo requiera.$BLOQUE$),
('funciones_supervisor', 'funciones', 'Supervisor de guardias', 20,
$BLOQUE$1- Supervisar, coordinar y dirigir al personal de seguridad bajo su responsabilidad.
2- Planificar, organizar y distribuir las tareas operativas del equipo de seguridad.
3- Controlar la correcta aplicación de los procedimientos de seguridad, de acuerdo con la normativa vigente y protocolos internos.
4- Prevenir, detectar y gestionar incidentes o situaciones de riesgo, adoptando medidas inmediatas y reportando a la administración.
5- Mantener comunicación permanente con la administración y, cuando corresponda, con los clientes.
6- Capacitar y retroalimentar al personal en funciones, procedimientos y protocolos de actuación.
7- Realizar inspecciones en terreno para verificar el cumplimiento de funciones y condiciones de seguridad.
8- Ejecutar labores de gestión administrativa tales como reportes, registros de asistencia, informes e instrucciones operativas.$BLOQUE$)
on conflict (codigo) do nothing;

-- ------------------------------------------------------------- la dirección
-- El contrato dice dónde queda la instalación con calle y número; la tabla solo
-- tenía comuna y región, así que ese dato se escribía a mano cada vez.
alter table instalaciones add column if not exists direccion text;

comment on column instalaciones.direccion is
  'Calle y número. Va en la cláusula PRIMERO del contrato de trabajo; sin esto hay que escribirla a mano en cada contrato.';
