-- Recursos humanos.
--
-- Por qué se construye sobre `trabajadores` y no sobre una tabla nueva:
-- la empresa ya tiene un registro de personas, el del libro de asistencia, con
-- su RUT, su usuario y su instalación. Dos registros de la misma gente es, a
-- los tres meses, dos respuestas distintas a "¿cuántos guardias tenemos?" y un
-- contrato a nombre de alguien que en asistencia aparece de baja. Así que la
-- ficha de RRHH son columnas más en `trabajadores`, y lo que es propio de RRHH
-- —contratos, documentos, ausencias— cuelga de ahí.
--
-- Lo que vive acá es dato sensible de verdad: RUT, dirección, salud, sueldo,
-- cuenta bancaria. Las tablas quedan con RLS activo y sin políticas, igual que
-- el resto: no las lee nadie más que el Worker con la clave de servicio, y
-- adentro del Worker solo el módulo `rrhh`.

-- ================================================================ ficha

-- Datos personales.
alter table trabajadores add column if not exists fecha_nacimiento date;
alter table trabajadores add column if not exists sexo             text;
alter table trabajadores add column if not exists nacionalidad     text;
alter table trabajadores add column if not exists estado_civil     text;
alter table trabajadores add column if not exists email            text;
alter table trabajadores add column if not exists direccion        text;
alter table trabajadores add column if not exists comuna           text;
alter table trabajadores add column if not exists region           text;
alter table trabajadores add column if not exists nivel_estudios   text;

-- Previsionales. Son los que arman la liquidación y los que se declaran en
-- Previred todos los meses; sin ellos no se puede pagar a nadie.
alter table trabajadores add column if not exists afp            text;
alter table trabajadores add column if not exists salud_sistema  text;   -- fonasa | isapre
alter table trabajadores add column if not exists salud_isapre   text;
alter table trabajadores add column if not exists salud_plan_uf  numeric(6,3);
-- Un trabajador con pensión de vejez o invalidez no cotiza para AFP (DL 3.500),
-- y olvidarlo es descontarle plata que no corresponde.
alter table trabajadores add column if not exists jubilado       boolean not null default false;
-- APV y otros descuentos pactados, que se restan después de los legales.
alter table trabajadores add column if not exists apv_monto      bigint;
alter table trabajadores add column if not exists caja_compensacion text;

-- Pago.
alter table trabajadores add column if not exists banco         text;
alter table trabajadores add column if not exists cuenta_tipo   text;
alter table trabajadores add column if not exists cuenta_numero text;

-- Emergencia. En un parque fotovoltaico a 40 km del pueblo, esto es lo primero
-- que se busca cuando pasa algo, y es lo que nunca está anotado.
alter table trabajadores add column if not exists emergencia_nombre     text;
alter table trabajadores add column if not exists emergencia_telefono   text;
alter table trabajadores add column if not exists emergencia_parentesco text;
alter table trabajadores add column if not exists prevision_salud_nota  text;

-- Laborales.
--
-- `fecha_ingreso` es la antigüedad en la empresa, no la fecha del contrato
-- vigente: de ella salen el feriado y la indemnización por años de servicio.
-- Van separadas porque un trabajador puede llevar tres contratos seguidos y la
-- antigüedad es una sola.
alter table trabajadores add column if not exists fecha_ingreso date;
-- Años de trabajo con otros empleadores que el trabajador acreditó. Solo
-- sirven para el feriado progresivo (art. 68), con tope de 10 años.
alter table trabajadores add column if not exists anios_previos integer not null default 0;
-- Saldo de feriado al día en que se cargó la ficha. Sin esto, el sistema
-- calcularía el feriado desde cero para gente que lleva años en la empresa.
alter table trabajadores add column if not exists feriado_saldo_inicial numeric(6,2);
alter table trabajadores add column if not exists feriado_saldo_al      date;

-- Propio del rubro.
alter table trabajadores add column if not exists talla_uniforme  text;
alter table trabajadores add column if not exists talla_zapato    text;
alter table trabajadores add column if not exists licencia_conducir text;
-- Ley 21.015: hay que poder contarlos, y no se puede preguntar cada vez.
alter table trabajadores add column if not exists discapacidad    boolean not null default false;
alter table trabajadores add column if not exists observaciones   text;

alter table trabajadores drop constraint if exists trab_sexo_valido;
alter table trabajadores add  constraint trab_sexo_valido
  check (sexo is null or sexo in ('F','M','X'));
alter table trabajadores drop constraint if exists trab_salud_valida;
alter table trabajadores add  constraint trab_salud_valida
  check (salud_sistema is null or salud_sistema in ('fonasa','isapre'));
alter table trabajadores drop constraint if exists trab_anios_previos;
alter table trabajadores add  constraint trab_anios_previos
  check (anios_previos between 0 and 50);

comment on column trabajadores.fecha_ingreso is
  'Antigüedad en la empresa. De acá salen el feriado y la indemnización por años de servicio, no de la fecha del contrato vigente.';
comment on column trabajadores.anios_previos is
  'Años con otros empleadores acreditados por el trabajador. Solo cuentan para el feriado progresivo (art. 68 CT), con tope de 10.';

-- ================================================================ contratos

-- El contrato es el documento que manda. Todo lo que se paga, el turno que se
-- puede exigir y lo que cuesta un despido salen de acá.
--
-- Se guarda un contrato por periodo, no se edita el anterior: un trabajador
-- que pasó de plazo fijo a indefinido tiene dos contratos, y el primero sigue
-- diciendo lo que decía. Esa es la única forma de responder, dos años después,
-- "¿cuánto ganaba en marzo?".
create table if not exists contratos (
  id             bigint generated always as identity primary key,
  trabajador_id  bigint not null references trabajadores(id) on delete cascade,

  tipo           text not null default 'indefinido',
  fecha_inicio   date not null,
  fecha_termino  date,              -- obligatoria en plazo fijo y por obra
  cargo          text not null,
  instalacion_id bigint references instalaciones(id) on delete set null,

  -- Jornada. Un guardia de parque casi nunca está en el art. 22 común: trabaja
  -- en turnos continuos (art. 38 N°2) o en un sistema excepcional autorizado
  -- por la Dirección del Trabajo, que es el 4x4 o el 7x7. Esa resolución tiene
  -- fecha de vencimiento, y sin ella el turno es ilegal aunque todos lo hayan
  -- trabajado siempre así.
  jornada_tipo   text not null default 'art38_2',
  horas_semanales numeric(4,1),
  turno          text,              -- '4x4 de 12 horas', '7x7', 'lunes a viernes'
  resolucion_dt  text,              -- N° de resolución del sistema excepcional
  resolucion_vence date,
  colacion_minutos integer,

  -- Remuneración pactada.
  sueldo_base    bigint not null check (sueldo_base >= 0),
  gratificacion  text not null default 'legal_25',   -- legal_25 | convencional | sin
  gratificacion_monto bigint,                        -- si es convencional
  colacion       bigint not null default 0,
  movilizacion   bigint not null default 0,
  asignacion_glosa text,
  asignacion_monto bigint not null default 0,
  bono_imponible_glosa text,
  bono_imponible_monto bigint not null default 0,

  estado         text not null default 'vigente',    -- vigente | terminado | anulado
  firmado        boolean not null default false,
  firmado_en     date,

  termino_causal text,
  termino_fecha  date,
  termino_detalle text,

  notas          text,
  creado_por     text,
  creado_en      timestamptz not null default now(),

  constraint contrato_tipo_valido
    check (tipo in ('indefinido','plazo_fijo','por_obra')),
  constraint contrato_jornada_valida
    check (jornada_tipo in ('art22','art38_2','excepcional','parcial','art22_excluido')),
  constraint contrato_estado_valido
    check (estado in ('vigente','terminado','anulado')),
  constraint contrato_gratificacion_valida
    check (gratificacion in ('legal_25','convencional','sin')),
  -- Un plazo fijo sin fecha de término no es un plazo fijo: es un indefinido
  -- que nadie se dio cuenta de que lo era.
  constraint contrato_plazo_con_termino
    check (tipo = 'indefinido' or fecha_termino is not null),
  constraint contrato_fechas_en_orden
    check (fecha_termino is null or fecha_termino >= fecha_inicio),
  -- Un contrato terminado tiene causal y fecha. Sin eso no se puede hacer el
  -- finiquito ni explicar por qué esa persona ya no está.
  constraint contrato_termino_firmado
    check (estado <> 'terminado'
           or (termino_causal is not null and termino_fecha is not null))
);

create index if not exists idx_contratos_trab   on contratos(trabajador_id, fecha_inicio desc);
create index if not exists idx_contratos_estado on contratos(estado);
-- Los dos vencimientos que hay que mirar todas las semanas.
create index if not exists idx_contratos_vence  on contratos(fecha_termino)
  where estado = 'vigente' and fecha_termino is not null;
create index if not exists idx_contratos_resol  on contratos(resolucion_vence)
  where estado = 'vigente' and resolucion_vence is not null;

comment on table contratos is
  'Un contrato por periodo. No se edita el anterior: así se puede responder qué decía el contrato en una fecha pasada.';
comment on column contratos.resolucion_vence is
  'Vencimiento de la resolución de la Dirección del Trabajo que autoriza el sistema excepcional de turnos (art. 38 inc. final CT). Vencida, el turno 4x4 o 7x7 deja de estar autorizado.';

-- ================================================================ documentos

-- Catálogo de lo que hay que tener de cada persona. Está en una tabla y no en
-- el código porque la ley cambia más seguido que el sistema, y porque RRHH
-- tiene que poder agregar el papel que pide un cliente nuevo sin esperar a
-- que alguien despliegue.
create table if not exists tipos_documento (
  codigo      text primary key,
  nombre      text not null,
  grupo       text not null default 'general',
  vence       boolean not null default false,
  meses_validez integer,            -- sugerido; el real se escribe en el documento
  obligatorio boolean not null default false,
  aplica_a    text not null default 'todos',   -- todos | guardia | conductor
  base_legal  text,
  orden       integer not null default 100,
  activo      boolean not null default true
);

-- Lo que una empresa de seguridad privada tiene que poder mostrar, de cada
-- trabajador, el día que llegue una fiscalización de la Inspección del Trabajo
-- o una auditoría del mandante. No es una lista de buenas intenciones: cada
-- línea es un papel que alguien pide.
insert into tipos_documento
  (codigo, nombre, grupo, vence, meses_validez, obligatorio, aplica_a, base_legal, orden) values
  -- Contratación
  ('contrato',        'Contrato de trabajo firmado',            'contratacion', false, null, true,  'todos',     'Art. 9 y 10 Código del Trabajo. Escriturado dentro de 15 días (5 si es por obra o faena, o de menos de 30 días).', 10),
  ('anexo',           'Anexo de contrato',                      'contratacion', false, null, false, 'todos',     'Art. 11 CT: toda modificación se consigna por escrito al dorso o en anexo.', 20),
  ('cedula',          'Cédula de identidad (copia)',            'contratacion', true,  null, true,  'todos',     null, 30),
  ('antecedentes',    'Certificado de antecedentes',            'contratacion', true,  3,    true,  'guardia',   'Exigido para el personal de seguridad privada. El certificado se emite con vigencia acotada.', 40),
  ('estudios',        'Certificado de enseñanza media',         'contratacion', false, null, true,  'guardia',   'Requisito de formación del personal de seguridad privada.', 50),
  ('afiliacion',      'Certificados de AFP y salud',            'contratacion', false, null, true,  'todos',     null, 60),
  ('cuenta_banco',    'Comprobante de cuenta bancaria',         'contratacion', false, null, false, 'todos',     null, 70),

  -- Seguridad privada (OS-10)
  ('os10_credencial', 'Credencial de guardia (OS-10)',          'os10',         true,  24,   true,  'guardia',   'Autorización de Carabineros (OS-10) para desempeñarse como guardia de seguridad. Sin credencial vigente la persona no puede hacer turno.', 100),
  ('os10_curso',      'Curso de formación de guardias (OS-10)', 'os10',         true,  24,   true,  'guardia',   'Curso impartido por entidad reconocida por la Prefectura de Seguridad Privada. Exige reentrenamiento periódico.', 110),
  ('os10_nombramiento','Nombramiento o lista de personal OS-10','os10',         true,  null, false, 'guardia',   'Nómina de personal informada a la autoridad fiscalizadora.', 120),

  -- Salud ocupacional
  ('examen_preocup',  'Examen preocupacional',                  'salud',        true,  12,   true,  'todos',     'DS 594 y protocolos del organismo administrador.', 200),
  ('examen_psico',    'Batería psicosensotécnica',              'salud',        true,  12,   true,  'guardia',   'Evaluación psicológica y sensorial exigida para funciones de vigilancia.', 210),
  ('examen_altura',   'Examen de trabajo en altura física',     'salud',        true,  12,   false, 'todos',     'Protocolo del organismo administrador. Aplica en faenas con trabajo sobre 1,8 m.', 220),
  ('examen_altura_geo','Examen de altura geográfica',           'salud',        true,  12,   false, 'todos',     'Guía técnica de exposición a hipobaria intermitente crónica por gran altitud (sobre 3.000 msnm). Aplica a faenas en el norte.', 230),
  ('licencia_medica', 'Licencia médica',                        'salud',        false, null, false, 'todos',     null, 240),

  -- Prevención de riesgos
  ('riohs',           'Recepción del RIOHS',                    'prevencion',   false, null, true,  'todos',     'Art. 156 CT: entrega del Reglamento Interno de Orden, Higiene y Seguridad, con constancia.', 300),
  ('irl',             'Derecho a saber (IRL)',                  'prevencion',   true,  12,   true,  'todos',     'DS 40 art. 21: obligación de informar los riesgos laborales, firmada por el trabajador.', 310),
  ('epp',             'Entrega de EPP',                         'prevencion',   false, null, true,  'todos',     'DS 594 art. 53: los elementos de protección se entregan sin costo y queda registro.', 320),
  ('capacitacion',    'Capacitación o inducción',               'prevencion',   true,  12,   false, 'todos',     null, 330),
  ('pts',             'Procedimiento de trabajo seguro firmado','prevencion',   false, null, false, 'todos',     null, 340),
  ('ley_karin',       'Protocolo Ley Karin (acoso y violencia)','prevencion',   false, null, true,  'todos',     'Ley 21.643: protocolo de prevención del acoso laboral, sexual y violencia en el trabajo, informado a cada trabajador.', 350),

  -- Conducción
  ('licencia_conducir','Licencia de conducir',                  'conduccion',   true,  null, false, 'conductor', 'Exigible al personal que hace rondas en vehículo.', 400),
  ('hoja_vida_conductor','Hoja de vida del conductor',          'conduccion',   true,  3,    false, 'conductor', null, 410),

  -- Término
  ('carta_aviso',     'Carta de aviso de término',              'termino',      false, null, false, 'todos',     'Art. 162 CT.', 500),
  ('finiquito',       'Finiquito firmado y ratificado',         'termino',      false, null, false, 'todos',     'Art. 177 CT: se ratifica ante ministro de fe.', 510),

  ('otro',            'Otro documento',                         'general',      false, null, false, 'todos',     null, 900)
on conflict (codigo) do update set
  nombre = excluded.nombre, grupo = excluded.grupo, vence = excluded.vence,
  meses_validez = excluded.meses_validez, obligatorio = excluded.obligatorio,
  aplica_a = excluded.aplica_a, base_legal = excluded.base_legal, orden = excluded.orden;

-- El papel de cada persona.
--
-- No se guarda el archivo: se guarda que existe, cuándo vence y dónde está.
-- La empresa ya tiene sus carpetas; lo que no tiene es quién le avise que la
-- credencial de alguien venció la semana pasada y lleva cinco turnos hechos
-- sin ella.
create table if not exists documentos_trabajador (
  id            bigint generated always as identity primary key,
  trabajador_id bigint not null references trabajadores(id) on delete cascade,
  contrato_id   bigint references contratos(id) on delete set null,
  tipo          text not null references tipos_documento(codigo) on delete restrict,
  glosa         text,
  numero        text,
  fecha_emision date,
  fecha_vencimiento date,
  enlace        text,               -- carpeta o archivo en Drive
  observacion   text,
  vigente       boolean not null default true,
  creado_por    text,
  creado_en     timestamptz not null default now(),

  constraint doc_fechas_en_orden
    check (fecha_vencimiento is null or fecha_emision is null
           or fecha_vencimiento >= fecha_emision)
);

create index if not exists idx_doc_trab  on documentos_trabajador(trabajador_id, tipo);
create index if not exists idx_doc_vence on documentos_trabajador(fecha_vencimiento)
  where vigente and fecha_vencimiento is not null;

-- ================================================================ ausencias

-- Todo lo que hace que alguien no esté en su turno, en un solo lugar.
--
-- Va junto a propósito: la pregunta de RRHH no es "¿cuántas licencias hay?",
-- es "¿quién no viene esta semana y por qué?". Separar vacaciones de licencias
-- obliga a mirar dos listas para responderla.
create table if not exists ausencias (
  id            bigint generated always as identity primary key,
  trabajador_id bigint not null references trabajadores(id) on delete cascade,
  tipo          text not null,
  desde         date not null,
  hasta         date not null,
  dias_habiles  numeric(5,2),       -- los que descuentan feriado
  dias_corridos integer,
  folio         text,               -- N° de licencia médica, de resolución
  motivo        text,
  estado        text not null default 'aprobada',
  con_goce      boolean not null default true,
  aprobada_por  text,
  creado_por    text,
  creado_en     timestamptz not null default now(),

  constraint ausencia_tipo_valido check (tipo in (
    'feriado',              -- vacaciones legales
    'feriado_progresivo',
    'licencia_medica',
    'accidente_trabajo',
    'permiso_legal',        -- nacimiento, matrimonio, fallecimiento (art. 66, 66 bis, 207 bis)
    'permiso_con_goce',
    'permiso_sin_goce',
    'falta_injustificada',
    'suspension',
    'otra')),
  constraint ausencia_estado_valido
    check (estado in ('solicitada','aprobada','rechazada','anulada')),
  constraint ausencia_fechas_en_orden check (hasta >= desde)
);

create index if not exists idx_aus_trab  on ausencias(trabajador_id, desde desc);
create index if not exists idx_aus_rango on ausencias(desde, hasta);

comment on column ausencias.dias_habiles is
  'Días hábiles del periodo. El feriado legal se cuenta en días hábiles de lunes a viernes (art. 69 CT: el sábado se tiene por inhábil).';

-- ================================================================ parámetros

-- Los números que cambian por ley todos los años.
--
-- No van en el código porque el sueldo mínimo, los topes imponibles y el valor
-- de la UF no esperan a que alguien despliegue una versión. Van con fecha de
-- vigencia y no se pisan: el cálculo de un mes pasado tiene que seguir dando
-- lo que dio entonces.
--
-- `por_confirmar` es deliberado: un número que el sistema no tiene cómo
-- verificar se muestra en ámbar en vez de usarse como si fuera cierto. Lo
-- mismo que hace la página web con lo que la empresa todavía no confirma.
create table if not exists parametros_rrhh (
  codigo        text not null,
  vigente_desde date not null,
  valor         numeric(14,4) not null,
  unidad        text not null default 'pesos',   -- pesos | uf | utm | porcentaje | numero
  glosa         text,
  base_legal    text,
  por_confirmar boolean not null default false,
  actualizado_por text,
  actualizado_en  timestamptz not null default now(),
  primary key (codigo, vigente_desde)
);

insert into parametros_rrhh (codigo, vigente_desde, valor, unidad, glosa, base_legal, por_confirmar) values
  ('imm',               '2025-05-01', 529000,  'pesos',      'Ingreso mínimo mensual',                        'Ley 21.751', false),
  ('imm',               '2026-01-01', 539000,  'pesos',      'Ingreso mínimo mensual',                        'Ley 21.751', false),
  ('imm',               '2026-05-01', 553553,  'pesos',      'Ingreso mínimo mensual',                        'Ley 21.830, publicada el 22-06-2026 y con efecto retroactivo al 01-05-2026', false),
  ('imm_menor_mayor',   '2026-05-01', 412938,  'pesos',      'Ingreso mínimo para menores de 18 y mayores de 65', 'Ley 21.830', true),
  ('imm_no_remun',      '2026-05-01', 356815,  'pesos',      'Ingreso mínimo para fines no remuneracionales', 'Ley 21.830 — las fuentes publicadas no coinciden en este tramo. Confirmar en dt.gob.cl.', true),
  ('jornada_semanal',   '2024-04-26', 44,      'numero',     'Horas semanales de jornada ordinaria',          'Ley 21.561', false),
  ('jornada_semanal',   '2026-04-26', 42,      'numero',     'Horas semanales de jornada ordinaria',          'Ley 21.561: 42 horas desde el 26-04-2026 y 40 desde el 26-04-2028', false),
  ('gratif_tope_imm',   '2020-01-01', 4.75,    'numero',     'Tope anual de la gratificación legal, en IMM',  'Art. 50 Código del Trabajo', false),
  ('afp_cotizacion',    '2020-01-01', 10,      'porcentaje', 'Cotización obligatoria de AFP',                 'DL 3.500', false),
  ('salud_cotizacion',  '2020-01-01', 7,       'porcentaje', 'Cotización obligatoria de salud',               'DL 3.500 / Ley 18.933', false),
  ('afc_trabajador',    '2020-01-01', 0.6,     'porcentaje', 'Seguro de cesantía, parte del trabajador (contrato indefinido)', 'Ley 19.728', false),
  ('afc_empleador_ind', '2020-01-01', 2.4,     'porcentaje', 'Seguro de cesantía, parte del empleador (indefinido)',           'Ley 19.728', false),
  ('afc_empleador_plazo','2020-01-01', 3.0,    'porcentaje', 'Seguro de cesantía, parte del empleador (plazo fijo o por obra)','Ley 19.728', false),
  ('sis',               '2020-01-01', 1.53,    'porcentaje', 'Seguro de invalidez y sobrevivencia, lo paga el empleador',      'DL 3.500 — se licita y cambia', true),
  ('mutual_basica',     '2020-01-01', 0.90,    'porcentaje', 'Cotización básica del seguro de accidentes del trabajo',        'Ley 16.744', false),
  ('mutual_adicional',  '2020-01-01', 0,       'porcentaje', 'Cotización adicional diferenciada por riesgo',  'DS 110 — la fija el organismo administrador para GLOBSEG. Hay que ponerla.', true),
  ('sanna',             '2020-01-01', 0.03,    'porcentaje', 'Seguro para el acompañamiento de niños y niñas','Ley 21.063', false),
  ('aporte_empleador_prev','2025-08-01', 1.0,  'porcentaje', 'Aporte del empleador de la reforma previsional', 'Ley 21.735 — sube por tramos. Hay que confirmar el tramo vigente.', true),
  ('tope_imponible_uf', '2025-01-01', 87.8,    'uf',         'Tope imponible de AFP y salud',                 'Lo fija la Superintendencia de Pensiones cada año', true),
  ('tope_afc_uf',       '2025-01-01', 131.8,   'uf',         'Tope imponible del seguro de cesantía',         'Lo fija la Superintendencia de Pensiones cada año', true),
  ('tope_ias_uf',       '2020-01-01', 90,      'uf',         'Tope de la base de cálculo de la indemnización por años de servicio', 'Art. 172 Código del Trabajo', false),
  ('tope_ias_anios',    '2020-01-01', 11,      'numero',     'Tope de años de la indemnización por años de servicio',               'Art. 163 Código del Trabajo', false),
  ('feriado_dias',      '2020-01-01', 15,      'numero',     'Días hábiles de feriado legal por año',         'Art. 67 Código del Trabajo', false),
  ('uf',                '2026-10-01', 0,       'pesos',      'Valor de la UF. Lo escribe RRHH cada mes.',     null, true),
  ('utm',               '2026-10-01', 0,       'pesos',      'Valor de la UTM. Lo escribe RRHH cada mes.',    null, true)
on conflict (codigo, vigente_desde) do nothing;

-- AFP y su comisión. Cambian, así que se editan desde la pantalla.
create table if not exists afps (
  nombre   text primary key,
  comision numeric(5,3) not null,
  activa   boolean not null default true,
  actualizado_en timestamptz not null default now()
);

insert into afps (nombre, comision) values
  ('Capital', 1.44), ('Cuprum', 1.44), ('Habitat', 1.27), ('Modelo', 0.58),
  ('PlanVital', 1.16), ('ProVida', 1.45), ('Uno', 0.49)
on conflict (nombre) do nothing;

-- Impuesto único de segunda categoría, en UTM. Es tabla de ley y cambia poco,
-- pero va en la base igual: el día que cambie no debería hacer falta tocar el
-- código.
create table if not exists tramos_impuesto (
  tramo  integer primary key,
  desde_utm numeric(8,2) not null,
  hasta_utm numeric(8,2),             -- null = sin tope
  factor    numeric(6,4) not null,
  rebaja_utm numeric(8,4) not null
);

insert into tramos_impuesto (tramo, desde_utm, hasta_utm, factor, rebaja_utm) values
  (1, 0,      13.5,  0,      0),
  (2, 13.5,   30,    0.04,   0.54),
  (3, 30,     50,    0.08,   1.74),
  (4, 50,     70,    0.135,  4.49),
  (5, 70,     90,    0.23,   11.14),
  (6, 90,     120,   0.304,  17.80),
  (7, 120,    310,   0.35,   23.32),
  (8, 310,    null,  0.40,   38.82)
on conflict (tramo) do nothing;

-- ================================================================ vistas

-- Cada documento con su estado al día de hoy, ya resuelto. La pantalla no
-- tiene que saber contar días ni la consulta repetir el cálculo en cinco
-- lugares distintos.
-- Va `drop` y no `create or replace` a propósito. Una migración posterior
-- (20261015200000_archivos_rrhh.sql) rehace esta vista con una columna más;
-- si esta se volviera a correr después de aquella, `create or replace` tendría
-- que quitar esa columna y Postgres lo rechaza con «cannot drop columns from
-- view», dejando la pasada entera a medias. Con `drop` las dos se pueden
-- correr las veces que sea y en cualquier orden.
drop view if exists v_documentos;
create view v_documentos with (security_invoker = true) as
select
  d.*,
  t.nombre   as trabajador,
  t.rut      as trabajador_rut,
  t.cargo    as trabajador_cargo,
  t.activo   as trabajador_activo,
  td.nombre  as tipo_nombre,
  td.grupo   as tipo_grupo,
  td.obligatorio,
  td.base_legal,
  case
    when not d.vigente                     then 'anulado'
    when d.fecha_vencimiento is null       then 'sin_vencimiento'
    when d.fecha_vencimiento <  current_date then 'vencido'
    when d.fecha_vencimiento <= current_date + 30 then 'por_vencer'
    else 'vigente'
  end as estado,
  (d.fecha_vencimiento - current_date) as dias_para_vencer
from documentos_trabajador d
join trabajadores t    on t.id = d.trabajador_id
join tipos_documento td on td.codigo = d.tipo;

-- La ficha con su contrato vigente al lado. Es la consulta que RRHH hace todo
-- el día y, hecha a mano, son tres viajes a la base por trabajador.
create or replace view v_personal with (security_invoker = true) as
select
  t.id, t.rut, t.nombre, t.usuario, t.cargo, t.telefono, t.email, t.activo,
  t.fecha_ingreso, t.fecha_nacimiento, t.afp, t.salud_sistema, t.salud_isapre,
  t.comuna, t.anios_previos, t.feriado_saldo_inicial, t.feriado_saldo_al,
  t.instalacion_id,
  i.nombre as instalacion,
  c.id            as contrato_id,
  c.tipo          as contrato_tipo,
  c.fecha_inicio  as contrato_desde,
  c.fecha_termino as contrato_hasta,
  c.jornada_tipo,
  c.turno,
  c.sueldo_base,
  c.resolucion_vence,
  (c.id is null)  as sin_contrato
from trabajadores t
left join instalaciones i on i.id = t.instalacion_id
left join lateral (
  select * from contratos c2
  where c2.trabajador_id = t.id and c2.estado = 'vigente'
  order by c2.fecha_inicio desc limit 1
) c on true;

-- ================================================================ RLS

alter table contratos             enable row level security;
alter table documentos_trabajador enable row level security;
alter table ausencias             enable row level security;
alter table tipos_documento       enable row level security;
alter table parametros_rrhh       enable row level security;
alter table afps                  enable row level security;
alter table tramos_impuesto       enable row level security;

do $$
declare r text; tbl text;
begin
  foreach tbl in array array['contratos','documentos_trabajador','ausencias',
                             'tipos_documento','parametros_rrhh','afps','tramos_impuesto'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on %I from %I', tbl, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant all on %I to service_role', tbl);
    end if;
  end loop;
end $$;

select 'rrhh listo' as resultado,
       (select count(*) from tipos_documento) as tipos_documento,
       (select count(*) from parametros_rrhh) as parametros,
       (select count(*) from contratos)       as contratos;
