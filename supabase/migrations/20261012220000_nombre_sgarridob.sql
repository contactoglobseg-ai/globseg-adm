-- Corrige el nombre de sgarridob.
--
-- Había heredado "José Garrido" del correo sgarrido@proverde.cl cuando se
-- sembró la tabla, antes de saber de quién era esa cuenta.

update usuarios
   set nombre = 'Seba Garrido'
 where usuario = 'sgarridob';

select usuario, nombre, rol from usuarios where usuario is not null order by usuario;
