# Usuarios y contraseñas desde Supabase, sin Claude

Lo normal es hacer todo esto desde el panel, en **Sistema → Usuarios**
(`adm.seggarridos.com`). Este documento es para el día en que eso no se pueda:
que las cuentas de gerencia estén las dos bloqueadas, que nadie recuerde su
contraseña, o que el Worker esté caído. Entonces se entra a Supabase y se corre
una línea.

No hace falta instalar nada ni tener una consola: todo es copiar y pegar en el
**SQL Editor** del navegador.

---

## Por qué Authentication → Users está vacío, y va a seguir estándolo

Esa pantalla lista las cuentas de **Supabase Auth**, que es el sistema de
ingreso que trae Supabase. Este sistema **no lo usa**: el ingreso es propio,
contra la tabla `usuarios` (la oficina) y la tabla `trabajadores` (los
guardias).

No es un olvido. Se decidió así el 12-10-2026 y hay tres razones que siguen en
pie:

1. **Los guardias entran con su RUT**, no con un correo. En Supabase Auth una
   cuenta es un correo, y los guardias no tienen correo de la empresa.
2. **El usuario lo arma el sistema** —inicial del nombre, apellido paterno,
   inicial del materno: `jgarridoh`— y tiene que ser único entre las dos
   tablas. La bitácora guarda ese usuario, y los documentos firmados también.
3. Los documentos firmados con el dedo guardan **el nombre y el RUT
   congelados** de quien firmó, amarrados a esa cuenta. Mudar el ingreso a otro
   sistema obligaría a revisar uno por uno qué prueba cada firma.

Así que esa lista no se va a llenar nunca. **La lista de verdad es
`v_cuentas`**, que está acá abajo y se abre igual de fácil.

---

## Ver todas las cuentas

Vaya a **Table Editor** y abra la vista **`v_cuentas`**. Salen juntas las de la
oficina y las de los guardias, con la columna `estado`, que es lo que se mira:

| estado | qué quiere decir |
|---|---|
| `al día` | entra sin problema |
| `BLOQUEADA` | tecleó mal su clave cinco veces. Se suelta sola a los 5 minutos |
| `CLAVE INICIAL SIN CAMBIAR` | cuenta de oficina que todavía no eligió la suya |
| `SIGUE CON EL RUT` | guardia que todavía no eligió la suya. **No puede marcar turno** |
| `nunca ha entrado` | la cuenta existe y nadie la ha usado |
| `DADA DE BAJA` / `DADO DE BAJA` | desactivada a propósito |

También se puede pedir desde el **SQL Editor**:

```sql
select * from v_cuentas order by clase, usuario;
```

Y para ver solo a quien tiene un problema ahora mismo:

```sql
select clase, usuario, nombre, estado, bloqueado_hasta
  from v_cuentas
 where estado in ('BLOQUEADA', 'CLAVE INICIAL SIN CAMBIAR', 'SIGUE CON EL RUT')
 order by estado, usuario;
```

---

## Los tres arreglos

Se pegan en el **SQL Editor** y se aprieta Run. Cada uno contesta con una frase
diciendo qué pasó.

### 1. «Dice cuenta bloqueada»

La persona se sabe su clave y la tecleó mal cinco veces. No hay nada roto.

```sql
select desbloquear_cuenta('jgarridoh');
```

Sirve igual para una cuenta de oficina y para un guardia. Si no hace nada, el
bloqueo igual se suelta solo a los cinco minutos.

### 2. «No me acuerdo de mi contraseña» — cuenta de oficina

La contraseña **no se puede recuperar**, solo reemplazar: lo guardado no es el
texto sino una derivación de la que no se vuelve. Se le pone una temporal y la
persona elige otra al entrar.

```sql
select restablecer_clave('jgarridoh', 'Temporal2026');
```

Escriba usted la temporal, de al menos 8 caracteres. Dígasela por teléfono.
**Al entrar, el sistema la va a obligar a cambiarla**, así que esa temporal
sirve una sola vez — lo cual importa, porque lo que se teclea acá queda
guardado en el historial del SQL Editor.

### 3. «No me acuerdo de mi clave» — guardia

La de un guardia vuelve a su RUT, que es como nace su cuenta:

```sql
select restablecer_clave_al_rut('pgonzalezm');
```

Entra con su RUT (sin puntos ni guion da lo mismo) y el sistema le pide elegir
otra antes de dejarlo marcar turno.

Si prefiere darle una temporal en vez del RUT, sirve el mismo comando del punto
2: `restablecer_clave` funciona con las dos clases de cuenta.

---

## Permisos, sin pasar por el panel

Qué abre cada rol vive en la tabla **`roles_permisos`**, que se puede editar
desde Table Editor. Los seis módulos que existen son:

`facturacion`, `cotizaciones`, `personal`, `documentos`, `rrhh`, `usuarios`

Un nombre fuera de esa lista **se rechaza**: la tabla tiene una restricción que
lo impide, a propósito. Un módulo mal escrito no da un error visible, da una
persona sin acceso que nadie entiende.

```sql
-- qué abre cada rol hoy
select rol, permisos, descripcion from roles_permisos order by rol;

-- darle un módulo a un rol entero
-- (el ::text no es adorno: sin él Postgres intenta leer 'cotizaciones' como
--  un arreglo entero y contesta «malformed array literal»)
update roles_permisos
   set permisos = permisos || 'cotizaciones'::text,
       actualizado_por = 'arreglado desde Supabase', actualizado_en = now()
 where rol = 'operaciones' and not permisos @> array['cotizaciones'];

-- quitarle un módulo a un rol entero
update roles_permisos
   set permisos = array_remove(permisos, 'cotizaciones'),
       actualizado_por = 'arreglado desde Supabase', actualizado_en = now()
 where rol = 'operaciones';

-- darle un módulo a UNA persona, sin tocar su rol
update usuarios set permisos_extra = array['cotizaciones'] where usuario = 'jgarridob';
```

Un cambio de permisos tarda **hasta un minuto** en notarse en los computadores
que ya tienen el sistema abierto: el Worker recuerda esta tabla por 30 segundos
para no consultarla en cada clic.

**Los cuatro roles no se cambian desde acá**: `gerencia`, `operaciones`, `rrhh`
y `prevencion` están fijos en una restricción de la tabla `usuarios`. Agregar un
rol nuevo sí necesita una migración.

### La regla que el panel no deja saltarse, y acá sí

La pantalla se niega a dejar al sistema **sin ninguna cuenta activa que abra el
módulo `usuarios`**, porque entonces nadie podría devolverle el acceso a nadie.
Desde el SQL Editor no hay quien lo impida. Antes de quitarle `usuarios` a un
rol o de dar de baja a alguien, revise que quede alguien:

```sql
select usuario, nombre from v_cuentas
 where clase = 'oficina' and activa and permisos @> array['usuarios'];
```

Si esa consulta devuelve cero filas, el sistema quedó cerrado por fuera y la
única salida es volver a este documento.

---

## Lo que sigue sin poderse hacer desde acá

- **Ver una contraseña.** No está guardada. De la columna `clave` no se vuelve
  al texto, ni acá ni en el panel ni con Claude.
- **Crear una cuenta de oficina.** Se puede a mano, pero hay que armarle el
  usuario, derivar la contraseña y no chocar con ninguna de las dos tablas:
  es justo lo que hace la pantalla sin equivocarse. Hágalo en
  Sistema → Usuarios.
- **Borrar cuentas.** No se borran, se dan de baja
  (`update usuarios set activo = false where usuario = '…'`). Lo que esa
  persona firmó, registró o corrigió apunta a su usuario.

---

## Si nada de esto existe

Si `v_cuentas` o `desbloquear_cuenta` dan «does not exist», es que falta
aplicar la migración. Abra el SQL Editor, pegue entero el archivo
`supabase/migrations/20261029120000_usuarios_permisos.sql` y apriete Run.
Se puede correr las veces que haga falta.

Péguelo con cuidado: ese archivo **empieza con dos líneas en blanco a
propósito**, porque el editor de Supabase a veces se come el primer carácter al
pegar, y es mejor que se coma un salto de línea y no un guion. Desde una
consola, lo más seguro es `pbcopy < supabase/migrations/20261029120000_usuarios_permisos.sql`.

Ver también `CLAVES.md`, que explica cuál es cuál entre las nueve cosas de este
sistema que se llaman «la clave».
