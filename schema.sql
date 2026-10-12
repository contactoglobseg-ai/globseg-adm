-- Administración Seguridad Garridos (GLOBSEG SPA)
-- Módulo 1: control de servicios prestados y facturación.
-- Base de datos: Cloudflare D1 (SQLite).

PRAGMA foreign_keys = ON;

-- Quién puede entrar y qué ve. El correo lo entrega Cloudflare Access;
-- acá solo decidimos el rol.
CREATE TABLE IF NOT EXISTS usuarios (
  email   TEXT PRIMARY KEY,
  nombre  TEXT NOT NULL,
  rol     TEXT NOT NULL CHECK (rol IN ('gerencia','operaciones','rrhh','prevencion')),
  activo  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clientes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre    TEXT NOT NULL,
  rut       TEXT,
  contacto  TEXT,
  email     TEXT,
  activo    INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Las faenas: cada parque fotovoltaico, bodega u obra que se resguarda.
CREATE TABLE IF NOT EXISTS instalaciones (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  nombre     TEXT NOT NULL,
  comuna     TEXT,
  region     TEXT,
  activa     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_inst_cliente ON instalaciones(cliente_id);

-- El servicio continuo que se factura cada N días.
CREATE TABLE IF NOT EXISTS servicios (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  instalacion_id  INTEGER NOT NULL REFERENCES instalaciones(id) ON DELETE RESTRICT,
  nombre          TEXT NOT NULL,
  fecha_inicio    TEXT NOT NULL,                    -- YYYY-MM-DD
  dias_ciclo      INTEGER NOT NULL DEFAULT 30,
  monto_neto      INTEGER,                          -- valor del periodo, si es fijo
  activo          INTEGER NOT NULL DEFAULT 1,
  creado_por      TEXT,
  creado_en       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_serv_inst ON servicios(instalacion_id);

-- Cada periodo de 30 días que hay que cobrar. Es el corazón del módulo:
--   en_curso -> solicitar_oc -> pendiente_facturacion -> cerrado
CREATE TABLE IF NOT EXISTS ciclos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  servicio_id    INTEGER NOT NULL REFERENCES servicios(id) ON DELETE CASCADE,
  numero         INTEGER NOT NULL,
  desde          TEXT NOT NULL,
  hasta          TEXT NOT NULL,
  estado         TEXT NOT NULL DEFAULT 'en_curso'
                 CHECK (estado IN ('en_curso','solicitar_oc','pendiente_facturacion','cerrado')),
  oc_numero      TEXT,
  oc_fecha       TEXT,
  factura_folio  TEXT,
  factura_fecha  TEXT,
  monto_neto     INTEGER,
  notas          TEXT,
  actualizado_en TEXT,
  UNIQUE (servicio_id, numero)
);
CREATE INDEX IF NOT EXISTS idx_ciclos_estado ON ciclos(estado);
CREATE INDEX IF NOT EXISTS idx_ciclos_hasta  ON ciclos(hasta);

-- Servicios extraordinarios: horas, jornadas y coberturas programadas.
-- Es lo que se estaba perdiendo sin facturar.
CREATE TABLE IF NOT EXISTS extras (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  instalacion_id  INTEGER NOT NULL REFERENCES instalaciones(id) ON DELETE RESTRICT,
  ciclo_id        INTEGER REFERENCES ciclos(id) ON DELETE SET NULL,
  fecha           TEXT NOT NULL,
  tarifa_id       INTEGER REFERENCES tarifas(id),
  item            TEXT NOT NULL,
  cantidad        REAL NOT NULL DEFAULT 1,
  precio_unitario INTEGER NOT NULL,
  monto_neto      INTEGER NOT NULL,
  detalle         TEXT,
  creado_por      TEXT,
  creado_en       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_extras_ciclo ON extras(ciclo_id);
CREATE INDEX IF NOT EXISTS idx_extras_fecha ON extras(fecha);

-- Tarifario, tomado del sistema contable.
CREATE TABLE IF NOT EXISTS tarifas (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo  TEXT,
  nombre  TEXT NOT NULL,
  unidad  TEXT,
  precio  INTEGER NOT NULL,
  grupo   TEXT,
  activo  INTEGER NOT NULL DEFAULT 1
);

-- Quién hizo qué. Existe precisamente porque hubo dudas sobre el orden
-- de los servicios extra: acá queda el rastro.
CREATE TABLE IF NOT EXISTS bitacora (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cuando     TEXT NOT NULL DEFAULT (datetime('now')),
  quien      TEXT NOT NULL,
  entidad    TEXT NOT NULL,
  entidad_id INTEGER,
  accion     TEXT NOT NULL,
  detalle    TEXT
);
CREATE INDEX IF NOT EXISTS idx_bitacora_cuando ON bitacora(cuando);
