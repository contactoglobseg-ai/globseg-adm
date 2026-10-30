

-- Usuarios y permisos: se administran desde la pantalla y, si hace falta,
-- desde el SQL Editor de Supabase.
--
-- Por qué existe este archivo, en dos problemas concretos:
--
-- 1. Quien olvida su contraseña queda afuera y nadie puede devolvérsela.
--    Para los guardias la oficina ya tenía los botones «Desbloquear» y «Clave
--    al RUT» en la pestaña Trabajadores. Para las CUATRO CUENTAS DE LA OFICINA
--    no había ninguna salida: el panel solo deja cambiar la propia sabiendo la
--    actual, así que una cuenta olvidada quedaba sin camino que no pasara por
--    pegar SQL a mano. Esta migración deja los dos caminos abiertos: la
--    pantalla Usuarios, y las funciones de más abajo para cuando el problema
--    sea justamente que nadie de gerencia puede entrar.
--
-- 2. Los permisos vivían escritos en `src/index.js` (PERMISOS y
--    PERMISOS_PERSONA). Cambiarle el acceso a alguien era editar código y
--    desplegar. Ahora viven en la base, en `roles_permisos` y en la columna
--    `usuarios.permisos_extra`, y el código los usa como respaldo: si esta
--    migración no se aplicó, el sistema sigue andando con los de siempre.
--
-- (Las dos líneas en blanco de arriba son de resguardo: si el editor se come
-- el primer carácter al pegar, se come un salto de línea y no SQL.)

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- permisos
--
-- Los seis módulos que existen. La lista va en una restricción y no suelta
-- para que un módulo mal escrito desde el SQL Editor se rechace en vez de
-- dejar a alguien sin acceso en silencio, que es la falla cara: el permiso
-- parece dado y no abre nada. Agregar un módulo nuevo es tocar las dos
-- restricciones de abajo, y es a propósito: un módulo que nadie declaró no
-- debería poder aparecer de un `update`.

-- Sin clave foránea contra `usuarios.rol`: esa columna no es única, así que no
-- puede ser el destino de una. Lo que amarra los dos lados es la restricción
-- de valores de abajo, que es la misma que ya tiene `usuarios.rol`.
create table if not exists roles_permisos (
  rol             text primary key,
  permisos        text[] not null default '{}',
  descripcion     text,
  actualizado_en  timestamptz not null default now(),
  actualizado_por text
);

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'roles_permisos_modulos_validos') then
    alter table roles_permisos add constraint roles_permisos_modulos_validos
      check (permisos <@ array['facturacion','cotizaciones','personal',
                               'documentos','rrhh','usuarios']::text[]);
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'roles_permisos_rol_valido') then
    alter table roles_permisos add constraint roles_permisos_rol_valido
      check (rol in ('gerencia','operaciones','rrhh','prevencion'));
  end if;
end $$;

-- Los mismos que estaban en el código, para que aplicar esta migración no le
-- cambie el acceso a nadie. `usuarios` es el único módulo nuevo y lo tiene
-- solo gerencia: es la pantalla que reparte los demás permisos.
insert into roles_permisos (rol, permisos, descripcion) values
  ('gerencia',    array['facturacion','cotizaciones','personal','documentos','rrhh','usuarios'],
   'Ve y hace todo, y es la única que administra cuentas y permisos.'),
  ('operaciones', array['facturacion','personal','documentos','rrhh'],
   'Servicios, instalaciones, el libro de asistencia y las cuentas de los guardias.'),
  ('rrhh',        array['rrhh'],
   'Personas: fichas, contratos, documentos, sueldos y transferencias.'),
  ('prevencion',  array['documentos','rrhh'],
   'Documentos que se firman (EPP, charlas) y la ficha de cada persona.')
on conflict (rol) do nothing;

-- Módulos dados a una persona además de los de su rol. Reemplaza a
-- PERMISOS_PERSONA, que estaba escrito en el código.
alter table usuarios add column if not exists permisos_extra text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'usuarios_permisos_extra_validos') then
    alter table usuarios add constraint usuarios_permisos_extra_validos
      check (permisos_extra <@ array['facturacion','cotizaciones','personal',
                                     'documentos','rrhh','usuarios']::text[]);
  end if;
end $$;

-- 14-10-2026: Joaquín cotiza, aunque su rol sea operaciones.
update usuarios set permisos_extra = array['cotizaciones']
 where usuario = 'jgarridob' and permisos_extra = '{}';

alter table usuarios add column if not exists creado_en  timestamptz not null default now();
alter table usuarios add column if not exists creado_por text;

-- El teléfono al que llama el guardia que quedó bloqueado a las tres de la
-- mañana. Va en `datos_empresa` y no escrito en el código porque ahí ya se
-- edita desde la pantalla (Documentos → Datos de la empresa) y porque es el
-- mismo dato que el resto de la empresa: no merece una tabla propia. Si falta,
-- el aviso del bloqueo sale sin teléfono en vez de fallar.
insert into datos_empresa (codigo, valor, glosa, por_confirmar) values
  ('telefono_oficina', '+56 9 8988 7614',
   'Teléfono de la oficina. Es el que se le muestra al guardia cuando su cuenta queda bloqueada, para que sepa a quién llamar. Hay que confirmar si ese es el número que se quiere dar para eso o hay otro interno.', true)
on conflict (codigo) do nothing;

comment on table  roles_permisos is
  'Qué módulos abre cada rol. Se edita en el panel (Sistema → Usuarios) o acá.';
comment on column roles_permisos.permisos is
  'facturacion, cotizaciones, personal, documentos, rrhh, usuarios. Un nombre fuera de esa lista se rechaza.';
comment on column usuarios.permisos_extra is
  'Módulos de esta persona además de los de su rol. Vacío es lo normal.';

-- ---------------------------------------------------------------- la lista
--
-- Lo que Authentication → Users nunca va a mostrar, porque el ingreso de este
-- sistema es propio y no pasa por Supabase Auth: esa lista está vacía a
-- propósito y va a seguir estándolo. Esta vista es su reemplazo, y se abre en
-- Table Editor como cualquier tabla.
--
-- Junta las dos clases de cuenta porque la pregunta que se le hace de verdad
-- a esta lista —«¿por qué fulano no puede entrar?»— no sabe de qué tabla sale
-- fulano. Es de solo lectura: para cambiar algo están las funciones de abajo.

drop view if exists v_cuentas;
create view v_cuentas as
select
  'oficina'::text                                   as clase,
  u.usuario,
  u.nombre,
  u.rol                                             as rol_o_cargo,
  u.email                                           as correo,
  case when not u.activo                            then 'DADA DE BAJA'
       when u.bloqueado_hasta > now()               then 'BLOQUEADA'
       when u.debe_cambiar_clave                    then 'CLAVE INICIAL SIN CAMBIAR'
       when u.ultimo_ingreso is null                then 'nunca ha entrado'
       else                                              'al día'
  end                                               as estado,
  u.bloqueado_hasta,
  u.intentos_fallidos,
  u.ultimo_ingreso,
  u.activo                                          as activa,
  -- Lo que de verdad abre esta cuenta: lo del rol más lo suyo.
  (select array_agg(distinct p order by p)
     from unnest(coalesce(r.permisos,'{}') || u.permisos_extra) as p)
                                                    as permisos,
  u.permisos_extra,
  u.puede_borrar
from usuarios u
left join roles_permisos r on r.rol = u.rol
union all
select
  'guardia'::text,
  t.usuario,
  t.nombre,
  t.cargo,
  null,
  case when not t.activo                            then 'DADO DE BAJA'
       when t.bloqueado_hasta > now()               then 'BLOQUEADA'
       when t.debe_cambiar_clave                    then 'SIGUE CON EL RUT'
       when t.ultimo_ingreso is null                then 'nunca ha entrado'
       else                                              'al día'
  end,
  t.bloqueado_hasta,
  t.intentos_fallidos,
  t.ultimo_ingreso,
  t.activo,
  null,
  null,
  null
from trabajadores t;

comment on view v_cuentas is
  'Todas las cuentas del sistema, de la oficina y de los guardias. Solo lectura: para cambiar algo, las funciones desbloquear_cuenta, restablecer_clave y restablecer_clave_al_rut.';

-- ---------------------------------------------------------------- la salida de emergencia
--
-- Lo normal es hacer esto desde el panel, en Sistema → Usuarios. Estas
-- funciones existen para el día en que eso no se pueda: que las cuentas de
-- gerencia estén las dos bloqueadas, o que nadie recuerde su contraseña.
-- Entonces se entra al SQL Editor de Supabase y se corre una línea.
--
-- La contraseña no se puede recuperar, solo reemplazar: la columna `clave`
-- guarda una derivación PBKDF2-SHA256 y no el texto. Lo que hace
-- `restablecer_clave` es escribir esa derivación exactamente en el formato
-- que el Worker verifica —comprobado contra él, byte a byte—, y dejar la
-- cuenta obligada a elegir otra en el primer ingreso.

-- Se sueltan antes de rehacerlas: `create or replace` no puede cambiarle el
-- nombre a un parámetro, así que sin esto la migración entra la primera vez y
-- falla la segunda si alguna vez se renombra uno. Acá las migraciones se
-- corren más de una vez.
drop function if exists pbkdf2_sha256(text, bytea, int);
drop function if exists hashear_clave(text);
drop function if exists restablecer_clave(text, text);
drop function if exists restablecer_clave_al_rut(text);
drop function if exists desbloquear_cuenta(text);

create or replace function pbkdf2_sha256(p_clave text, p_sal bytea, p_iteraciones int)
returns bytea language plpgsql immutable as $$
declare
  u      bytea;
  acc    bit(256);
  pw     bytea := convert_to(p_clave, 'UTF8');
  salida bytea := decode(repeat('00', 32), 'hex');
  i      int;
begin
  -- La derivada son 256 bits, o sea un solo bloque de SHA-256: basta T1, que
  -- es U1 xor U2 xor … xor Uc. El acumulador se queda en bits todo el rato y
  -- se vuelve a bytes una sola vez al final; convertirlo en cada vuelta es lo
  -- que haría lenta a esta función (así corre en una décima de segundo).
  u   := hmac(p_sal || '\x00000001'::bytea, pw, 'sha256');
  acc := ('x' || encode(u, 'hex'))::bit(256);
  for i in 2..p_iteraciones loop
    u   := hmac(u, pw, 'sha256');
    acc := acc # ('x' || encode(u, 'hex'))::bit(256);
  end loop;
  for i in 0..31 loop
    salida := set_byte(salida, i, substring(acc from i*8+1 for 8)::bit(8)::int);
  end loop;
  return salida;
end $$;

comment on function pbkdf2_sha256(text, bytea, int) is
  'Deriva una contraseña igual que el Worker. No se llama sola: la usa restablecer_clave.';

create or replace function hashear_clave(p_clave text)
returns text language plpgsql as $$
declare
  sal bytea := gen_random_bytes(16);
  -- 100.000 y no más: es el techo de PBKDF2 en Cloudflare Workers, y un hash
  -- escrito acá con más iteraciones el Worker no lo podría verificar nunca.
  it  int := 100000;
begin
  return 'pbkdf2$sha256$' || it || '$' || encode(sal, 'base64') || '$' ||
         encode(pbkdf2_sha256(p_clave, sal, it), 'base64');
end $$;

/**
 * Le pone una contraseña nueva a una cuenta, de la oficina o de un guardia.
 *
 *   select restablecer_clave('jgarridoh', 'Temporal2026');
 *
 * Queda obligada a cambiarla en el primer ingreso, así que la que se escriba
 * acá sirve para entregar la cuenta una vez y para nada más. Eso importa
 * porque lo que se teclee queda en el historial del SQL Editor.
 */
create or replace function restablecer_clave(p_usuario text, p_clave text)
returns text language plpgsql as $$
declare
  u    text := lower(trim(p_usuario));
  hash text;
  n    int;
begin
  if p_clave is null or length(p_clave) < 8 then
    return 'No se hizo nada: la contraseña nueva tiene que tener al menos 8 caracteres.';
  end if;
  hash := hashear_clave(p_clave);

  update usuarios set clave = hash, debe_cambiar_clave = true,
         intentos_fallidos = 0, bloqueado_hasta = null
   where usuario = u;
  get diagnostics n = row_count;
  if n > 0 then
    return 'Listo. La cuenta de oficina ' || u ||
           ' entra con esa contraseña y tiene que cambiarla al entrar.';
  end if;

  update trabajadores set clave = hash, debe_cambiar_clave = true,
         intentos_fallidos = 0, bloqueado_hasta = null
   where usuario = u;
  get diagnostics n = row_count;
  if n > 0 then
    return 'Listo. El guardia ' || u ||
           ' entra con esa contraseña y tiene que cambiarla al entrar.';
  end if;

  return 'No existe ninguna cuenta con el usuario ' || u ||
         '. Mírelas con: select * from v_cuentas;';
end $$;

/**
 * Devuelve la clave de un guardia a su RUT, que es como nace su cuenta.
 *
 *   select restablecer_clave_al_rut('pgonzalezm');
 *
 * Es lo mismo que hace el botón «Clave al RUT» del panel. No sirve para las
 * cuentas de la oficina: esas no tienen el RUT de clave.
 */
create or replace function restablecer_clave_al_rut(p_usuario text)
returns text language plpgsql as $$
declare
  u   text := lower(trim(p_usuario));
  r   text;
begin
  select rut into r from trabajadores where usuario = u;
  if r is null then
    return 'No hay ningún guardia con el usuario ' || u ||
           '. Las cuentas de la oficina se arreglan con restablecer_clave(usuario, clave).';
  end if;
  update trabajadores set clave = hashear_clave(r), debe_cambiar_clave = true,
         intentos_fallidos = 0, bloqueado_hasta = null
   where usuario = u;
  return 'Listo. ' || u || ' entra con su RUT (' || r ||
         ') y tiene que elegir otra clave al entrar.';
end $$;

/**
 * Saca el bloqueo por intentos fallidos, sin tocar la contraseña.
 *
 *   select desbloquear_cuenta('jgarridoh');
 *
 * Es lo que hace falta cuando la persona SÍ se sabe su clave y lo único que
 * pasó es que la tecleó mal cinco veces.
 */
create or replace function desbloquear_cuenta(p_usuario text)
returns text language plpgsql as $$
declare
  u text := lower(trim(p_usuario));
  n int;
begin
  update usuarios set intentos_fallidos = 0, bloqueado_hasta = null where usuario = u;
  get diagnostics n = row_count;
  if n > 0 then return 'Listo. ' || u || ' puede volver a intentar ahora.'; end if;

  update trabajadores set intentos_fallidos = 0, bloqueado_hasta = null where usuario = u;
  get diagnostics n = row_count;
  if n > 0 then return 'Listo. ' || u || ' puede volver a intentar ahora.'; end if;

  return 'No existe ninguna cuenta con el usuario ' || u || '.';
end $$;

-- Las cuatro funciones las corre quien tenga el SQL Editor, que ya es dueño de
-- la base. Lo que no tiene por qué poder llamarlas es nadie que llegue por la
-- API pública del proyecto.
-- `anon` y `authenticated` son roles de Supabase: en una réplica local no
-- existen, y un `revoke` contra un rol que no existe aborta la migración
-- entera. Se les quita el permiso solo a los que estén.
do $$
declare
  f text;
  r text;
begin
  foreach f in array array['hashear_clave(text)', 'restablecer_clave(text, text)',
                           'restablecer_clave_al_rut(text)', 'desbloquear_cuenta(text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
  end loop;
end $$;

alter table roles_permisos enable row level security;

select 'usuarios y permisos listos' as resultado,
       (select count(*) from roles_permisos)                        as roles,
       (select count(*) from v_cuentas where clase = 'oficina')      as cuentas_oficina,
       (select count(*) from v_cuentas where clase = 'guardia')      as cuentas_guardia,
       (select count(*) from v_cuentas where estado = 'BLOQUEADA')   as bloqueadas_ahora;
