-- Regenera las contraseñas con 100.000 iteraciones.
--
-- Cloudflare Workers no admite más de 100.000 iteraciones de PBKDF2, así que
-- los hashes anteriores, hechos con 210.000, no se podían verificar en
-- producción: el ingreso fallaba con "Pbkdf2 failed".
--
-- Sigue siendo la misma clave inicial y las cuatro cuentas vuelven a quedar
-- obligadas a cambiarla. A quien ya la haya cambiado, esto se la revierte:
-- a esta altura no ha entrado nadie todavía.

update usuarios set clave = 'pbkdf2$sha256$100000$ZD6ZeAMUjRSIM/Yqcvv0Zw==$CYV58FlRgH/8XPJEZChdQdD6cT2ijMaw5RtouD4GDuE=', debe_cambiar_clave = true, intentos_fallidos = 0, bloqueado_hasta = null where usuario = 'jgarridoh';
update usuarios set clave = 'pbkdf2$sha256$100000$8BBz1fPS3a3CmpMitEBT6g==$R+735kYpCxmID0Z7hbIPqiqsVUhbb2DNdVCn6clsxZo=', debe_cambiar_clave = true, intentos_fallidos = 0, bloqueado_hasta = null where usuario = 'sgarridob';
update usuarios set clave = 'pbkdf2$sha256$100000$4p1DNXPb8Ss24hw0nlQQHA==$9pPeMK+iJx0/+CU9GKAtY/nyLFOeYtFRQOqLgmIsk8A=', debe_cambiar_clave = true, intentos_fallidos = 0, bloqueado_hasta = null where usuario = 'jgarridob';
update usuarios set clave = 'pbkdf2$sha256$100000$pTgmG0qqGJEDAGOaGpbz2A==$O1vvNyO/FsVqdbJYuQvofW3+z7shTgm1mvNVnL/sbgk=',   debe_cambiar_clave = true, intentos_fallidos = 0, bloqueado_hasta = null where usuario = 'vtorres';

select usuario, nombre, rol, debe_cambiar_clave,
       split_part(clave, '$', 3) as iteraciones
from usuarios where usuario is not null order by usuario;
