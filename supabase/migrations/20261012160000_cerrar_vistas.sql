-- Cierra las vistas, que quedaban abiertas al rol público.
--
-- El problema: una vista creada sin más se ejecuta con los permisos de su
-- dueño, no de quien consulta, así que pasa por encima del RLS de las tablas
-- que cruza. Y Supabase concede lectura a los roles anon y authenticated
-- sobre lo nuevo del esquema public. Resultado: con la clave pública se podía
-- leer toda la facturación a través de v_ciclos, aunque las tablas estuvieran
-- cerradas.
--
-- Dos candados, a propósito:
--   1. security_invoker: la vista pasa a ejecutarse con los permisos de quien
--      consulta, de modo que el RLS de las tablas sí se aplica.
--   2. revoke: el rol público pierde todo permiso sobre tablas y vistas, así
--      que aunque mañana alguien agregue una política permisiva por error,
--      sigue sin poder entrar.
-- El Worker no se ve afectado: usa la clave de servicio, que salta el RLS.

alter view v_ciclos        set (security_invoker = true);
alter view v_extras        set (security_invoker = true);
alter view v_instalaciones set (security_invoker = true);

do $$
declare
  publicos text[] := array['anon', 'authenticated'];
  r text;
begin
  foreach r in array publicos loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      -- Y que tampoco lo reciban las tablas que se creen más adelante.
      execute format(
        'alter default privileges in schema public revoke all on tables from %I', r);
      execute format(
        'alter default privileges in schema public revoke all on sequences from %I', r);
    end if;
  end loop;
end $$;
