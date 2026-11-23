# Cómo entra alguien nuevo a la oficina

Escrito el 08-11-2026, al ingresar a **Pablo Follmer Acuña** en recursos
humanos, en reemplazo de Valeria Torres.

Sirve para cualquiera que entre a la oficina. Lo que es propio del caso de
Pablo va marcado.

---

## El orden importa, y por una razón concreta

**Primero el correo, después la cuenta del sistema.** La cuenta de
`adm.seggarridos.com` se identifica por el correo, y **ni el correo ni el
nombre se pueden corregir desde la pantalla**: `editar()` en
`src/usuarios.js` deja cambiar el rol, los módulos, dar de baja, desbloquear
y restablecer la clave, y nada más. Si el correo se escribe mal, la salida es
crear otra cuenta y dar de baja la primera, con el usuario cambiado y la
bitácora partida en dos.

---

## 1. Correo corporativo

Lo crea gerencia. Para Pablo: `rrhh2.globseg@gmail.com`.

**El correo de Valeria no se le entrega.** `rrhhglobseg@gmail.com` es su
casilla de trabajo, ella no puede autorizar nada hoy, y lo que hay adentro es
suyo hasta que vuelva. Lo que sí se puede decidir es **reenviar a la casilla
nueva lo que llegue de ahora en adelante**: es una regla permanente del buzón,
la pone gerencia, y conviene avisarle a quien escriba.

---

## 2. Cuenta del sistema propio — `adm.seggarridos.com`

Pantalla **Sistema → Usuarios → «Nueva cuenta de oficina»**. La abre solo
gerencia.

- Nombres, apellido paterno y apellido materno **en tres campos separados**.
  El usuario se arma solo con la inicial del nombre, el apellido paterno y la
  inicial del materno. Para Pablo: **`pfollmera`**.
- El rol decide qué abre. **Recursos humanos** abre Personas (fichas,
  contratos, documentos, vencimientos) y Sueldos (liquidación, finiquito,
  parámetros, Transferencias y Carga masiva).
- **La contraseña temporal aparece una sola vez.** No se guarda, no entra a
  la bitácora y no vuelve si se recarga. Se copia ahí mismo y se dicta. Si se
  pierde, se restablece desde la misma fila.
- Quien entra tiene que cambiarla antes de poder hacer nada.

**La cuenta de quien se va no se toca por reflejo.** Darla de baja no libera
ninguna licencia ni hace falta para que entre el nuevo, y se reactiva con un
botón. En el caso de Valeria se deja activa.

---

## 3. Sistema Contable — el ERP

**Preguntar primero por un usuario asociado**, antes de contratar una cuenta
nueva. Es una decisión ya tomada (04-11-2026) y sale bastante más barato.

Dos cosas que conviene resolver en la misma pasada, porque entra gente nueva
al área:

- El token **`control dato`** tiene **escritura completa** sobre la
  contabilidad, se usó una sola vez el 05-10-2026 y no se ha revisado desde
  entonces.
- El módulo de contabilidad del sistema propio
  (`contabilidad.seggarridos.com`) hoy lo abre **solo `sgarridob`**. Si el
  nuevo tiene que entrar, es la variable `CUENTAS_CONTABILIDAD` de
  `CONTABILIDAD/wrangler.jsonc` y un despliegue — no es un permiso de la base
  y no se edita desde ninguna pantalla. **Para Pablo se decidió que no**
  (08-11-2026): queda solo con RRHH, así que ahí no hay nada que cambiar.

---

## 4. Defontana — acá está el filo

**La butaca es de la empresa; la identidad no.**

**Lo que no se hace: pasarle a Pablo el usuario y la clave de Valeria.** Todo
lo que haga queda registrado a nombre de ella, y ella está en el hospital. El
día que se discuta una liquidación, un pago o un dato cambiado, el registro va
a decir que lo hizo una persona que no estaba. Eso no se arregla después
explicándolo.

**Lo que sí se hace:** pedirle a Defontana que **cambie el titular de esa
misma butaca** —nombre y correo a Pablo— y que **restablezca la clave**. Es la
licencia que ya se paga, no una más. Si el titular no se puede cambiar sin
cobrar una butaca adicional, eso hay que preguntarlo **antes** de entregar
nada, no después.

Como la empresa está saliendo de Defontana, vale la pena aprovechar el
traspaso para **anotar qué es lo único que todavía se hace ahí**. Hoy no está
escrito en ninguna parte, y esa lista es exactamente lo que falta traer al
sistema propio.

**Y queda una cosa que acordarse:** cuando Valeria vuelva, esa butaca va a
estar a nombre de Pablo.

---

## 5. Lo que pide el cargo, no el computador

- **Contrato.** Se genera desde Personas → Documentos, con la plantilla, y se
  firma con el dedo desde el teléfono. Si es un reemplazo a plazo fijo, ojo con
  la fecha de término: pasado un día el contrato es indefinido (art. 159 N°4).
- **Ficha completa.** Sin ella no se le puede calcular sueldo ni feriado, y el
  sistema se niega a generar el contrato antes que emitirlo con un hueco.
- **Prevención.** IRL del DS 40 art. 21, RIOHS, protocolo Ley Karin. Se mandan
  a firmar desde la pestaña Prevención, y la firma queda al pie de todas las
  hojas.
- **Confidencialidad.** Este cargo abre el sueldo, el RUT, la previsión de
  salud y la cuenta bancaria de toda la empresa. La **Ley 21.719 rige desde el
  01-12-2026**. Si va a haber un compromiso escrito, éste es el momento de
  firmarlo, no después.

---

## 6. Lo que el que llega hereda a medias

Esto no es una lista de tareas inventada: es lo que el sistema muestra **en
ámbar** porque nadie lo ha confirmado todavía. Conviene mirarlo la primera
semana, y la primera vez con alguien al lado.

En **Sueldos → Parámetros**:

- **UF y UTM del mes, las dos en cero.** Sin ellas no hay topes imponibles ni
  impuesto único, y el cálculo lo dice en vez de inventarlo.
- **Tasa adicional de la mutual (DS 110), en 0**: el costo empresa sale bajo.
  La da el organismo administrador.
- Tramo del **aporte del empleador** de la Ley 21.735, **topes imponibles
  2026** (AFP/salud y cesantía), tasa del **SIS** y las **comisiones de las
  AFP**.
- Los **seis montos de asignación familiar** (Ley 18.020), en cero: hoy la
  asignación calcula cero para todos.

Fuera de ahí:

- La **cuenta de origen** de las transferencias está en blanco (Documentos →
  Datos de la empresa).
- Los **códigos de banco** entraron sin confirmar y se confirman de a uno
  contra la nómina del banco con que se paga.
- **Nadie ha cursado un estado de pago de verdad** ni ha subido una nómina al
  banco desde el sistema.

---

## 7. El día que alguien se va

La misma lista al revés, y conviene correrla el mismo día:

- **Usuarios → dar de baja.** Es reversible y no borra nada.
- Quitar o traspasar la butaca de Defontana y el usuario del ERP.
- El correo corporativo.
- **Nada de lo firmado se borra.** Los documentos guardan el nombre y el RUT
  congelados, y siguen valiendo.
