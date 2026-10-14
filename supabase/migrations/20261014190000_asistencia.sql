-- Libro de asistencia: los trabajadores y sus marcas de entrada y salida.
--
-- Es una tabla aparte de `usuarios` a propósito. `usuarios` son las cuentas de
-- la oficina, con rol y acceso a los módulos; un guardia no tiene nada de eso
-- y no debe poder entrar al panel aunque mañana alguien se equivoque en un
-- permiso. Separar las tablas hace que esa equivocación no sea posible: la
-- sesión de asistencia ni siquiera busca en `usuarios`.
--
-- La contraseña del guardia es su RUT (decisión del gerente, 14-10-2026), pero
-- igual se guarda derivada con PBKDF2, nunca en claro: el RUT es un dato
-- personal y esta tabla no tiene por qué entregarlo si alguien se la lleva.
-- El RUT en claro sí queda en la columna `rut`, porque es la ficha del
-- trabajador y la oficina lo necesita para contratos y remuneraciones.

create table if not exists trabajadores (
  id               bigint generated always as identity primary key,
  rut              text not null,          -- sin puntos ni guión, con dígito verificador
  nombres          text not null,
  apellido_paterno text not null,
  apellido_materno text,
  nombre           text not null,          -- nombre completo, como se muestra
  usuario          text not null,          -- inicial + apellido paterno + inicial materno
  clave            text not null,          -- PBKDF2 del RUT normalizado
  telefono         text,
  cargo            text not null default 'guardia',
  instalacion_id   bigint references instalaciones(id) on delete set null,
  activo           boolean not null default true,
  intentos_fallidos integer not null default 0,
  bloqueado_hasta  timestamptz,
  ultimo_ingreso   timestamptz,
  creado_por       text,
  creado_en        timestamptz not null default now()
);

create unique index if not exists idx_trab_rut     on trabajadores(rut);
create unique index if not exists idx_trab_usuario on trabajadores(usuario);
create index        if not exists idx_trab_inst    on trabajadores(instalacion_id);

-- Cada apretón de botón. No se edita ni se borra desde la pantalla del
-- guardia: el libro de asistencia vale justamente porque nadie lo retoca.
--
-- `cuando` es el instante exacto (con zona). `fecha` es el día del turno al
-- que pertenece la marca, calculado en hora de Chile. No son lo mismo y por
-- eso van las dos: un turno de noche que entra el martes a las 20:00 y sale el
-- miércoles a las 08:00 tiene las dos marcas con fecha del martes, porque es
-- un solo turno. Si se agrupara por el día del reloj, el libro mostraría dos
-- turnos a medias y ninguna jornada completa.
create table if not exists marcas (
  id             bigint generated always as identity primary key,
  trabajador_id  bigint not null references trabajadores(id) on delete restrict,
  instalacion_id bigint references instalaciones(id) on delete set null,
  tipo           text not null check (tipo in ('entrada','salida')),
  cuando         timestamptz not null default now(),
  fecha          date not null,
  lat            double precision,
  lon            double precision,
  exactitud_m    integer,
  nota           text,
  creada_en      timestamptz not null default now()
);

create index if not exists idx_marcas_trab_fecha on marcas(trabajador_id, fecha desc);
create index if not exists idx_marcas_fecha      on marcas(fecha desc);
create index if not exists idx_marcas_cuando     on marcas(cuando desc);
create index if not exists idx_marcas_inst       on marcas(instalacion_id);

comment on column trabajadores.clave is
  'PBKDF2-SHA256 del RUT normalizado. Formato: pbkdf2$sha256$iteraciones$sal$derivada.';
comment on column marcas.fecha is
  'Día del turno en hora de Chile. La salida hereda la fecha de la entrada que cierra.';

-- Mismo candado que el resto: las tablas quedan cerradas y solo entra el
-- Worker con la clave de servicio.
alter table trabajadores enable row level security;
alter table marcas       enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on trabajadores from %I', r);
      execute format('revoke all on marcas from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on trabajadores to service_role;
    grant all on marcas to service_role;
  end if;
end $$;

select 'asistencia lista' as resultado,
       (select count(*) from trabajadores) as trabajadores,
       (select count(*) from marcas) as marcas;
