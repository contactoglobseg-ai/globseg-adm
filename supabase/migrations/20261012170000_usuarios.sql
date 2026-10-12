-- Cuentas de la oficina: usuario y contraseña.
--
-- La contraseña nunca se guarda: se guarda su derivación con PBKDF2-SHA256,
-- 210.000 iteraciones y una sal distinta por persona. Aunque alguien se
-- llevara esta tabla completa, no obtiene las contraseñas.
--
-- Las cuatro nacen con la misma clave inicial y con debe_cambiar_clave en
-- true, así que el sistema obliga a cambiarla en el primer ingreso y no deja
-- hacer nada más hasta que eso ocurra.

alter table usuarios add column if not exists usuario           text;
alter table usuarios add column if not exists clave             text;
alter table usuarios add column if not exists debe_cambiar_clave boolean not null default true;
alter table usuarios add column if not exists intentos_fallidos integer not null default 0;
alter table usuarios add column if not exists bloqueado_hasta   timestamptz;
alter table usuarios add column if not exists ultimo_ingreso    timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'usuarios_usuario_unico') then
    alter table usuarios add constraint usuarios_usuario_unico unique (usuario);
  end if;
end $$;

update usuarios set usuario = 'jgarridoh', nombre = 'José Garrido Huinca',
       clave = 'pbkdf2$sha256$210000$9aTMnert244ICeUy0k0nVg==$+jXWfyIiXP+lsWGK9o52g+YcXw5YImwHXTZ8/6RbLJA=', debe_cambiar_clave = true
  where email = 'contacto.globseg@gmail.com';

update usuarios set usuario = 'sgarridob',
       clave = 'pbkdf2$sha256$210000$3GlwQVrq98xbjqJ7GL01Fg==$ZzPhzS2gA2XjqD2j/wx3rnZbNiEEpWypmMHBraJQoRw=', debe_cambiar_clave = true
  where email = 'sgarrido@proverde.cl';

update usuarios set usuario = 'jgarridob', nombre = 'Joaquín Garrido',
       clave = 'pbkdf2$sha256$210000$e6fIanZ9CI1N6Br4O9oBLw==$Tj5ZvrNXP67GN56Cia9v4SzFA0otV+c8rcblysSQwVM=', debe_cambiar_clave = true
  where email = 'joaquinglobseg@gmail.com';

update usuarios set usuario = 'vtorres', nombre = 'Valeria Torres',
       clave = 'pbkdf2$sha256$210000$29iF8rb2GUJeuiVSNjiYpQ==$gp0tiYcjemaiQ1kGOCpovRHQsAaRXz9h9ZBoMCPX7GI=', debe_cambiar_clave = true
  where email = 'rrhhglobseg@gmail.com';

comment on column usuarios.clave is
  'PBKDF2-SHA256. Formato: pbkdf2$sha256$iteraciones$sal$derivada. Nunca la contraseña.';
comment on column usuarios.debe_cambiar_clave is
  'Mientras sea true, el sistema solo permite cambiar la contraseña.';
