# Propuesta: sistema de gestión de personas y operaciones

Respuesta al encargo del 21-10-2026 (el documento tipo «Buk + operación de
guardias»). Es lo que pide el punto 1 de ese encargo: preguntas, arquitectura,
modelo de datos y plan por fases **antes** de escribir código.

**Decidido el mismo 21-10-2026, después de la primera versión de este
documento:** se extiende lo que hay en vez de reconstruirlo; **RRHH es el
departamento más importante** y se completa primero; y RRHH sale a
**`rrhh.seggarridos.com`**, conectado al resto. El §3 explica cómo se conecta y
el §4 trae el plan ya reordenado por esa decisión.

---

## 0. Lo primero, porque cambia todo lo demás

El encargo está escrito como si no existiera nada. **Existe bastante y está en
producción.** `adm.seggarridos.com` y `asistencia.seggarridos.com` llevan diez
días funcionando, con 27 tablas, siete vistas y unas 10.000 líneas de código
probado. Entre un tercio y la mitad de lo que pide el documento ya está hecho.

Construir desde cero en NestJS + Next.js + React Native + Docker + S3 + Redis
significa:

- botar lo que funciona y volver a probarlo todo;
- cambiar una infraestructura que hoy cuesta casi nada y no tiene servidores
  que mantener (Cloudflare Workers + Supabase) por uno que sí los tiene;
- dejar a la oficina sin sistema durante la transición, o mantener dos.

**Recomendación: extender lo que hay, no reconstruir.** Lo que falta —turnos,
terreno, remuneraciones completas— se construye encima, no al lado. Abajo está
el detalle de qué está y qué falta, y en qué puntos el stack actual sí se queda
corto y hay que reforzarlo.

Si de todos modos se quiere rehacer, el costo honesto es de dos a tres meses
solo para volver al punto en que se está hoy, sin ninguna función nueva.

---

## 1. Qué está hecho y qué falta

Punto por punto del encargo. «Parcial» quiere decir que existe y sirve, pero no
cubre todo lo que pide el documento.

| § | Módulo | Estado | Detalle |
|---|--------|--------|---------|
| 4.1 | Ficha del trabajador | **Hecho** | 50+ campos: personales, previsión, salud, banco, emergencia, tallas, licencia de conducir. Falta: **cargas familiares** (asignación familiar) e historial de cargos y sueldos como línea de tiempo. |
| 4.1 | Credenciales y vencimientos | **Parcial** | Catálogo de 25 tipos de documento con base legal y vencimiento, en la base y no en el código. Alerta en rojo lo vencido y lo por vencer. Falta: avisos **a 60, 30 y 7 días** y, sobre todo, **que el sistema impida asignar un turno** — hoy no hay turnos que bloquear. |
| 4.2 | Clientes e instalaciones | **Parcial** | Clientes, instalaciones con comuna, región y dirección. Falta: **contrato comercial** (tarifa por hora o puesto, recargos, vigencia), **geocerca** y **puestos** con horario y requisitos. |
| 4.2 | Directiva de funcionamiento | **Falta** | Es un documento con vencimiento por instalación: cabe en el catálogo que ya existe, movido de la persona a la instalación. |
| 4.3 | Planificación de turnos | **Falta** | **Es el hueco grande.** No hay pauta, ni calendario de turnos, ni validaciones, ni cobertura, ni reemplazos. |
| 4.4 | Asistencia | **Parcial** | Marca con GPS desde el teléfono, turno de noche como una jornada, tope de 20 h, libro inalterable, descarga a Excel con las horas como número. Falta: geocerca, **modo sin conexión**, atrasos y ausencias (no hay pauta contra qué compararlos), cálculo de horas extra y nocturnas, y el **formato que exige la DT**. |
| 4.4 | Permisos, licencias, vacaciones | **Parcial** | Ausencias y feriado en días hábiles calculados con los feriados legales de verdad. Falta el flujo de aprobación desde el teléfono. |
| 4.5 | Operación en terreno | **Falta** | Rondas, libro de novedades, incidentes, botón de pánico, visitas de supervisión: nada. |
| 4.6 | Remuneraciones | **Parcial** | Liquidación y finiquito **estimados**, con costo empresa, topes, impuesto único y parámetros con fecha de vigencia. Falta: liquidación oficial, **Previred, LRE, DJ 1887, nómina del banco**, anticipos, préstamos, CCAF, retenciones judiciales. |
| 4.7 | Firma digital | **Hecho** | Plantillas con variables, firma con el dedo desde la cuenta del propio trabajador, texto congelado, hash, hora de servidor, PDF de 120 KB. Es firma simple de la Ley 19.799 y lo dice impreso. Falta: firma **avanzada** (necesita prestador acreditado) y envío masivo. |
| 4.8 | Selección y onboarding | **Parcial** | La ficha de ingreso que llena el propio trabajador por un enlace de un solo uso y RRHH revisa. Falta: vacantes y pipeline, y el checklist de inducción. |
| 4.9 | Capacitación y desempeño | **Falta** | Los cursos con vencimiento están como documentos; falta el registro de curso, asistencia y evaluación. |
| 4.10 | Activos y equipamiento | **Falta** | Nada. Es de las piezas más autónomas: se puede hacer sin tocar el resto. |
| 4.11 | App del guardia | **Parcial** | `asistencia.seggarridos.com` es web, anda en gama baja y pesa poco. Marca turno, cambia su clave y firma documentos. Falta: ver su pauta, pedir vacaciones, bajar liquidaciones, **canal Ley Karin**. |
| 4.12 | Beneficios y bienestar | **Falta** | Nada. |
| 4.13 | Finanzas y facturación | **Parcial, y es lo más maduro** | Ciclo de cobro por aniversario, OC, folios, detector de extras sin facturar, cotizaciones con PDF, filtros por empresa. Falta: **prefactura por horas efectivamente cubiertas** (necesita turnos) y **rentabilidad real** (necesita el costo laboral por instalación). |
| 4.14 | Reportería | **Parcial** | Panel de cobranza, calendario, Excel. Falta: dotación, rotación, ausentismo, mapa en vivo, margen por cliente. |
| 5 | Roles y permisos | **Parcial, y hay que arreglarlo temprano** | Cuatro roles con módulos, más permisos por persona, más un permiso de borrar nominativo. **No hay alcance**: un supervisor vería todas las instalaciones, no las suyas. Eso toca todas las consultas, así que va en la fase 1, no al final. |
| 5 | Bitácora de auditoría | **Hecho** | `bitacora` registra quién, qué y cuándo en cada acción. Falta el «desde dónde» (ya se guarda huella de IP en firmas y contactos; falta generalizarlo). |
| 6 | Multiempresa | **Falta** | Hoy es una sola razón social, implícita. Agregarlo después cuesta tocar las 27 tablas. Hay que decidirlo ahora (ver pregunta 10). |
| 6 | 2FA | **Falta** | Hoy: usuario y clave, PBKDF2, bloqueo a los 5 intentos, cookie firmada de 10 h, todo por https con HSTS. |
| 6 | Backups | **Por verificar** | Supabase respalda a diario según plan; **no se ha probado una restauración**. |

### Deuda que bloquea cualquier fase nueva

**Las migraciones no se aplican solas.** Desde el 14-10 ni la integración de
Supabase ni el workflow de Actions corren `supabase/migrations/`. Las siete
tablas del módulo de documentos y firma están desplegadas en el código y **no
existen en la base**. Esto no es un detalle de proceso: es la diferencia entre
«hecho» y «hecho en producción», y ya pasó dos veces con módulos enteros.
Cualquier plan por fases que no empiece por arreglar esto va a acumular el
mismo daño a mayor escala.

---

## 2. Preguntas (primera ronda, diez)

Ordenadas por lo que más cambia el diseño. Las respuestas a la 3, la 4 y la 10
son las que deciden la arquitectura; las demás ajustan alcance.

### Contexto
1. **¿Cuántos trabajadores hay hoy y cuántos se proyectan a dos años? ¿Cuántos
   clientes e instalaciones?** El encargo los dejó entre corchetes. Con 30
   guardias y con 300 el diseño de la pauta de turnos no es el mismo, y define
   si hace falta algo más que un Worker para el cálculo mensual.

### Asistencia y la Dirección del Trabajo
2. **¿El libro de asistencia tiene que ser el registro válido ante la DT, o la
   empresa seguirá llevando el registro oficial por otra vía?**
   Es la pregunta más cara del encargo. Hay dos caminos y conviene elegir antes
   de construir sobre el libro actual:
   - *Integrar un proveedor ya certificado* y que el sistema propio consuma sus
     marcas. Menos riesgo legal, costo mensual por trabajador, y la marca deja
     de ser nuestra.
   - *Registrar el sistema propio* ante la DT, cumpliendo los requisitos
     vigentes (marcas inalterables —ya se cumple—, comprobante al trabajador,
     acceso para fiscalización, reportes en su formato).
   **Mi recomendación es la segunda**, porque el libro ya es inalterable por
   diseño y lo que falta son el comprobante y los reportes, no el fondo. Pero
   **PENDIENTE VALIDAR** con un abogado laboral cuál es hoy el trámite exacto y
   qué exige el reglamento vigente: no voy a inventar el procedimiento.

### Turnos (el módulo que falta y el más difícil)
3. **¿Qué se asigna a un turno: un guardia o una pareja de patrullaje?** Todo
   el tarifario está cotizado en parejas y el módulo 3 acordado en octubre decía
   «planillas de turnos por pareja». Si la unidad es la pareja, la pauta, las
   validaciones y los reemplazos se diseñan distinto desde la primera tabla.
   Y además: **¿quién arma hoy la pauta y en qué?** (¿Joaquín, en Excel?)
   Ver ese archivo real vale más que diez preguntas.

### Remuneraciones
4. **¿El sistema debe emitir las liquidaciones oficiales y generar Previred, o
   seguir entregándole las horas a quien hoy calcula los sueldos?**
   La empresa ya tiene un ERP contable con centralización de remuneraciones. Si
   el cálculo oficial se queda allá, esta fase se reduce a exportar horas y
   conceptos, y se puede hacer en semanas. Si el cálculo oficial se muda acá,
   es la fase más larga del proyecto y la que exige cuadrar al peso contra
   liquidaciones reales. **¿Puede entregar 3 a 5 liquidaciones reales** de
   meses distintos para cuadrar?

### Operación en terreno y app
5. **Los guardias, ¿usan su propio teléfono o uno de la empresa? ¿Hay señal en
   los parques?** De esto depende si el modo sin conexión es un extra o es el
   requisito central, y si conviene seguir con web (lo que hay, se actualiza
   sola, no pasa por tiendas) o pasar a una app instalable.

6. **Geolocalización: ¿la geocerca debe bloquear la marca fuera de rango, o
   solo registrarla y avisar?** Hoy la ubicación *se pide pero no se exige*,
   porque un turno no se puede perder por un permiso del teléfono. Bloquear
   cambia esa decisión. Y por la Ley 21.719: **¿hay consentimiento firmado por
   el tratamiento de ubicación?** Si no, hay que generarlo — la plantilla se
   suma a las que ya existen.

### Clientes y facturación
7. **¿Cómo se cobra de verdad: por puesto al mes (como hoy) o por hora
   efectivamente cubierta? ¿Los contratos tienen descuento por puesto
   descubierto?** La prefactura del §4.13 supone lo segundo; el sistema actual
   está hecho sobre lo primero. Si conviven ambas, el contrato comercial tiene
   que decir cuál aplica.

### Alcance legal
8. **¿Hay vigilantes privados armados, o solo guardias de seguridad?** Cambia
   el marco entero: vigilantes privados tienen otro régimen, y el armamento
   obliga a trazabilidad legal en el módulo de activos.

9. **¿Se quiere el portal del cliente y el acceso de fiscalizador, o se dejan
   para después?** ¿Algún cliente ya lo está pidiendo? Es de las pocas cosas
   que se pueden vender como diferencia frente a G4S y Securitas.

### Infraestructura
10. **¿Va a haber más de una razón social?** Hoy el sistema asume una. Hacerlo
    multiempresa ahora cuesta poco; hacerlo en seis meses obliga a migrar todas
    las tablas y todas las consultas. Si la respuesta es «probablemente sí»,
    se hace ahora.

---

## 3. Arquitectura propuesta

### Lo que se mantiene, y por qué

| Pieza | Hoy | Propuesta |
|---|---|---|
| Backend | Cloudflare Worker, JS sin framework | **Se mantiene.** Responde en el borde, sin servidor que mantener ni contenedor que actualizar. Lo que falta no es un framework: es código. |
| Base | Supabase (Postgres 16) vía PostgREST | **Se mantiene**, y se enciende **PostGIS** para las geocercas (viene en Supabase, es una línea). |
| Archivos | Supabase Storage, bucket privado, por el Worker | **Se mantiene.** Nada de URLs firmadas: acá hay contratos y exámenes médicos. |
| Web de oficina | Una página, un `<script>`, sin build | **Se mantiene** mientras siga cabiendo. Hoy son 5.600 líneas: el límite está cerca, y conviene partirla por módulo **antes** de agregar turnos, no después. |
| App del guardia | Página web | **PWA instalable** con almacenamiento local para el modo sin conexión. Depende de la pregunta 5. |
| Tareas programadas | No hay | **Cron Triggers de Cloudflare**, para los avisos de 60/30/7 días y la detección de puestos descubiertos. |
| Correo y WhatsApp | No hay | Proveedor de correo transaccional para los avisos; WhatsApp Business API solo si la oferta de reemplazo lo justifica (pregunta 3). |

### Dónde el stack actual sí se queda corto

Esto hay que decirlo antes de prometer fases:

- **PBKDF2 en Workers no pasa de 100.000 iteraciones.** Ya se sabe; está en
  100k. Para 2FA habrá que apoyarse en TOTP, no en más iteraciones.
- **Tiempo de CPU por invocación.** El cálculo de remuneraciones de 200
  personas no cabe en una sola pasada; la carga masiva ya va de a 25 filas por
  eso mismo. Si la fase 4 se hace acá, el cálculo mensual se parte en lotes o
  se mueve a una función de Supabase.
- **No hay colas.** Para avisos masivos y ofertas de reemplazo hará falta
  Cloudflare Queues, o aceptar que se manden de a tandas desde el cron.
- **`not_found_handling: single-page-application`** hace que una ruta mal
  escrita devuelva `index.html` con **HTTP 200** en vez de 404. Ya mordió dos
  veces. Con más páginas, hay que verificar siempre por `content-type`.

### Modelo de datos: lo que se agrega

Sobre las 27 tablas que ya existen. Las nuevas, por módulo:

**Comercial y puestos** (pregunta 7)
- `contratos_comerciales` — cliente, vigencia, modalidad de cobro (puesto o
  hora), tarifas, recargos nocturno/festivo, descuento por puesto descubierto.
- `puestos` — instalación, nombre, cobertura (24/7, diurno, nocturno),
  requisitos (tipo de credencial, curso, experiencia), consignas, tarifa.
- `instalaciones.geocerca` — `geography(Point)` + radio en metros (PostGIS).

**Turnos** (pregunta 3)
- `pautas` — plantilla rotativa: 4x4, 7x7, 5x2, con su ciclo y horarios.
- `asignaciones` — quién (guardia o pareja) a qué puesto, con qué pauta, desde
  cuándo.
- `turnos` — **la fila por día**: puesto, fecha, horario, quién, estado
  (planificado, cubierto, descubierto, reemplazado). Es la tabla contra la que
  se compara la asistencia y de la que sale la prefactura.
- `reemplazos` — oferta, a quiénes, quién aceptó, cuándo.
- `parejas` — si la unidad es la pareja.

**Terreno**
- `rondas` y `puntos_control` (QR/NFC), `lecturas_punto`.
- `novedades` — el libro de turno: texto, fotos, audio, ubicación, entrega de
  turno.
- `incidentes` — clasificación, severidad, aviso al cliente, seguimiento.
- `visitas_supervision` — checklist, firma, fotos. La firma reusa `firma.js`.

**Remuneraciones** (pregunta 4; solo si el cálculo oficial se muda acá)
- `conceptos`, `liquidaciones`, `liquidacion_lineas`, `prestamos`,
  `retenciones`, `anticipos`.

**Activos**
- `articulos`, `stock`, `entregas` (la entrega firmada reusa el módulo de
  documentos, que ya existe).

**Transversal**
- `usuarios.alcance` — región, cliente o instalación. Es el cambio del §5 que
  hay que hacer temprano.
- `empresas` + `empresa_id` en todo, si la pregunta 10 es que sí.

### `rrhh.seggarridos.com`: cómo se conecta (decidido 21-10-2026)

Decisión del gerente: RRHH sale a su propio dominio, conectado con el resto, y
**es el departamento más importante** porque las personas son el giro. Eso
cambia el orden de las fases (ver §4) y define esto:

**Un solo Worker, tres páginas, pronto cuatro.** El mecanismo ya existe y está
probado: `wrangler.jsonc` lleva `run_worker_first: true`, el Worker lee la
cabecera `Host` y decide qué entregar. `asistencia.seggarridos.com` funciona
así desde el 14-10. Agregar RRHH es:

1. Dominio personalizado `rrhh.seggarridos.com` apuntando al Worker
   `globseg-adm`, igual que se hizo con asistencia.
2. En el Worker, `host.split('.')[0] === 'rrhh'` → entrega `rrhh.html`.
3. En `cabecerasSeguridad()`, una cuarta página. RRHH **sí** necesita la CSP
   del panel, no la cerrada: baja planillas a Excel con SheetJS y emite PDF con
   jsPDF, los dos desde cdnjs. Geolocalización en `()`, como el panel.

**Conectado quiere decir: la misma base y la misma persona, no una copia.**
Esto es lo que más importa cuidar. La ficha de un guardia es **una fila** en
`trabajadores`, la misma que usa el libro de asistencia para dejarlo marcar
turno y la misma de la que sale su contrato. Dos registros de la misma gente
son, a los tres meses, dos respuestas a «¿cuántos guardias tenemos?». Ya se
decidió así en octubre al construir RRHH sobre `trabajadores` en vez de una
tabla nueva, y el dominio aparte no cambia nada de eso: cambia dónde se mira,
no dónde vive.

**Las pantallas de RRHH se mudan, no se copian.** Hoy las cinco viven dentro de
`public/index.html`, que ya va en 5.600 líneas. Van a `rrhh.html` y el panel
**deja de dibujarlas**: en su lateral, el grupo «Personas» pasa a ser un enlace
a `rrhh.seggarridos.com`. Dejar las dos copias andando es el error que este
proyecto ya cometió tres veces —los tokens de apariencia duplicados, el
subtotal de la cotización escrito en dos puntas, los campos del contrato— y las
tres veces las copias se separaron solas. Una sola, con enlace desde la otra.

Para que eso se pueda hacer sin romper nada, antes hay que **separar en un
archivo compartido** lo que las dos páginas usan: `pedir()`, `$`, `aviso()`, el
dibujo de tablas y la barra de selección. Con cuidado, porque dos `<script>`
clásicos comparten ámbito global y una sola declaración repetida deja la página
**en blanco**, no a medias. Ya pasó al unificar la apariencia.

**La sesión: un ingreso por dominio, y es lo correcto.** La cookie de oficina no
lleva atributo `Domain`, así que es del host que la puso: quien entra en
`adm.seggarridos.com` no llega autenticado a `rrhh.seggarridos.com`. Se podría
compartir poniéndole `Domain=seggarridos.com`, pero entonces la cookie de
sesión de la oficina **también viajaría a `seggarridos.com`**, que es la página
pública y es otro despliegue distinto, que no tiene nada que ver con esto.
Mandarle la sesión de la oficina a un sitio que no la necesita no se paga con
ahorrarle un ingreso al día a dos personas. Quedan dos ingresos para quien use
los dos dominios; el usuario y la clave son los mismos, y los permisos también.

Lo que sí hay que resolver: una cuenta que entre a `rrhh.seggarridos.com` sin
el módulo `rrhh` tiene que leer *«su cuenta no tiene acceso a Personas»* y un
enlace al panel, no una pantalla en blanco ni un 403 pelado.

### Lo que **no** hay que construir de nuevo

La firma, el catálogo de documentos, las plantillas con variables, el PDF, la
bitácora, el motor de fechas de ciclo, los feriados legales calculados, la
carga masiva desde Excel con pasada en seco, el tope de envíos públicos, los
enlaces de un solo uso, el tema claro/oscuro con tamaño de letra, la barra
lateral con sus grupos: todo eso ya está probado y se reusa. El módulo de
activos, por ejemplo, es una tabla y una pantalla: la entrega firmada ya
funciona.

---

## 4. Plan por fases

Reordenado dos veces. Primero respecto del encargo, porque su fase 1 supone
turnos y los turnos suponen puestos, que no existen. Y después respecto de mi
propia propuesta del 21-10 en la mañana, porque **el gerente puso a RRHH como
el departamento más importante**: antes los turnos iban primero, ahora RRHH se
completa primero y en su propio dominio.

El orden tiene además una razón técnica, no solo una de prioridad: **RRHH es el
único módulo grande que no depende de ningún otro**. Fichas, contratos,
documentos, cursos, selección y activos se terminan sin que exista una sola
pauta de turnos. Al revés no: los turnos necesitan que la ficha diga qué
credencial tiene cada uno y hasta cuándo, porque de eso vive la regla estrella
del encargo —no asignar a quien tiene la credencial vencida—.

### Fase 0 — Que lo construido llegue a producción (bloqueante)
Sin esto, cada fase siguiente repite el daño de octubre: código desplegado sin
tablas detrás.
- Correr `supabase/reparar-historial.sql`, elegir entre la integración de
  Supabase y el workflow de Actions, y dejar **uno** aplicando migraciones.
  *Lo tiene que hacer el usuario en los paneles.*
- Aplicar las siete tablas pendientes del módulo de documentos y firma — que
  es, justamente, un módulo de RRHH.
- Probar una restauración del respaldo. Un respaldo sin restauración probada es
  una creencia.
- Cambiar la clave inicial `123321`, que está en el historial del chat.

### Fase 1 — `rrhh.seggarridos.com` en el aire, con lo que ya está
No agrega funciones: muda. Primero el dominio con lo que hoy funciona, para
que lo nuevo entre en una casa que ya existe y no al revés.
- Separar en archivos compartidos lo que usan las dos páginas (`pedir`, `$`,
  `aviso`, tablas, barra de selección), con la precaución de siempre: una
  declaración repetida entre dos `<script>` clásicos deja la página en blanco.
- `rrhh.html` con las cinco pantallas que hoy viven en el panel; el panel deja
  de dibujarlas y su grupo «Personas» pasa a ser un enlace.
- Dominio personalizado, cuarta página en `cabecerasSeguridad()`, y el aviso
  para la cuenta que entre sin el módulo.

*Criterio de aceptación:* Valeria entra a `rrhh.seggarridos.com`, hace todo lo
que hacía, y el panel de cobranza no quedó con una copia de nada.

### Fase 2 — RRHH completo
Lo que le falta al área, ahora que es la prioridad.
- **Cargas familiares** (asignación familiar, tramos), que es lo único de la
  ficha legal que falta entero.
- **Avisos a 60, 30 y 7 días** por Cron Trigger, por correo, de credenciales,
  cursos, contratos a plazo y resoluciones DT. Hoy el aviso existe pero hay que
  entrar a mirarlo: nadie entra a mirar lo que no le llega.
- **Historial** de cargos, sueldos e instalaciones como línea de tiempo, más
  amonestaciones, licencias médicas y vacaciones. Los datos están repartidos en
  contratos y ausencias; falta la vista que los cuenta como una sola historia.
- **Capacitación:** cursos internos y obligatorios con asistencia y
  certificado, enganchados al vencimiento que ya vigila el catálogo.
- **Selección y onboarding:** vacantes y pipeline hasta la contratación, y el
  checklist de inducción —ODI, RIOHS, EPP— que termina en la firma que ya
  funciona. La ficha de ingreso por enlace ya está y es el primer paso.
- **Activos y EPP:** inventario, entrega y devolución firmadas. Es de lo más
  barato que queda: la entrega firmada ya existe, falta el inventario.
- **Canal Ley Karin**, con denuncia anónima y su flujo de investigación.
- **Portal del trabajador:** desde la misma cuenta con que marca turno, ver sus
  documentos, pedir vacaciones y permisos, y bajar lo que le corresponda.
- **Alcance por rol** (quién ve a quién): va acá y no al final, porque toca
  todas las consultas y es más barato antes que después.

*Criterio de aceptación:* nadie tiene que entrar a mirar si algo vence; llega
solo. Y una credencial vencida no aparece dos veces en dos listas distintas.

### Fase 3 — Puestos, contratos comerciales y pauta de turnos
El hueco grande de operaciones, y lo que convierte a RRHH en algo que además
bloquea.
- Clientes con contrato comercial y tarifas; puestos por instalación con
  requisitos y consignas; directiva de funcionamiento con vencimiento.
- Pautas rotativas que generan el calendario; vista por instalación, por puesto
  y por guardia.
- Validaciones en vivo: jornada semanal, descanso entre turnos, domingos
  libres, **credencial vigente y requisitos del puesto** —acá es donde RRHH
  empieza a impedir cosas, no solo a avisarlas—, sin doble asignación, y sin
  pauta excepcional si la resolución DT está vencida.
- Exportación de la pauta para el cliente y para fiscalización.

*Criterio de aceptación:* no se puede asignar a un guardia con credencial
vencida ni pasarse de la jornada legal, y el sistema dice exactamente por qué.

### Fase 4 — Asistencia contra la pauta
Recién acá la asistencia puede hablar de atrasos y ausencias, porque hay con
qué comparar.
- Geocerca; **modo sin conexión** con la marca firmada en el teléfono; QR o NFC
  en la instalación.
- Atrasos, ausencias y marcas fuera de rango con aviso a la central.
- Tablero de cobertura en vivo y puestos descubiertos.
- Reemplazos sugeridos por disponibilidad, cercanía, requisitos y horas
  acumuladas, con aceptación desde el teléfono.
- Horas ordinarias, extra, nocturnas, festivas y de domingo, calculadas.
- Comprobante al trabajador y reportes en formato DT (según la pregunta 2).

*Criterio de aceptación:* una ausencia a las 07:05 en un turno de 07:00 avisa a
la central en menos de un minuto con la lista de reemplazos.

### Fase 5 — Terreno
Rondas con puntos de control, libro de novedades con entrega de turno,
incidentes con aviso al cliente, botón de pánico y «hombre vivo», visitas de
supervisión con checklist y firma.

### Fase 6 — Remuneraciones
Su alcance depende entero de la pregunta 4. Si el cálculo oficial se muda acá:
conceptos configurables, cálculo desde la asistencia, liquidación firmada,
Previred, LRE, DJ 1887, nómina del banco, centralización por centro de costo
hacia el ERP, finiquitos, préstamos, CCAF y retenciones.
**No empieza sin las liquidaciones reales de referencia.**

Si la respuesta es que el cálculo oficial se queda donde está hoy, esto se
adelanta y se achica: es exportar horas y conceptos al ERP, y cabe dentro de la
fase 4.

### Fase 7 — Dinero y vista de gerencia
Prefactura por cobertura real, rentabilidad por contrato e instalación (costo
laboral contra facturado), portal del cliente, paneles de dotación, rotación,
ausentismo y margen.

### Transversal
2FA para cuentas administrativas, beneficios y bienestar, multiempresa (en la
fase 0 si la respuesta a la pregunta 10 es sí; después cuesta migrar las 27
tablas).

### Qué se entrega al cerrar cada fase
Historias con criterios de aceptación, el modelo de datos, migraciones que
aguantan correrse dos veces, datos de prueba contra la réplica local, pruebas
automatizadas de los cálculos (turnos, horas, sueldos) con los casos borde del
encargo —meses de 28 a 31 días, turnos que cruzan medianoche, cambio de hora,
festivos irrenunciables—, y un manual corto.

---

## 5. Riesgos y PENDIENTE VALIDAR

- **PENDIENTE VALIDAR — registro de asistencia ante la DT.** Qué exige hoy el
  reglamento vigente y cuál es el trámite. No lo doy por sabido.
- **PENDIENTE VALIDAR — Ley 21.659 y su reglamento.** Requisitos del personal,
  credenciales, cursos y directivas de funcionamiento por instalación, y ante
  qué autoridad se tramita cada cosa hoy.
- **PENDIENTE VALIDAR — Ley 21.561.** Las 42 horas vigentes y el calendario de
  transición a 40, y cómo se cuentan en jornada excepcional autorizada.
- **PENDIENTE VALIDAR — Ley 21.719.** Qué exige para tratar ubicación y
  antecedentes penales: consentimiento, finalidad, plazos de conservación. Hoy
  el libro guarda la ubicación de cada marca sin un consentimiento firmado.
- **Riesgo legal propio del rubro:** si la resolución DT del sistema
  excepcional vence, el 4x4 y el 7x7 dejan de estar autorizados aunque la gente
  siga trabajando igual. El sistema ya lo vigila; la fase 1 debe además
  **impedir** generar pauta excepcional sin resolución vigente.
- **Riesgo técnico:** la firma es simple, no avanzada. Para finiquitos
  tramitados por el portal de la DT, el camino es ese portal, no esta firma.
- **Riesgo de proceso:** las migraciones. Ya costó un módulo entero.
