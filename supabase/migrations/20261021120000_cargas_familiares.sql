-- Cargas familiares: lo único de la ficha legal que faltaba entero.
--
-- La asignación familiar la paga el empleador y se la reintegran: es un haber
-- NO imponible y su monto por carga depende del tramo de renta del trabajador
-- (Ley 18.020). Sin esto, la liquidación estimada le queda corta a quien tiene
-- cargas, que son casi todos los guardias con hijos.
--
-- Se puede correr las veces que sea.

create table if not exists cargas_familiares (
  id               bigint generated always as identity primary key,
  trabajador_id    bigint not null references trabajadores(id) on delete cascade,

  nombre           text not null,
  -- Sin dígito verificador obligatorio ni NOT NULL: un recién nacido se
  -- inscribe como carga antes de que llegue su cédula, y negarse a cargarlo
  -- por eso sería pedirle a RRHH que lo anote en otro lado.
  rut              text,
  parentesco       text not null default 'hijo',
  fecha_nacimiento date,

  -- `desde` es desde cuándo corresponde pagarla y `hasta` hasta cuándo. Un
  -- hijo deja de ser carga a los 18, o a los 24 si sigue estudiando: ese día
  -- se escribe acá y la liquidación deja de contarlo sola, sin que nadie tenga
  -- que acordarse de borrar la fila. Borrarla, además, perdería que existió.
  desde            date not null,
  hasta            date,

  -- Reconocida por el IPS o la caja. Mientras no lo esté, no se paga: se
  -- muestra en la ficha pero no entra en el cálculo.
  acreditada       boolean not null default false,

  -- PENDIENTE VALIDAR: una carga inválida da derecho al doble (art. 2 Ley
  -- 18.020). Está aplicado así en el cálculo y marcado en pantalla; conviene
  -- que lo confirme quien lleva las remuneraciones antes de usarlo para pagar.
  invalidez        boolean not null default false,

  notas            text,
  creado_por       text,
  creado_en        timestamptz not null default now(),

  constraint carga_parentesco_valido
    check (parentesco in ('hijo','conyuge','madre','nieto','hermano','otro')),
  constraint carga_fechas_en_orden
    check (hasta is null or hasta >= desde)
);

create index if not exists cargas_por_trabajador on cargas_familiares (trabajador_id);

alter table cargas_familiares enable row level security;

comment on table cargas_familiares is
  'Causantes de asignación familiar. Solo las acreditadas y vigentes entran en la liquidación.';

-- --------------------------------------------------------------- parámetros
--
-- Los montos por carga y los topes de renta de cada tramo los fija la ley cada
-- año. Van en cero y sin confirmar a propósito: el sistema no tiene cómo
-- verificarlos, y un número inventado que se ve como un número confirmado es
-- peor que no tenerlo. RRHH los escribe en Sueldos → Parámetros, que ya edita
-- cualquier parámetro, y hasta entonces la liquidación dice que no los tiene
-- en vez de callarse.
insert into parametros_rrhh (codigo, vigente_desde, valor, unidad, glosa, base_legal, por_confirmar)
values
  ('asig_familiar_a',      '2026-01-01', 0, 'pesos',
   'Asignación familiar por carga, tramo A',
   'Ley 18.020. El monto y el tope los fija la ley cada año.', true),
  ('asig_familiar_b',      '2026-01-01', 0, 'pesos',
   'Asignación familiar por carga, tramo B',
   'Ley 18.020. El monto y el tope los fija la ley cada año.', true),
  ('asig_familiar_c',      '2026-01-01', 0, 'pesos',
   'Asignación familiar por carga, tramo C',
   'Ley 18.020. El monto y el tope los fija la ley cada año.', true),
  ('asig_familiar_tope_a', '2026-01-01', 0, 'pesos',
   'Renta mensual hasta la que corresponde el tramo A',
   'Ley 18.020. Sobre este monto se pasa al tramo B.', true),
  ('asig_familiar_tope_b', '2026-01-01', 0, 'pesos',
   'Renta mensual hasta la que corresponde el tramo B',
   'Ley 18.020. Sobre este monto se pasa al tramo C.', true),
  ('asig_familiar_tope_c', '2026-01-01', 0, 'pesos',
   'Renta mensual hasta la que corresponde el tramo C',
   'Ley 18.020. Sobre este monto es tramo D: sin derecho a asignación.', true)
on conflict (codigo, vigente_desde) do nothing;
