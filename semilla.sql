-- Datos iniciales. Todo sale de archivos de la propia empresa:
--   tarifas       <- "servicios globseg.xlsx" (export del sistema contable)
--   instalaciones <- "servicios extra ordinarios .docx"
-- Nada inventado. Lo que falta por confirmar queda rotulado como tal.

-- ---------- Tarifario ----------
INSERT INTO tarifas (codigo, nombre, unidad, precio, grupo) VALUES
  ('1',  '2 guardias por hora hábil',                      'hora', 26000,   'Horas'),
  ('2',  '2 guardias por hora (sábado)',                   'hora', 30333,   'Horas'),
  ('3',  '2 guardias por hora (domingo y feriado)',        'hora', 34667,   'Horas'),
  ('4',  '2 guardias por hora (feriado irrenunciable)',    'hora', 43333,   'Horas'),
  ('5',  '2 guardias por día hábil',                       'día',  200000,  'Jornadas'),
  ('6',  '2 guardias por día (sábado)',                    'día',  233333,  'Jornadas'),
  ('7',  '2 guardias por día (domingo y feriados)',        'día',  266667,  'Jornadas'),
  ('8',  '2 guardias por día (feriado irrenunciable)',     'día',  333333,  'Jornadas'),
  ('13', 'Supervisor diario',                              'día',  70000,   'Jornadas'),
  ('9',  'Arriendo de vehículo mensual',                   'mes',  1000000, 'Vehículo'),
  ('10', 'Arriendo de vehículo semanal',                   'semana', 425000,'Vehículo'),
  ('11', 'Arriendo de vehículo diario',                    'día',  100000,  'Vehículo'),
  ('12', 'Combustible',                                    'global', 50000, 'Vehículo');

-- ---------- Cliente e instalaciones ----------
-- El nombre del cliente no aparece en los documentos que revisé: renómbralo
-- desde la pantalla de Clientes.
INSERT INTO clientes (id, nombre, contacto) VALUES
  (1, 'Cliente PMGD — falta confirmar el nombre', NULL);

INSERT INTO instalaciones (cliente_id, nombre, comuna, region) VALUES
  (1, 'PMGD San Ramón', 'Paine',       'Metropolitana'),
  (1, 'PMGD Rengo',     'Rengo',       'O''Higgins'),
  (1, 'PMGD Puelche',   'Los Ángeles', 'Biobío'),
  (1, 'PMGD Loncura',   'Puchuncaví',  'Valparaíso'),
  (1, 'PMGD El Cauce',  'Calama',      'Antofagasta');

-- ---------- Usuarios ----------
-- El acceso lo controla Cloudflare Access; acá se define el rol.
-- Falta el correo de la prevencionista: cuando llegue se agrega con
--   INSERT INTO usuarios (email, nombre, rol) VALUES ('...', '...', 'prevencion');
INSERT INTO usuarios (email, nombre, rol) VALUES
  ('contacto.globseg@gmail.com', 'José Garrido',    'gerencia'),
  ('sgarrido@proverde.cl',       'José Garrido',    'gerencia'),
  ('joaquinglobseg@gmail.com',   'Joaquín Garrido', 'operaciones'),
  ('rrhhglobseg@gmail.com',      'Valeria Torres',  'rrhh');
