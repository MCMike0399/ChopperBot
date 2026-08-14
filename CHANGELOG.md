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

## 1.19.1 — 2026-08-13

🎟️ **Los tickets ya no se quedan atrás**

Cuando lxs mods ajustan un evento desde su ticket (mover la fecha, corregir el título…), yo actualizaba el calendario pero a veces **el evento de Discord ya no existía** — por ejemplo, si la fecha original ya había pasado — y mi confirmación decía "el evento de Discord se refleja solo"… sin que hubiera nada que reflejar. 🙃 Ahora lo detecto en el momento: si falta, lo creo de nuevo ahí mismo (con el flyer del ticket de portada) y anexo el enlace en mi confirmación.

Y dos ajustes finos del mismo día:
- En los tickets también puedo actualizar la peli/tema de la semana de un club que ya existe, sin duplicar nada (la herramienta nueva de hoy ahora también jala ahí).
- Si me adjuntas la imagen del evento, puedo ponerla o cambiarla de portada del evento de Discord **aunque el evento ya exista** — el enlace para apuntarse no cambia.

---

## 1.19.0 — 2026-08-13

🎬 **Ya sé actualizar la peli de la semana (sin duplicar el club)**

Cuando lxs mods me avisan qué se ve esta semana en el club de cine — o el tema de cualquier actividad semanal — aunque solo me manden el cartel, ahora actualizo **la sesión de esa semana** en la serie que ya existe: le pongo el título ("Club de cine: Persepolis"), la descripción si el cartel la trae, la hora si esa semana cambia, y dejo el evento de Discord listo para que la gente se apunte. Antes me podía dar por crear un evento nuevo y el club salía duplicado en el calendario, la tarjeta del mes y los anuncios. Ya no.

🙈 **Y dejo de decir "no pude" cuando sí había podido**

Cuando me mandaban un cartel de evento como imagen, a veces respondía *"No pude generar una respuesta esta vez"* aunque **el evento sí se había creado bien** en el calendario — con su evento de Discord y todo. Lo que fallaba no era el evento, sino mi mensaje de confirmación: el modelo que lee imágenes a veces termina su trabajo sin escribir el texto final, y yo me rendía en vez de volver a pedírselo. Ahora lo intento de nuevo hasta dos veces antes de rendirme. Y tranquilidad — reintentar nunca crea el evento dos veces.

---

## 1.18.0 — 2026-08-13

🐢 **Bajo el ritmo en Instagram, a propósito**

Instagram me mandó un aviso de "actividad automatizada sospechosa" por andar revisando las cuentas demasiado seguido y demasiado parejito. Todavía no pasó nada grave, pero si le sigo al mismo ritmo me pueden bloquear la cuenta con la que reviso — y ahí sí nos quedaríamos sin avisos de Instagram por completo. Mejor bajarle antes que después. 🙃

Lo que ajusté:
- Reviso **menos veces al día** y con **pausas más irregulares**, para no parecer un robot con cronómetro.
- Amplié mi descanso nocturno: ahora duermo de **1:00 a 8:00**.

**¿Qué cambia para ustedes?** Que puedo tardar más en avisar de una publicación nueva — en el peor caso varias horas, antes era cuestión de minutos u horas. Lo importante: **no se pierde ninguna publicación**. Cuando reviso, alcanzo a ver todo lo que se publicó mientras no estaba viendo. Es un cambio de *velocidad*, no de cobertura.

🔧 **Y dejo de tocar puertas que Instagram ya cerró**

Desde el 18 de julio, Instagram responde con un error a **5 cuentas** que sigo (`contramascaras`, `yoxlas40horas`, `vozdelosdesaparecidospuebla`, `semillasderebeldia` y `manatimx`). El problema es de su lado, no de las cuentas — están perfectamente bien y públicas. Pero yo seguía intentándolo una y otra vez sin éxito durante casi un mes, y eso era justo una de las cosas que me hacía ver más sospechoso (además de gastar como **una quinta parte** de todas mis revisiones en intentos fallidos).

Ahora, si una cuenta me falla siempre de la misma forma, la **pauso sola** y le aviso a la moderación en lugar de seguir insistiendo. Eso libera tiempo para las cuentas que sí funcionan. Cuando Instagram lo arregle, la moderación las reactiva con un comando — no se reactivan solas, justamente para que alguien revise antes.

---

## 1.17.1 — 2026-08-11

🔔 **Ahora sí me entero cuando copias y pegas mi nombre**

Algunxs de ustedes ya lo notaron: si copiaban "@ChopperBot" de otro mensaje y lo pegaban en el suyo, yo ni me enteraba y los dejaba en visto. 😅 Eso pasaba porque para Discord un nombre pegado es solo texto, no una mención de verdad.

Ya quedó arreglado: si escribes o pegas **@ChopperBot** (o mi apodo en el servidor), respondo igual que con la mención azulita. Eso sí — si solo hablan *de* mí sin el arroba, no me meto en la conversación. 🤖

---

## 1.17.0 — 2026-08-11

📚 **Los talleres ahora sí pueden con libros y documentos enormes**

La estrella de esta versión son los **talleres privados** (los canales que abres reaccionando 🎓 en #bienvenidx):

- **Súbele un libro o documento largo sin miedo.** Antes, si le pedías al bot trabajar con un PDF de cientos de páginas, se saturaba y a veces se quedaba sin responder. Ahora el bot arma primero un **índice interno del documento** (páginas, capítulos y secciones) y trabaja sobre él: puede **buscar exactamente lo que le preguntes** y decirte en qué página está, o leerlo por partes para resumirlo capítulo por capítulo, avanzando por tandas y entregándote el avance en cada vuelta. Lo probamos con un libro real de 409 páginas: pregunta puntual, respuesta con citas de página. 🤓
- **El indicador de actividad se queda donde brilla.** En tu taller sigues viendo en vivo qué está haciendo el bot ("🐍 Ejecutando código · paso 3 · 45s"), ahora también cuando busca o lee dentro de tus documentos. En los canales públicos del server, en cambio, el bot vuelve al estilo discreto de siempre: reacciones en tu mensaje (⏳🤔🛠️) y el "escribiendo…" de Discord, sin mensajes extra que hagan ruido.

🧠 **El cerebro principal del bot volvió a casa**

- El proveedor que se cayó ayer en la mañana (y que nos obligó a cambiar de emergencia) **ya se recuperó**: lo verificamos con toda nuestra batería de pruebas (8/8 en manejo del calendario, 0 fallas) y el bot ya responde de nuevo con su cerebro de siempre. El plan de mudanza definitiva al proveedor nuevo sigue en pie para fin de mes, y si algo vuelve a fallar el cambio es inmediato.

## 1.16.2 — 2026-08-11

📣 **Un solo aviso por evento (adiós al anuncio triplicado)**

Esta mañana el aviso de las 10 del conversatorio salió **tres veces seguidas**, cada una con su notificación a todo el server. No fue la primera vez: pasó también el 5, el 6 y el 8 de agosto. Ya está arreglado de raíz.

- **Qué pasaba.** El internet del bot es lento, y cuando Discord tardaba más de 15 segundos en confirmarle "listo, ya lo publiqué", el bot creía que se había caído el mensaje y lo mandaba otra vez. Pero Discord sí lo había publicado — así que quedaban dos o tres anuncios idénticos.
- **Qué cambia.** Ahora cada anuncio lleva una especie de folio único, y Discord reconoce que es el mismo aviso de siempre: si ya lo publicó, no lo vuelve a publicar. **El aviso duplicado ya no existe, y por lo tanto tampoco la notificación repetida.**
- **De pilón.** El bot ya no puede empezar a preparar el anuncio del día si todavía está terminando el anterior, que era otra manera de que se colara repetido.

Antes el bot borraba las copias unos segundos después, pero la notificación ya les había llegado igual (y varias veces les tocó borrarlas a mano antes que él). Eso se acabó: ahora la copia no llega a existir.

## 1.16.1 — 2026-08-11

🔧 **El bot volvió a responder, y ya no se le pierden posts**

Hoy al mediodía el servicio de inteligencia artificial que usa ChopperBot para entender y responder mensajes se cayó por completo (era una falla del proveedor, no del bot). Durante unos minutos el bot contestó "hubo un error" a todo el mundo. Ya está resuelto: lo cambiamos a otro proveedor y quedó **más rápido que antes**. Lo que cambia:

- **Vuelve a responder con normalidad** en el chat, el calendario, los talleres y las solicitudes de eventos.
- **Responde más rápido.** Las respuestas que llevaban más de medio minuto ahora tardan unos segundos.
- **Ya no se pierden publicaciones de Instagram.** Cuando el bot no lograba analizar un post de las cuentas que vigila, lo descartaba para siempre sin avisar. Ahora lo vuelve a intentar más tarde, así que las convocatorias y eventos que antes se colaban ya llegan al canal.

## 1.16.0 — 2026-08-10

📅 **"Crea el evento" — ahora sí sabe de cuál le hablan**

Cuando el bot les recuerda que falta crear el evento de Discord de algo que viene, ya pueden **responder a ese mismo mensaje** con un simple *"crea el evento"* y lo hace. Antes se le olvidaba de qué estaban hablando y pedía título y fecha de un evento que él mismo acababa de nombrar. Lo que cambia:

- **Se acuerda de lo que él mismo dijo.** Si responden a un aviso suyo, ahora lee ese aviso como parte de la conversación. Esto aplica a todos sus avisos, no solo a los del calendario.
- **El recordatorio trae el número del evento** (`#28`), así que se puede copiar tal cual: *"crea el evento de Discord del #28"*.
- **Sabe cuáles eventos ya tienen su evento de Discord y cuáles no**, sin tener que buscarlo. Si solo falta uno, lo confirma en una línea en vez de interrogarlxs.
- **Ya no deja eventos sin sala en silencio.** Al crear el evento de Discord les dice en qué sala quedó, y si no encontró ninguna lo dice y pregunta: *"quedó sin sala — ¿en cuál va?"*. Cuando le contestan, mueve el evento de Discord a esa sala él solito.

## 1.15.0 — 2026-08-09

📎 **"Ya te lo envié" — y esta vez, de verdad**

Nos llegó el caso: alguien pidió su documento corregido en Word y PDF, el bot respondía "ya te lo envié" una y otra vez… y el archivo nunca llegaba. El documento sí existía, pero se quedaba guardado en el taller sin adjuntarse, y el bot no tenía forma de darse cuenta. Ya quedó corregido por todos los frentes — y de paso el bot aprendió modales.

### Talleres
- **Los archivos generados ya no se quedan sin adjuntar**: si el bot crea un entregable (Word, Excel, PDF, gráfica…) y por cualquier razón no lo adjunta en su respuesta, el sistema lo adjunta automáticamente al final de la vuelta. Nunca más un "aquí está" sin archivo.
- **El bot ahora sabe qué te llegó y qué no**: su lista de archivos del taller marca cuáles ya te entregó ✅ y cuáles siguen sin enviarse ⚠️. Si le dices "no me llegó", lo verifica y te lo reenvía al momento, en vez de discutir.
- **Tono más de asistente**: el taller ahora mantiene un trato cálido pero siempre respetuoso — no repite groserías aunque se le hable con ellas, y cuando algo falla lo reconoce y lo corrige en vez de insistir en que estaba bien.

---

## 1.14.0 — 2026-08-07

🗄️ **Los archivos de tu taller ahora viven en el disco grande de la casa**

Todo lo que subes a tu taller y lo que el bot genera ahí (PDFs, Excels, documentos, gráficas) ahora se guarda en el **disco duro grande** del servidor, con copia de respaldo en el canal. Antes tus archivos vivían solo en el chat y en la tarjeta de memoria chica — ahora hay casi 2 terabytes de espacio para que los talleres crezcan tranquilitos.

### Talleres
- **Tus archivos tienen casa nueva**: cada documento de taller se guarda automáticamente en el almacenamiento grande. Si el bot se reinicia o limpia su memoria de trabajo, tus archivos reaparecen solos cuando los vuelves a necesitar.
- **Cerrar el taller sigue borrando todo**: cuando cierras tu taller desde el panel, sus archivos desaparecen de todos los lugares donde se guardan — como siempre.
- **Corrección**: un archivo cuyo nombre terminaba en punto (un caso raro de nombre largo) no se encontraba al recuperarlo; ya se reconoce sin problema.

---

## 1.13.0 — 2026-08-06

📚 **Resumir libros completos ya funciona — por tandas y sin quedarse sin aire**

Nos llegó el caso de prueba perfecto: "necesito una explicación por capítulo de este libro" — ¡408 páginas! El bot lo intentaba todo de una sola vez, se quedaba sin aire y terminaba respondiendo "No pude generar una respuesta…". Ya quedó corregido: ahora prepara el libro una sola vez (índice + capítulos separados), **trabaja de 1 a 3 capítulos por vuelta**, va guardando todo en un documento y te entrega el avance. Tú solo dices **"sigue"** y continúa exactamente por donde iba, sin repetir trabajo. Y si una tarea larga se atora al final, ahora reintenta la respuesta en vez de rendirse.

### Talleres
- **Limpiar el chat ahora deja tus archivos a la vista**: al darle 🧹, todo lo que subiste y lo que el bot generó queda reunido en un solo mensaje 📁 del canal. Borrón de conversación de verdad, con los archivos intactos y fáciles de encontrar.
- **PDFs aún mejor leídos**: nueva herramienta para extraer **tablas** de un PDF (te las puede entregar en Excel), y mejor estrategia para libros largos: primero el índice, capítulos por separado, avance por partes.
- **Los nombres de archivo largos ya no pierden su extensión**: un PDF con nombre larguísimo llegaba al taller sin el ".pdf" al final; ya se conserva.
- Refuerzo interno: los límites de memoria/tiempo del entorno aislado de Python no se estaban aplicando por un detalle del sistema; ya funcionan como se diseñó.

---

## 1.12.0 — 2026-08-06

🗺️ **ChopperBot ya conoce todos los canales del servidor**

Hoy alguien le preguntó por el canal nuevo de bienvenida y contestó que no lo tenía en su lista. Eso ya no pasa: ahora ChopperBot puede **consultar en vivo el directorio del servidor** — pregúntale de qué va cualquier canal, qué canales hay, o dónde va cada cosa, y te responde con la información real del momento, no con una lista fija.

Y tranquilx: solo te muestra los canales **que tú puedes ver**. Lo que no es para ti, para ChopperBot tampoco existe cuando le preguntas.

### Mejoras a los talleres (gracias al primer taller de hoy 📖)
- **Lee PDFs bien**: si le subes un PDF (apuntes, un libro, un paper) ahora lo procesa a la primera, sin dar vueltas.
- **Puedes interrumpirlo**: si está tardando y le escribes otro mensaje, suelta lo que estaba haciendo y atiende lo nuevo — como en los chats de IA de página web.
- **Ves lo que está haciendo en vivo**: una línea de estado que se va actualizando ("🐍 Ejecutando código · paso 3 · 45s") y que al terminar se convierte en la respuesta.
- **Ya no promete y se queda a medias**: le dimos mucho más aire para pensar en tareas largas, así que "te armo un documento Word" ahora termina con el documento de verdad en el chat.
- **Un error ya no lo deja "trabado"**: antes, si una respuesta fallaba, el bot podía quedarse repitiendo el mismo error aunque le volvieras a preguntar. Ahora esos tropiezos se olvidan solos.
- **Memoria de sesión larga**: en sesiones largas el bot va resumiendo lo trabajado, así que no pierde el hilo aunque lleven horas — y "limpiar" sigue borrando todo de verdad.
- **Tus archivos viven en el canal**: lo que subes y lo que el bot genera queda como adjuntos en tu taller (por eso "limpiar" conserva los mensajes con archivos), y la Raspberry solo guarda una copia temporal que se limpia sola.
- **Nunca más "texto raro" en el chat**: si el modelo se atora y empieza a escribir sus propias notas técnicas, ya no se publican — el bot rehace la respuesta. Y ninguna respuesta puede ocupar más de 5 mensajes.
- **Con libros completos ya no se ahoga**: ahora los procesa con código (2–4 pasos y el archivo listo) en vez de intentar leerse el libro entero de a pedazos.
- Menos vueltas en general: cuando algo no le sale, lo dice y propone alternativa en vez de insistir.

### En los canales del servidor
- **Ya se nota cuando está trabajando**: si una respuesta tarda más de 20 segundos, el bot deja un aviso chiquito ("🤔 Pensando… · 25s") que después se convierte en la respuesta. Antes solo se veía "escribiendo…" y si se cortaba parecía que se había trabado.

---

## 1.11.0 — 2026-08-06

🎓 **Talleres privados de escuela y trabajo**

Estrenamos la categoría **Escuela/trabajo**: reacciona con 🎓 al mensaje de ChopperBot en el canal de bienvenida y se te abre un **canal privado** — solo tú y la moderación pueden verlo — con un asistente de IA completo para tu escuela o tu chamba.

### Qué puedes hacer en tu taller
- Hablarle **directo, sin mencionarlo** — funciona como los chats de IA de página web.
- Pedirle **archivos de verdad, listos para descargar**: Excel (.xlsx), Word (.docx), PowerPoint (.pptx), PDFs y gráficas.
- Que **ejecute código Python** para ti: análisis de datos, matemáticas, automatizaciones.
- **Subirle archivos** (CSV, texto, código…) para que los procese y trabaje con ellos.
- Explicaciones de temas, revisión de ensayos, preparación de exámenes, CVs…
- Todo lo que generen queda en el espacio de tu sesión y persiste entre mensajes.

### El control es tuyo
- Tu taller tiene un panel fijado con botones: 🧹 **Limpiar** (borra la conversación y empieza de cero) y 🔒 **Cerrar** (elimina el canal cuando termines). También se lo puedes pedir con palabras.
- Puedes tener hasta 2 talleres abiertos a la vez.

### Mejoras generales
- Ahora ves **qué está haciendo el bot** con emojis en tu mensaje: ⏳ en cola, 🤔 pensando, 🛠️ trabajando con herramientas, y ❌ si algo falló.
- El bot **ya no se traba cuando varias personas le escriben a la vez**: atiende en orden y le responde a todo el mundo.

---

## 1.10.2 — 2026-08-06

🗣️ **Ya no se raja con las preguntas políticas**

Hoy en el 💠Club de Cine alguien le preguntó qué hacer con quienes apoyan a China en el servidor, y ChopperBot contestó con un error en inglés ("Sorry, I hit an error…"). No fue que se negara a opinar: el filtro de contenido de la empresa que le presta el cerebro bloqueó la pregunta por considerarla "de riesgo".

- **Ahora lo reintenta y, si el filtro insiste, responde por su otro cerebro.** El bloqueo es medio azaroso — la misma pregunta pasa sin problema al segundo intento —, así que en vez de rendirse, vuelve a intentar y tiene un plan B. La respuesta sale igual, desde los principios de los Estatutos.
- **Si de plano no se puede, lo dice en español y de frente:** avisa que el filtro del proveedor bloqueó la pregunta e invita a plantearla de otra forma. Ya nunca más ese mensajote en inglés pidiendo "revisar los logs" en un canal de la comunidad.
- **Y deja de asustar a quien administra.** Ese bloqueo mandaba una alarma de "el bot está roto" al canal de configuración, cuando en realidad estaba funcionando perfecto.

---

## 1.10.1 — 2026-08-06

🎭 **Ajustes finos al asistente de la comunidad**

- **Habla más natural.** Se acabó lo de "compa esto, compa aquello" en cada respuesta.
- **Ya no manda a la banda a canales internos del staff.** Para agendar un evento siempre orienta a abrir ticket, y si preguntan dónde se vota la película del cineclub, los manda directo a 🗳️│votaciones.

---

## 1.10.0 — 2026-08-06

🧠 **ChopperBot ahora es el asistente de la comunidad en cualquier canal**

Antes, si le hablabas fuera de sus canales de chamba, solo se presentaba y te mandaba a otro lado. Ahora es un compa más: en cualquier canal donde no tenga una tarea especializada pueden hablarle de lo que sea.

- **Conoce Revolución Z.** Sabe quiénes somos, qué dicen los estatutos, cómo se organizan las comisiones y los clubs, y para qué sirve cada canal. Pregúntenle "¿cómo me uno a una comisión?", "¿dónde propongo un círculo de estudio?" o "¿qué es el FUP?" y los orienta.
- **Opina como compa, no como robot de oficina.** Habla desde los principios del colectivo que aprobamos en asamblea, con argumentos y sin tibiezas — se acabó eso de "no tengo opiniones personales". Y sí, aguanta el cotorreo.
- **Sabe qué eventos vienen.** Si le preguntan "¿qué hay esta semana?" o "¿cuándo es el club de poesía?", consulta el calendario del servidor y responde con datos reales.
- Sigue sin hacer chamba de moderación: denuncias y apelaciones van por ticket, y agendar eventos es en 🗓️│chat-gestión o por ticket. Y ya no presume funciones ajenas al servidor.

🔧 **Adiós al "I couldn't generate a response"**

Cuando le llegaban dos mensajes casi al mismo tiempo, a veces contestaba ese mensajote en inglés en vez de responder. Ahora reintenta solo y, si de plano no puede, avisa en español.

---

## 1.9.0 — 2026-08-06

🖼️ **El evento de Discord queda completo solo: con su sala y su portada**

Cuando se crea el evento de Discord (desde un ticket o desde el canal de gestión), ChopperBot ahora lo deja listo para que la gente se apunte, sin que lxs mods tengan que arreglarlo a mano:

- **Portada automática.** Si en el ticket lxs compañerxs subieron el flyer, el evento de Discord se crea con esa imagen de portada. En el canal de gestión también pueden adjuntar una imagen y decir "pon esta portada" — incluso para un evento que ya existía.
- **La sala se adivina.** Si el evento no dice dónde es, ChopperBot lo ubica por el título: "… | Club de poesía" cae en la Sala de Club de Poesía, "club de cine" en la Sala de Cineclub, y así. En los tickets ahora también pregunta una vez "¿en qué sala será?" para que quede bien enlazado.

🔄 **El evento de Discord ya no se queda viejo**

Antes, si movían la fecha o corregían el título de un evento, el evento de Discord se quedaba con los datos viejos y había que editarlo a mano. Ya no:

- **Editar el calendario actualiza el evento de Discord solo** — nueva fecha/hora, título corregido, otra sala.
- **Borrar un evento del calendario también elimina su evento de Discord**, para que nadie se apunte a algo que ya no va.

📣 **El anuncio del día ahora sale con el flyer**

El anuncio de las 10 de la mañana en 📣│anuncios ya no es solo texto con enlace: si el evento de Discord tiene portada, el anuncio la lleva adjunta, como cuando lxs admins lo anuncian a mano.

---

## 1.8.0 — 2026-08-05

📣 **ChopperBot ya avisa en anuncios cuando hay evento el mismo día**

Si hoy hay algo en el calendario, ChopperBot lo anuncia solito **a las 10 de la mañana (hora CDMX)** en 📣│anuncios, con el enlace al evento de Discord para que le puedan dar "Me interesa" de una vez.

- **Escribe el aviso como lo escribimos aquí**: cálido, con "lxs tqm" y "caiganle", diciendo claro que es **hoy** y a qué hora. No es una plantilla fría.
- **Encuentra el evento de Discord aunque tenga otro nombre.** El calendario dice "Rosario Castellanos | Club de poesía" y el evento de Discord dice "Club de Poesía: Rosario Castellanos": ChopperBot entiende que son la misma cosa y pega el enlace correcto. Si no está seguro, prefiere no poner enlace antes que mandarlos al evento equivocado.
- **Un solo aviso por evento.** Aunque se reinicie el bot o alguien registre el evento a media tarde, el anuncio sale una vez y nada más.
- **Y si falta el evento de Discord**, ChopperBot le avisa al equipo de moderación en el canal del calendario, con un día de anticipación: "falta crear el evento de Discord de esto".

🎫 **Los tickets de eventos ahora cierran el círculo completo**

- Cuando unx mod aprueba una solicitud, ChopperBot **también crea el evento de Discord** para que la gente se apunte, y deja el enlace ahí mismo en el ticket.
- **Ya puede corregir un evento que acaba de crear** (un typo en el título, cambiar la hora) sin tener que pedirle a alguien que lo haga a mano.

---

## 1.7.0 — 2026-08-04

✅ **Y cuando el evento queda aprobado, también avisa**

Complemento de la versión anterior: ahora ChopperBot etiqueta a lxs mods en los **dos** momentos que importan de una solicitud por ticket.

- **Cuando llega la solicitud** → "propuesta pendiente de su aprobación" (ya venía en la 1.6.0).
- **Cuando unx mod dice "créalo"** → ChopperBot crea el evento, sube el calendario del mes y avisa en el ticket: "✅ aprobado y agendado — ya está en el calendario". Así el resto del equipo se entera de que la solicitud se cerró, sin tener que abrir el ticket a ver qué pasó.

Ese aviso de aprobación siempre suena, aunque ya se les hubiera avisado hace un ratito en ese mismo ticket: es el desenlace que todo mundo estaba esperando y pasa una sola vez por solicitud. Fuera de esos dos momentos, ChopperBot sigue sin dar lata.

---

## 1.6.0 — 2026-08-04

🔔 **Cuando pides un evento por ticket, ahora sí les llega el aviso a lxs mods**

**1. ChopperBot etiqueta a quienes pueden aprobar.** Antes, al abrir un ticket para pedir un evento, ChopperBot armaba la propuesta y decía "lxs mods pueden aprobarla"… pero nadie recibía notificación: había que pasar por ahí de casualidad. Ahora menciona directamente a los roles que pueden crear el evento (🚓Moderación🚓 y ⭐Administrador⭐), así les llega el aviso y la solicitud no se queda esperando.

**2. También lxs llama cuando hace falta ayuda.** Si en el ticket pides apoyo con el flyer, con el horario o con cualquier cosa que dependa del equipo, ChopperBot lxs etiqueta en ese momento en lugar de preguntar al aire.

**3. Sin spam.** Solo lxs menciona cuando de verdad se necesita algo de ellxs, y no vuelve a sonarles el celular si ya lxs avisó hace ratito en ese mismo ticket.

**4. Para quienes administran el bot:** si un rol aprobador no se puede etiquetar (por la configuración del rol en Discord), ChopperBot lo dice claramente al preguntarle su estado, en vez de simular que avisó. También se puede configurar quién aprueba escribiendo el nombre del rol tal cual se lee, aunque lleve emojis.

---

## 1.5.0 — 2026-08-03

📅 **El calendario del mes se publica solito, y las series ya pueden tener fecha de término**

**1. Cada que empieza un mes, el calendario nuevo se publica solo.** Antes solo aparecía cuando algúnx mod agregaba o editaba un evento; si nadie tocaba nada, el canal se quedaba con el mes anterior — justo lo que pasó el 1 de agosto. Ahora ChopperBot nota el cambio de mes por su cuenta y sube el calendario sin que nadie se lo pida.

**2. El canal del calendario ya es un tablero al día.** Muestra el mes en curso y los meses que vienen que ya tengan eventos con fecha fija, y quita los que ya pasaron (antes se acumulaban). Si necesitas eventos de un mes pasado, el archivo `.ics` los sigue teniendo todos.

**3. Los eventos que se repiten ya pueden tener duración.** Antes una serie semanal se repetía para siempre, así que para un círculo de lectura de cuatro martes había que crear cuatro eventos aparte. Ahora se le dice cuánto dura, como se diga naturalmente:

- "*círculo de lectura todos los martes de julio a las 8*" → una sola serie, los 4 martes.
- "*taller cada jueves, son 6 sesiones*" → una sola serie, 6 sesiones.
- "*asamblea todos los sábados*" → si no dices hasta cuándo, lo pregunta una vez; si no hay fecha de término, la deja **indefinida** como siempre.

Al confirmar te dice cuántas sesiones son y cuál es la última. Una serie que ya existe también se puede ajustar después ("déjalo en 6 sesiones") o volverla indefinida.

**4. Para quienes administran el bot: ya se le puede preguntar "¿cómo vas?".** Responde con un diagnóstico completo de sí mismo en una sola respuesta: si algo falla, qué es y cómo se arregla. Antes había que preguntarle cosa por cosa, y algunos detalles no se podían consultar.

---

## 1.4.0 — 2026-07-21

🛰️ **ChopperBot aprende a vivir en AWS (modo nube nativa)**

Por dentro, ChopperBot ya puede funcionar sin llaves externas: además de su cerebro habitual (Kimi), ahora puede pensar con **Amazon Bedrock** cuando corre dentro de AWS — útil para despliegues en la nube donde no hay claves de servicios externos. Sus credenciales de AWS también se volvieron opcionales: si no hay llaves configuradas, usa la identidad del ambiente donde corre (por ejemplo, el rol de la tarea en ECS). Para los canales de siempre nada cambia: en la Raspberry Pi sigue funcionando igual.

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
