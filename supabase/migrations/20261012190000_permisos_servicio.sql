-- Asegura que el rol de servicio —el único que usa el Worker— tenga permiso
-- sobre todo lo del esquema public, ahora y sobre lo que se cree después.
--
-- Supabase normalmente ya se lo concede, pero dejarlo explícito evita quedar
-- a merced de los privilegios por defecto, que es un detalle fácil de perder
-- de vista cuando se agregan tablas más adelante.
--
-- Esto NO afecta a los roles públicos: siguen sin acceso, como se dejó en la
-- migración que cerró las vistas.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema public to service_role;
    grant all on all tables    in schema public to service_role;
    grant all on all sequences in schema public to service_role;
    grant all on all functions in schema public to service_role;
    alter default privileges in schema public grant all on tables    to service_role;
    alter default privileges in schema public grant all on sequences to service_role;
  end if;
end $$;

-- Deja a la vista qué rol tiene permiso sobre usuarios, para no adivinar.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'usuarios'
order by grantee, privilege_type;
