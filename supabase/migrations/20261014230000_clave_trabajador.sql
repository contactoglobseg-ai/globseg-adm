-- El guardia cambia su clave en el primer ingreso.
--
-- Nace así: la clave inicial es el RUT, que es lo único que todos se saben de
-- memoria y por eso sirve para entregar la cuenta. Pero el RUT de una persona
-- lo tiene cualquiera que haya visto un contrato, una lista de turnos o una
-- credencial, así que como clave permanente no es una clave: es un dato
-- público. Sirve para la primera vez y para nada más.
--
-- El riesgo concreto no es que alguien de afuera entre: es que un compañero
-- marque la entrada por otro que todavía no llega. El libro de asistencia vale
-- por eso, y una clave que el de al lado puede adivinar lo deja sin valor.
--
-- Por defecto `true`, igual que las cuentas de la oficina: quien ya esté
-- cargado va a tener que cambiarla la próxima vez que entre, que es
-- exactamente lo que se quiere.

alter table trabajadores
  add column if not exists debe_cambiar_clave boolean not null default true;

comment on column trabajadores.debe_cambiar_clave is
  'Mientras sea true, el guardia solo puede cambiar su clave: no puede marcar.';

select 'clave de trabajador lista' as resultado,
       count(*) filter (where debe_cambiar_clave) as deben_cambiarla,
       count(*) as total
  from trabajadores;
