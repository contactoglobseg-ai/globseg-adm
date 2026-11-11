# Guardar el IRL (o cualquier papel de prevención) y marcar dónde se firma

Se hace **una sola vez por documento**. Después se manda a firmar las veces que
haga falta sin volver a subirlo.

---

## Antes de empezar: el documento tiene que ser PDF

El sistema **solo acepta PDF**, y no por capricho: la firma se estampa sobre
las hojas del archivo, y un Word o una foto no tienen hojas donde ponerla.

En Word, con el IRL abierto:

1. **Archivo → Guardar como…**
2. En «Formato de archivo» elegir **PDF**.
3. Guardar.

Mire el peso del PDF que salió. **El máximo es 10 MB.** Si se pasó, vuelva a
Word y en el mismo diálogo elija la opción de tamaño reducido (o quite las
fotos más grandes del documento).

---

## 1. Entrar

<https://adm.seggarridos.com/rrhh> → pestaña **Prevención**.

---

## 2. Guardar el documento en la biblioteca

1. Baje hasta **«Documentos guardados»**.
2. Apriete **«Guardar un documento»**.
3. Llene los tres campos:
   - **Cómo se llama** — con lo que lo va a elegir cada vez que lo mande.
     Por ejemplo `IRL GLOBSEG 2026`. Conviene que lleve el año: el día que
     salga el del 2027 van a estar los dos.
   - **Qué documento es** — para el IRL, *Derecho a saber (IRL)*. De ahí sale
     que el papel **vence a los doce meses** y vuelva a salir solo en «Lo que
     está venciendo».
   - **El archivo, en PDF** — el que acaba de guardar desde Word.
4. Apenas lo elija, la pantalla lo dibuja y dice **cuántas hojas tiene**.
   Si no dibuja nada, el archivo no es un PDF.
5. Apriete **«Guardar en la biblioteca»**.

---

## 3. Marcar qué va en cada lugar

Esto es lo que hace que la firma caiga en su recuadro —y no al pie de las 34
hojas— y que el nombre, el RUT y la fecha salgan escritos en vez de a mano.

1. En la fila del documento, apriete **«Marcar dónde firma»**.
2. Arriba hay cuatro botones: **Firma · Nombre · RUT · Fecha**. Elija uno y
   **toque la hoja donde va**. Queda un rectángulo con ese nombre.
3. En el acuse de recibo del RIOHS, por ejemplo, la línea es
   *Nombre · RUT · Firma del Trabajador*: se marcan los tres sobre la raya, y
   la fecha más abajo, en la línea «Fecha: ___/___/____».
4. Para que dos campos salgan en la misma línea, **tóquelos a la misma
   altura**: el alto del rectángulo no cambia aunque uno sea más ancho.
5. Si quedó corrido, quítelo con la **✕** de la lista de arriba y vuelva a
   tocar. Puede poner uno en cada hoja que lo pida.
6. Apriete **«Guardar dónde va la firma»** y después **«Cerrar»**.

Qué pone cada uno, todo congelado en el documento el día que se firmó:

| Botón | Qué escribe |
|---|---|
| Firma | El trazo que la persona dibujó con el dedo |
| Nombre | El nombre completo con que se firmó |
| RUT | El RUT con que se firmó, con puntos y guion |
| Fecha | El día en que se firmó, como 11/11/2026 |

> **Si no marca ninguno, la firma va al pie de todas las hojas**, como se hacía
> hasta ahora. Es lo correcto para una charla o una entrega de EPP de una hoja;
> para el IRL no.

### La huella dactilar

**No se pone desde acá, y no es una limitación que se pueda levantar.** El
lector de huella de los teléfonos nunca le entrega la imagen a una página web:
la huella no sale del chip seguro del aparato. Y una huella inventada dentro de
un documento firmado sería un dato falso que nadie podría distinguir del
verdadero.

Esa casilla se llena **en terreno, sobre papel**: se imprime la hoja que la
pide, se toma la huella, y esa hoja se archiva en la carpeta personal del
trabajador o se sube escaneada a sus documentos.

---

## 4. Mandarlo a firmar

1. Arriba, en **«Mandar un documento a firmar»**.
2. En **«Qué se manda»** elija el documento guardado. Bajo el desplegable dice
   de qué se trata y **en cuántos lugares va la firma**: léalo, es la
   comprobación de que el paso 3 quedó bien.
3. Marque a quiénes. Puede filtrar por instalación y usar
   **«Marcar los N de la lista»**.
4. **«Mandar a firmar»**.

Cada persona lo ve al entrar a marcar turno, en su teléfono: lee el documento
hoja por hoja y lo firma con el dedo. Sale **un documento por persona** —el IRL
se firma de a uno por ley— pero **el archivo se guarda una sola vez**.

---

## 5. Mirar el primero que se firme, antes de archivarlo

La primera vez, y solo la primera:

1. En **«Lo mandado a firmar»**, apriete **«Ver quiénes»**.
2. Abra el de alguien que ya firmó y baje el PDF.
3. Mire que la firma haya caído **dentro del recuadro** y que no tape nada de
   lo que había escrito.

Si quedó corrida: vuelva al paso 3, corrija el punto, y mande el documento de
nuevo. **Lo ya firmado no cambia** —la posición se congela al enviar—, así que
el que salió mal hay que anularlo y rehacerlo.

---

## Cuando salga la versión nueva del IRL

No se corrige el guardado: **el archivo de un documento guardado no se
reemplaza nunca**, porque lo ya firmado quedaría apuntando a un papel que nadie
leyó.

1. Guarde el nuevo como un documento más (`IRL GLOBSEG 2027`).
2. Al viejo, **«Dar de baja»**.

El dado de baja deja de salir en la lista y no se puede mandar, pero **su
archivo se queda entero**: es el que estaba vigente cuando se firmó, y es el
que habría que mostrar si alguien pregunta. Se vuelve a ver marcando
«Ver también los dados de baja».

---

## Si la pantalla dice que falta una migración

Dice el nombre de un archivo `.sql`. Es un paso que se hace una vez en Supabase
(SQL Editor), y mientras tanto el resto de Prevención sigue andando: se puede
mandar a firmar subiendo el PDF en cada envío, como antes.
