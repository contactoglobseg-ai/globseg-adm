-- Ficha de ingreso que llena el propio trabajador, por enlace.
--
-- El problema real: cuando entra gente nueva, alguien de la oficina le
-- persigue los datos por WhatsApp durante una semana y la ficha queda a medias
-- hasta después del primer turno. Ahora RRHH genera un enlace, se lo manda, y
-- la persona llena su ficha sola antes de empezar.
--
-- Dos cosas que este archivo decide y conviene leer antes de tocarlo:
--
-- 1. EL TOKEN SE GUARDA HASHEADO, no en claro. Quien consiga una copia de la
--    base —un respaldo, un export, una consulta de más— no puede usar los
--    enlaces que todavía están pendientes. El hash es HMAC-SHA256 con
--    SESION_SECRETO, que vive en el Worker y no en la base: sin esa llave, la
--    columna no sirve para nada aunque se tenga entera.
--
--    No es PBKDF2 como las contraseñas, y es a propósito. PBKDF2 existe para
--    estirar lo que una persona eligió y se puede adivinar; un token de 256
--    bits al azar no se adivina, y estirarlo solo obligaría a recorrer la
--    tabla fila por fila porque cada una tendría su sal. Con el hash con
--    llave, el enlace se busca de una.
--
-- 2. LO QUE MANDA LA PERSONA NO ENTRA A SU FICHA. Queda en `datos`, que es
--    jsonb, y RRHH lo revisa y lo acepta desde el panel. Si alguien se
--    equivoca en el RUT o en la AFP, eso sale después en una liquidación y en
--    Previred. El jsonb no es pereza de modelar: es que lo propuesto y lo
--    aceptado son dos cosas distintas, y mezclarlas en las mismas columnas
--    hace que no se pueda ver qué cambió.

create table if not exists fichas_ingreso (
  id             bigint generated always as identity primary key,

  -- Puede ser de alguien que todavía no existe en el sistema: justamente el
  -- caso que esto viene a resolver. Al aceptar la ficha se le crea la cuenta.
  trabajador_id  bigint references trabajadores(id) on delete cascade,

  token_hash     text not null unique,
  -- Cómo llamarle a quien todavía no tiene ficha, para que la oficina sepa a
  -- quién le mandó cada enlace y la persona vea que el enlace es para ella.
  nombre_referencia text not null,
  -- Si RRHH ya sabe el RUT, el enlace queda amarrado a ese RUT y no sirve
  -- para cargar a otra persona. Si no lo sabe, lo escribe el trabajador y
  -- RRHH lo revisa igual antes de aceptarlo.
  rut_esperado   text,

  estado         text not null default 'pendiente',
  vence_en       timestamptz not null,
  -- Solo para que la oficina recuerde a qué número o correo lo mandó.
  enviado_a      text,
  nota           text,
  creado_por     text not null,
  creado_en      timestamptz not null default now(),

  -- Lo que llegó, tal como llegó.
  datos          jsonb,
  recibido_en    timestamptz,
  -- La misma huella con sal de `contactos.ip_huella`: sirve para contar y no
  -- deja una IP legible en la tabla.
  recibido_huella text,

  revisado_por   text,
  revisado_en    timestamptz,
  nota_revision  text,

  constraint ficha_ingreso_estado_valido
    check (estado in ('pendiente', 'recibida', 'aceptada', 'anulada')),
  -- Una ficha recibida sin datos sería un estado que no quiere decir nada.
  constraint ficha_ingreso_recibida_con_datos
    check (estado not in ('recibida', 'aceptada') or datos is not null)
);

create index if not exists idx_ficha_ing_estado on fichas_ingreso(estado, creado_en desc);
create index if not exists idx_ficha_ing_trab   on fichas_ingreso(trabajador_id);

comment on column fichas_ingreso.token_hash is
  'HMAC-SHA256 del token con SESION_SECRETO. El token en claro existe una sola vez, en la respuesta que ve quien genera el enlace: ni se guarda ni se puede recuperar.';
comment on column fichas_ingreso.datos is
  'Lo que mandó la persona, sin aplicar. Se revisa y se acepta desde el panel; recién ahí se escribe en `trabajadores`.';

-- ---------------------------------------------------------------- intentos
--
-- El tope de la puerta sin llave, igual que el de `POST /api/contacto`.
--
-- Va en su propia tabla y no contra `fichas_ingreso` porque esas filas las
-- crea la oficina, no el visitante: no hay nada que contar ahí. Acá se anota
-- un intento por llamada, y la tabla no crece sin freno porque al llegar al
-- tope se deja de aceptar —y de anotar—. Lo viejo se borra solo.
create table if not exists intentos_publicos (
  id        bigint generated always as identity primary key,
  puerta    text not null,            -- qué ruta pública: hoy solo 'ficha'
  huella    text,                     -- SHA-256 de la IP con sal; null si no vino
  creado_en timestamptz not null default now()
);

create index if not exists idx_intentos_puerta
  on intentos_publicos(puerta, creado_en desc);
create index if not exists idx_intentos_huella
  on intentos_publicos(puerta, huella, creado_en desc)
  where huella is not null;

-- ---------------------------------------------------------------- RLS
--
-- Igual que el resto: RLS activo y sin políticas. Acá adentro hay el RUT, la
-- dirección, la previsión y la cuenta bancaria de una persona antes incluso de
-- que sea trabajador, así que entra solo el Worker con la clave de servicio.
alter table fichas_ingreso    enable row level security;
alter table intentos_publicos enable row level security;

do $$
declare r text; tbl text;
begin
  foreach tbl in array array['fichas_ingreso', 'intentos_publicos'] loop
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on %I from %I', tbl, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant all on %I to service_role', tbl);
    end if;
  end loop;
end $$;

select 'ficha de ingreso lista' as resultado,
       (select count(*) from fichas_ingreso)    as fichas,
       (select count(*) from intentos_publicos) as intentos;
