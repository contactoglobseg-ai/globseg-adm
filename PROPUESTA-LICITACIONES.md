# Licitaciones de Mercado Público en la parte comercial

Pedido del gerente (23-10-2026), mientras tramita el ticket de la API.
Este documento dice qué entrega esa API, qué se puede construir con ella, qué
falta decidir y en qué orden conviene hacerlo.

---

## 1. Lo que se verificó, no lo que se supone

Todo lo de esta sección está comprobado contra la documentación oficial y
contra la API misma; lo que no se pudo comprobar se dice.

**El ticket.** Se pide en `api.mercadopublico.cl`, entrando con Clave Única y
aceptando los términos de uso. Llega por correo al que quedó registrado. Los
términos dicen **«se entrega un único ticket por persona»**: el ticket queda a
nombre de quien lo pidió, no de la empresa. Quien lo saque es el responsable
del uso que se le dé, así que conviene que lo pida el gerente y no un tercero.

**Los límites.** 10.000 consultas por día por ticket, y ChileCompra dice que
ese tope no se cambia. No hay límite por hora, pero el uso se vigila **por
dirección IP** y recomiendan correr las descargas grandes **entre las 22:00 y
las 07:00**. Para lo que necesitamos esto sobra: un barrido diario del rubro
gasta entre 50 y 300 consultas.

**La API no avisa los errores con el código HTTP.** Probado hoy desde la
consola, sin ticket:

```
GET https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json?fecha=22102026
→ {"Codigo":203,"Mensaje":"Ticket no válido."}
```

El cuerpo trae el error y el estado HTTP no sirve para detectarlo. **Hay que
mirar el cuerpo siempre**, o un ticket vencido se vería como «no hay
licitaciones hoy» y nadie se enteraría durante semanas. Es el mismo criterio
con que el sistema trata las migraciones que no se aplicaron: si algo no se
pudo hacer, tiene que decirlo, no quedarse callado.

**El listado y el detalle son dos consultas distintas, y eso define el
diseño.** El listado por fecha o por estado devuelve solo cuatro campos por
licitación: `CodigoExterno`, `Nombre`, `CodigoEstado` y `FechaCierre`. Todo lo
que sirve para decidir si postular —el organismo, la comuna, el monto
estimado, los ítems, las fechas de la visita a terreno y de cierre— solo viene
al pedir **una licitación a la vez** por su código:

```
.../licitaciones.json?codigo=1509-5-L114&ticket=...
```

Así que el barrido es en dos pasos: una consulta trae los códigos del día, y
después se pide el detalle de los que valen la pena. Pedir el detalle de todas
las del día sería gastar miles de consultas para botar el 99%.

**Lo que trae el detalle, y que es justo lo que hoy nadie mira a tiempo:**

| Para qué sirve | Campos |
|---|---|
| Quién compra y dónde | `Comprador/NombreOrganismo`, `ComunaUnidad`, `RegionUnidad`, `DireccionUnidad` |
| A quién llamar | `Comprador/NombreUsuario`, `NombreResponsableContrato`, `EmailResponsableContrato`, `FonoResponsableContrato` |
| Si conviene | `MontoEstimado`, `Moneda` (CLP, CLF, UTM…), `Estimacion`, `Tipo` (L1/LE/LP/LQ/LR) |
| Cuánto dura | `TiempoDuracionContrato` + `UnidadTiempoDuracionContrato`, `EsRenovable` |
| Cuándo hay que correr | `Fechas/FechaCierre`, `FechaVisitaTerreno`, `FechaEntregaAntecedentes`, `FechaPubRespuestas`, `FechaEstimadaAdjudicacion` |
| Qué se pide exactamente | `Items/Listado/ítem/` con `CodigoCategoria`, `Categoria`, `NombreProducto`, `Descripcion`, `Cantidad`, `UnidadMedida` |
| Cómo se paga | `Modalidad` (pago a 30 días, mensual, etc.), `TipoPago` |
| Si ya se adjudicó y a quién | `Adjudicacion/Fecha`, `NumeroOferentes`, `UrlActa`, y por línea `RutProveedor`, `NombreProveedor`, `MontoUnitario` |

Ese último bloque es la mitad del valor del módulo y casi nadie lo usa: **las
licitaciones adjudicadas dicen a qué precio ganó la competencia**, por línea y
con el RUT del proveedor. Es el único tarifario real de mercado al que se
puede acceder, y sirve para decidir con qué número ir a la siguiente.

**Estados:** 5 publicada, 6 cerrada, 7 desierta, 8 adjudicada, 18 revocada,
19 suspendida.

---

## 2. Lo que no se pudo confirmar y hay que mirar con el ticket puesto

- **Los códigos de rubro exactos.** La codificación es UNSPSC v7. Las fuentes
  que se encontraron apuntan a la familia **9212** («servicios de seguridad y
  protección personal»), con `92121503` para guardias y `92121701`/`92121703`
  para monitoreo de alarmas, pero son fuentes de compras públicas de otros
  países, no de ChileCompra. **No se van a dar por buenos.** La primera semana
  el barrido guarda todo lo de la familia 92 más lo que calce por texto, y se
  mira qué llegó de verdad: ahí se ajusta el filtro con datos, no con una lista
  copiada de internet.
- **Si Compra Ágil usa el mismo ticket.** Tiene documentación aparte y una API
  v2 que manda el ticket en una cabecera en vez de en la URL. Importa porque
  Compra Ágil son las compras chicas, se resuelven en días y hay varias de
  seguridad para eventos puntuales.

---

## 3. Lo que resuelve, dicho sin adornos

Hoy nadie revisa Mercado Público, o lo revisa alguien a mano cuando se acuerda.
Lo que se pierde no es una licitación: es **la fecha de cierre**. Una licitación
que se encuentra tres días tarde vale lo mismo que una que no existió, y la
visita a terreno obligatoria cierra la puerta antes todavía.

El módulo no es un buscador. Es lo mismo que hace el Panel con los periodos por
cobrar: **una lista corta de lo que vence pronto y a lo que hay que
responder**, y la plata que se escapa es por donde no se mira.

---

## 4. Qué se construye

### 4.1 El barrido diario, solo

Un **Cron Trigger de Cloudflare** a las 06:00 UTC (03:00 en Chile, dentro de la
ventana que ChileCompra recomienda). Hoy el Worker no tiene ninguno: hay que
agregar `"triggers": { "crons": ["0 6 * * *"] }` en `wrangler.jsonc` y un
`async scheduled()` al lado del `fetch()` de `src/index.js`.

Cada corrida:
1. Pide el listado del día y el de `estado=activas`.
2. Descarta lo que ya está guardado por `codigo_externo`.
3. Pide el detalle de lo nuevo, **de a tandas**, como hace la carga masiva de
   RRHH con las 25 filas: el Worker tiene tiempo de CPU acotado y una corrida
   que se pase no deja nada escrito.
4. Puntúa cada una contra los filtros y guarda **todas las que pasan el filtro
   de rubro**, interesantes o no. Una licitación descartada por el filtro y no
   guardada no se puede revisar después para ver si el filtro estaba mal.
5. Anota en la bitácora cuántas miró, cuántas guardó y cuántas falló.

**Si el barrido falla, tiene que verse.** Una tabla `mp_barridos` con la fecha,
el resultado y el error: la pestaña muestra arriba, en rojo, «el último barrido
fue hace 3 días». Un robot que dejó de correr en silencio es peor que no
tenerlo, porque la oficina deja de mirar a mano confiando en él.

### 4.2 Las tablas

```sql
mp_licitaciones     -- una fila por licitación, con el detalle ya desarmado
  codigo_externo text primary key      -- "1509-5-L114"
  nombre, descripcion, estado, codigo_estado, tipo
  organismo, rut_unidad, unidad, comuna, region, direccion
  contacto_nombre, contacto_email, contacto_fono
  monto_estimado numeric, moneda, estimacion
  duracion_valor int, duracion_unidad, es_renovable
  fecha_publicacion, fecha_cierre, fecha_visita_terreno,
  fecha_entrega_antecedentes, fecha_adjudicacion timestamptz
  puntaje int                          -- por qué entró
  interes text                         -- 'nueva' | 'revisando' | 'postulando'
                                       -- | 'postulada' | 'ganada' | 'perdida'
                                       -- | 'descartada'
  notas text, responsable text
  cotizacion_id bigint references cotizaciones(id)
  crudo jsonb                          -- la respuesta tal como llegó
  visto_en, actualizado_en timestamptz

mp_items            -- las líneas de cada licitación
  licitacion, correlativo, codigo_categoria, categoria,
  nombre_producto, descripcion, cantidad, unidad_medida,
  adj_rut_proveedor, adj_nombre_proveedor, adj_monto_unitario

mp_filtros          -- qué se considera nuestro, editable desde la pantalla
  tipo ('rubro' | 'palabra' | 'region' | 'organismo'), valor, peso, activo

mp_barridos         -- cuándo corrió, qué trajo, qué falló
```

Dos decisiones que importan:

- **`crudo jsonb` guarda la respuesta entera.** Hoy no sabemos qué campo va a
  hacer falta, y una licitación cerrada ya no se puede volver a pedir completa.
  Guardar el original cuesta unos kilobytes y evita el único error que no se
  puede arreglar después.
- **Lo que escribe la oficina (`interes`, `notas`, `responsable`) no lo toca
  nunca el barrido.** El barrido solo actualiza lo que viene de Mercado Público
  —principalmente el estado y la adjudicación—. Una licitación marcada como
  «postulando» no puede volver a «nueva» porque el robot la encontró otra vez.

### 4.3 La pantalla

Pestaña **Licitaciones** en el grupo **Comercial** de `adm.seggarridos.com`,
al lado de Contactos web y Cotizaciones. Dentro, tres cosas:

1. **Lo que cierra esta semana**, arriba y en rojo bajo tres días, con los días
   que faltan. Es la única parte que de verdad hay que mirar todos los días.
2. **Las nuevas desde ayer**, con organismo, comuna, monto y los ítems. Cada
   una con tres botones: «Me interesa», «Descartar» y **«Cotizar»**, que abre
   el editor de cotizaciones con el organismo como cliente y los ítems de la
   licitación ya como líneas, en la moneda que pide la licitación. Ese botón es
   el que hace que el módulo sirva: hoy ya se cotiza en pesos y en UF, y las
   licitaciones vienen en CLP, CLF o UTM.
3. **Lo adjudicado del rubro**, que es la consulta de precios: quién ganó, a
   qué monto por línea y el acta. Sin botones, solo para mirar antes de armar
   el número de la siguiente.

Más un filtro por región y por estado, con el mismo patrón que el filtro por
empresa del Panel.

### 4.4 Permisos

Se reusa el módulo **`cotizaciones`** —gerencia y Joaquín— y no se inventa uno
nuevo. Quien decide si se postula es quien cotiza, y el permiso ya existe. Si
mañana hace falta separarlos, es una línea en `PERMISOS`.

### 4.5 El ticket

Va como **secreto del Worker** (`MP_TICKET`), puesto en el panel de Cloudflare,
nunca en `wrangler.jsonc`: las variables de texto de ese archivo se reescriben
en cada `wrangler deploy`, los secretos no. Es la misma regla que ya siguen
`SUPABASE_SERVICE_KEY` y `SESION_SECRETO`. Entra en `CLAVES.md` como la décima.

Sin ticket configurado **nada revienta**: el barrido no corre, la pestaña
aparece y dice que falta el ticket. Igual que hace hoy «Activos y EPP» cuando
le falta la migración.

---

## 5. Lo que a propósito no se hace

- **No se postula desde acá.** La oferta se sube en Mercado Público, con la
  clave de la empresa. Automatizar eso significaría guardar esa clave en el
  sistema, y una oferta mandada por un robot con un número equivocado no se
  retira.
- **No se inventa el puntaje de conveniencia.** El sistema ordena por fecha de
  cierre y marca por qué entró cada una; decidir si conviene es del gerente.
- **No se avisa por WhatsApp.** El aviso por correo sí es razonable, pero se
  deja para después de ver cuántas llegan por semana: un correo diario que
  casi siempre dice «nada nuevo» se deja de abrir en quince días.

---

## 6. Lo que necesito de usted

Lo primero es lo único que bloquea; lo demás se puede ir decidiendo con el
módulo ya andando.

1. **El ticket**, cuando llegue. No lo mande por este chat ni por correo:
   póngalo usted directo en Cloudflare → Worker `globseg-adm` → Settings →
   Variables → **Secret**, con el nombre `MP_TICKET`. Avíseme cuando esté y lo
   verifico con `/api/diagnostico`, que no muestra valores.
2. **Qué es «nuestro»**, para armar el filtro: ¿solo guardias y vigilancia, o
   también cámaras y alarmas, control de acceso y seguridad de eventos?
3. **Qué regiones.** La página pública dice cinco. ¿El filtro va por esas
   cinco, o se mira todo Chile y se descarta mirando?
4. **Hasta dónde llega el seguimiento.** ¿Basta con enterarse a tiempo, o
   quiere además llevar adentro del sistema en qué va cada postulación
   (presentada, adjudicada, perdida) y con qué número se fue?
5. **El `CodigoProveedor` de GLOBSEG en Mercado Público**, si lo tiene a mano.
   No es el RUT: es un código interno de la plataforma, y con él la API entrega
   directo lo que la empresa ha postulado y lo que le han adjudicado.
6. **¿Interesan también las órdenes de compra y Compra Ágil?** Son la misma API
   y las compras chicas se resuelven rápido.

---

## 7. En qué orden

| Paso | Qué queda andando | Depende de |
|---|---|---|
| 1 | Migración, módulo `src/licitaciones.js` que lee la API, y una ruta que trae una licitación por código. Se prueba contra la API real con una licitación cualquiera. | El ticket |
| 2 | El barrido diario con su Cron Trigger, la bitácora de corridas y el aviso de barrido caído. | Paso 1 + respuestas 2 y 3 |
| 3 | La pestaña Licitaciones: lo que cierra, lo nuevo, y marcar interés. | Paso 2 |
| 4 | El botón «Cotizar», que arma la cotización con los ítems. | Paso 3 |
| 5 | Lo adjudicado como consulta de precios de la competencia. | Paso 2 |
| 6 | Seguimiento de la postulación y aviso por correo. | Respuesta 4 |

Los pasos 1 a 3 son los que resuelven el problema de verdad —enterarse a
tiempo—. Del 4 en adelante es sacarle más partido a lo mismo.

---

## 8. Fuentes

- Página oficial de la API: <https://www.chilecompra.cl/api/>
- Solicitud del ticket con Clave Única: <https://api.mercadopublico.cl/modules/IniciarSesion.aspx>
- Diccionario de datos de licitaciones (PDF oficial):
  <https://www.chilecompra.cl/wp-content/uploads/2026/03/Documentacion-API-Mercado-Publico-Licitaciones.pdf>
- Preguntas frecuentes de la API: <https://ayuda.mercadopublico.cl/preguntasfrecuentes/articulo/?id=KA-01985>
