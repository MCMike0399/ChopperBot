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
