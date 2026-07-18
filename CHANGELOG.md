# Notas de versión — ChopperBot

Registro de cambios de ChopperBot. Cada versión publicada aquí se anuncia en el
canal de novedades de Discord con `pnpm run release <versión>`.

Versionado semántico (`MAYOR.MENOR.PARCHE`):
- **PARCHE** (1.0.x) — correcciones y ajustes pequeños, sin cambios de comportamiento visibles.
- **MENOR** (1.x.0) — funciones nuevas compatibles con lo anterior.
- **MAYOR** (x.0.0) — cambios grandes o que rompen el uso previo.

> Cada entrada está escrita para la comunidad (español, sin tecnicismos). El texto
> que ves aquí es exactamente lo que se publica en Discord.

---

## 1.3.2 — 2026-07-18

🎬 **El escáner de archivos ya no revisa videos**

ChopperBot analiza los archivos que se suben para avisar si alguno es peligroso, pero los **videos** (mp4, mov, mkv, webm y demás) ya no pasan por ese análisis: son archivos pesados, casi nunca traen riesgos y solo gastaban el cupo diario de revisiones. Así el escáner se concentra en los archivos donde de verdad importa (documentos, comprimidos, instaladores…) y responde más rápido. Las imágenes ya se saltaban desde antes; ahora también los videos.

---

## 1.3.1 — 2026-07-15

🔎 **El monitor de Instagram entiende mejor los flyers**

Mejoramos cómo ChopperBot lee las publicaciones de las cuentas que sigue. Ahora separa dos tareas: primero **lee el texto del flyer** de la imagen y después **analiza el contenido** por separado. Con eso clasifica con más precisión de qué trata cada post (evento, convocatoria, alerta…) y saca mejor la fecha y el lugar cuando aparecen.

También corregimos un detalle por el que, a veces, en la tarjeta del post se colaba la palabra "null" en lugar de la fecha o el lugar. Ya no pasa.

---

## 1.3.0 — 2026-07-12

🎟️ **ChopperBot ahora te ayuda con las solicitudes de eventos por ticket**

Cuando abres un ticket para proponer un círculo, taller o asamblea, ChopperBot lee tu formulario al instante y publica ahí mismo una **propuesta ordenada**: confirma que tu solicitud llegó, traduce el día y la hora a una fecha concreta (por ejemplo "domingo" + "8pm" → "domingo 19 de julio, 8:00 PM"), anota quién es el/la ponente y si hace falta que el equipo haga el flyer, y revisa si ya hay algo agendado ese día para avisar de posibles choques.

Lo mejor: **lxs moderadorxs aprueban sin salir del ticket**. Basta con mencionar a ChopperBot ahí mismo ("@ChopperBot créalo") o pedirle un ajuste ("@ChopperBot mejor el sábado a las 7"), y el evento queda registrado en el calendario y publicado automáticamente. Ya no hay que copiar los datos a mano en otro canal.

La última palabra siempre es de lxs moderadorxs: solo lxs Moderadorxs y Administradorxs pueden aprobar un evento; el resto puede afinar los detalles de su solicitud, pero no crearlo.

---

## 1.2.1 — 2026-07-05

🧵 **El análisis de archivos ya funciona en hilos y foros**

Cuando alguien subía un archivo dentro de un hilo o de un canal de foro, ChopperBot reaccionaba con la lupa 🔬 pero no publicaba el resultado. Ya quedó corregido: ahora el veredicto (limpio / sospechoso / malicioso) también aparece en hilos y publicaciones de foro.

Además, si en algún canal ChopperBot no tiene permiso para escribir, ahora lo detecta antes de revisar el archivo y avisa en los registros, en lugar de quedarse en silencio.

---

## 1.2.0 — 2026-07-03

🛡️ **El análisis de archivos ahora cubre todo el servidor**

La revisión de archivos con VirusTotal ya no se limita a uno o dos canales: ahora ChopperBot puede vigilar **todos los canales del servidor** a los que tiene acceso, incluidos los que se creen en el futuro. Así, cualquier archivo (que no sea imagen) que alguien suba queda protegido, sin importar el canal.

Los administradores lo activan desde la consola de configuración con una sola instrucción (vigilar "este servidor"). No hace falta ir agregando canales uno por uno.

---

## 1.1.0 — 2026-07-03

🛡️ **Nueva función: revisión de archivos con VirusTotal**

Ahora ChopperBot cuida los canales: cuando alguien sube un archivo (que no sea una imagen), lo analiza automáticamente para avisarte si es seguro. **No hace falta mencionarlo** — reacciona solo al archivo.

### Cómo funciona
- 🔎 Mientras revisa el archivo verás un mensaje de "analizando…", y en cuanto termina te dice el resultado:
  - ✅ **Limpio** — ningún antivirus lo marca como dañino.
  - ⚠️ **Sospechoso** — algunos motores lo señalan; trátalo con cuidado.
  - 🛑 **Malicioso** — varios antivirus lo detectan como peligroso. El bot lo marca bien claro y **avisa a la moderación** para que nadie lo abra.
- 🔗 Cada resultado incluye un enlace a VirusTotal por si quieres ver el detalle completo.
- ⚡ Si un archivo ya se conoce, la respuesta es casi instantánea; y el bot reparte con calma sus consultas para no saturar el servicio.

Los administradores pueden elegir qué canales se vigilan desde la consola de configuración.

---

## 1.0.1 — 2026-07-03

🛠️ **Ajustes**

### Correcciones
- 📅 El calendario ahora encuentra tus eventos aunque los escribas sin acentos o con signos distintos (por ejemplo "reunion" en vez de "reunión"). Buscar y editar eventos es más fácil.
- 🤖 Mejoramos las instrucciones internas del bot para que no repita acciones que ya hizo.

---

## 1.0.0 — 2026-07-03

🎉 **¡Primera versión oficial de ChopperBot!**

ChopperBot es el asistente de la comunidad en Discord. Esto es lo que ya sabe hacer:

### Funciones
- 📅 **Calendario del servidor** — Los moderadores crean, editan y borran eventos hablándole en lenguaje natural. El bot arma el calendario del mes en imagen y publica también un archivo `.ics` para importarlo a tu propio calendario. Soporta eventos que se repiten (diario, semanal, mensual).
- 📸 **Monitor de Instagram** — Sigue las cuentas que nos importan y avisa en Discord cada vez que publican algo nuevo, sin repetir publicaciones.
- 💬 **Chat general** — Menciona al bot en cualquier canal y te responde o te orienta.
- ⚙️ **Consola de configuración** — Los administradores gestionan todo desde un canal privado.
