

-- Tareas entre el equipo de la oficina (22-11-2026).
--
-- Cualquiera con cuenta de oficina le pide una tarea a otro (o a sí mismo), y
-- la tarea aparece arriba en el Inicio de quien la recibe, como un ticket.
--
-- Quién pidió y a quién se le pidió se guardan por `usuarios.usuario`, que es
-- único desde la migración de usuarios. No se borran: una tarea se cancela, se
-- rechaza o se termina, y las tres cosas quedan a la vista de los dos.
--
-- Se puede correr más de una vez.

create table if not exists tareas (
  id            bigserial primary key,
  titulo        text        not null check (length(btrim(titulo)) between 1 and 160),
  detalle       text        check (detalle is null or length(detalle) <= 4000),
  de_usuario    text        not null references usuarios(usuario) on update cascade,
  para_usuario  text        not null references usuarios(usuario) on update cascade,
  prioridad     text        not null default 'normal'
                            check (prioridad in ('normal', 'alta', 'urgente')),
  vence         date,
  estado        text        not null default 'pendiente'
                            check (estado in ('pendiente', 'en_curso', 'hecha',
                                              'rechazada', 'cancelada')),
  -- Lo que dice quien la cierra: el «listo, quedó en tal carpeta» o por qué
  -- se rechaza. Rechazar sin decir por qué no se acepta (lo revisa el Worker).
  respuesta     text        check (respuesta is null or length(respuesta) <= 2000),
  creado_en     timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  cerrado_en    timestamptz
);

create index if not exists tareas_para_abiertas
  on tareas (para_usuario, estado);
create index if not exists tareas_de_usuario
  on tareas (de_usuario, creado_en desc);

-- Como el resto de las tablas: RLS activo y sin políticas. Solo entra el
-- Worker con la clave de servicio.
alter table tareas enable row level security;
