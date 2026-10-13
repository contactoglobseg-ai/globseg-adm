-- Quién puede borrar.
--
-- Decidido por el gerente el 13-10-2026: eliminar registros lo hace una sola
-- persona. Si alguien se equivoca, se lo pide a ella. Borrar es la única
-- operación que no se puede deshacer mirando la bitácora, así que no va con el
-- rol: va por persona.
--
-- Es una columna y no un nombre escrito en el código para que mañana se pueda
-- dar o quitar el permiso con un update, sin tocar ni desplegar nada.

alter table usuarios add column if not exists puede_borrar boolean not null default false;

update usuarios set puede_borrar = true where usuario = 'sgarridob';

-- El resto queda en false por el default de la columna. No se les pone false
-- explícitamente: si mañana se le da el permiso a alguien más y este archivo
-- se vuelve a correr, se lo quitaría sin que nadie lo pida.

select usuario, nombre, rol, puede_borrar from usuarios order by usuario;
