# Cómo activar el aviso diario de documentación (17-11-2026)

Lo que ya está hecho en el código: la pestaña **Personas → Documentación**, la
marca **«subido a Pronexo»** en cada documento, y la revisión de cada mañana a
las 8 (11:00 UTC). Faltan cuatro pasos que se hacen en los paneles, en este orden.

## 1. Pegar la migración en Supabase
`supabase/migrations/20261117120000_alertas_documentos.sql`, en el SQL Editor.
Copiarla así, por lo de los acentos del 05-11:

    LC_CTYPE=UTF-8 pbcopy < supabase/migrations/20261117120000_alertas_documentos.sql

Sin esto la pestaña abre igual y muestra lo que falta y lo que vence, pero no
se puede marcar Pronexo ni sale ningún correo, y lo dice con el nombre del archivo.

## 2. Publicar el Worker
Commit **solo de estos archivos** —hay cambios de otra sesión sin commitear en
`public/index.html`, `public/panel.css`, `src/asistencia.js` y `src/pagos.js`
que no son de esto— y push a `main`:

    git add src/alertas.js src/rrhh.js src/index.js public/rrhh.html wrangler.jsonc \
      supabase/migrations/20261117120000_alertas_documentos.sql COMO-ACTIVAR-AVISOS-DE-DOCUMENTOS.md
    git log origin/main..HEAD   # mirar que no se vaya nada ajeno

`wrangler.jsonc` ahora trae el disparador diario (`triggers.crons`).

## 3. Cuenta de correo (Resend) y su clave
El Worker manda los correos por Resend (gratis hasta 3.000 al mes; acá son 30).
1. Crear la cuenta en resend.com con contacto.globseg@gmail.com.
2. **Domains → Add domain → `seggarridos.com`.** Como el dominio está en
   Cloudflare, Resend ofrece configurar los registros DNS solo. Esperar a que
   diga *Verified*. Sin esto, Resend rechaza mandar desde `avisos@seggarridos.com`.
3. **API Keys → Create**, permiso *Sending access*. Se ve una sola vez.
4. Desde la carpeta `ADMINISTRACION/`:

       npx wrangler secret put RESEND_API_KEY

   y pegar la clave. No va al repositorio ni al chat.

Si se quiere otro remitente, variable `CORREO_REMITENTE` en `wrangler.jsonc`
(por omisión `Seguridad Garridos <avisos@seggarridos.com>`).

## 4. Primer uso, en Personas → Documentación
1. **Confirmar a quién le llega** («Cambiar»). Entra por confirmar con
   `rrhh2.globseg@gmail.com, rrhhglobseg@gmail.com`.
2. **Marcar lo que ya está en Pronexo.** Arriba aparece un botón para marcar de
   una vez todo lo cargado hasta hoy. Usarlo solo si de verdad está subido:
   desde ahí el aviso solo nombra lo nuevo. Cada uno se desmarca desde la ficha.
3. **«Enviar ahora»** para recibir el primero y ver cómo llega.

## Cómo se comprueba
    curl -s "https://adm.seggarridos.com/api/diagnostico" -H "Cache-Control: no-cache" \
      | grep -oE '"(correo_de_alertas_configurado|documentos_con_pronexo|avisos_documentos|envios_alertas)":[a-z]+'

Las cuatro en `true`. Y en la pestaña, «Último:» dice si el de la mañana salió
o por qué no salió.
