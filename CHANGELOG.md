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
