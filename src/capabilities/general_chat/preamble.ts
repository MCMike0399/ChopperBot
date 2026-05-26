export interface CapabilityBindingSnapshot {
  channelId: string;
  channelName: string | null;
  guildId: string | null;
  guildName: string | null;
  url: string | null;
}

export interface CapabilitySnapshotEntry {
  id: string;
  description: string;
  bindings: CapabilityBindingSnapshot[];
}

export function renderGeneralChatPrompt(now: Date, snapshot: CapabilitySnapshotEntry[]): string {
  const capabilitiesBlock = snapshot.length === 0
    ? '- (No hay otras capacidades registradas todavía.)'
    : snapshot.map(renderCapabilityEntry).join('\n');

  return `Eres **ChopperBot** en **modo chat general** — la conversación base del bot. Aquí no ejecutas acciones especializadas; te presentas, orientas, y rediriges al usuario al canal correcto cuando pide algo que vive en otra capacidad.

# Hora actual
- UTC: ${now.toISOString()}

# Capacidades disponibles
${capabilitiesBlock}

# Reglas
- Si el usuario pide algo que pertenece a otra capacidad (agendar eventos, monitorear Instagram, etc.), **no intentes hacerlo aquí**. Explícale brevemente qué hace esa capacidad y dale el enlace al canal correcto.
- Si una capacidad aparece como "sin canal asignado", dile al usuario que un admin debe bindearla desde el canal de configuración.
- Si todos los canales de una capacidad aparecen como "canal no accesible", **no inventes nombres** — sugiérele al usuario contactar a un admin.
- No inventes capacidades que no aparezcan en la lista de arriba.
- Respuestas cortas (1–4 oraciones). Espeja el idioma del usuario (español/inglés).
- Cierra con afirmaciones, no con "¿algo más?" ni invitaciones a continuar.`;
}

function renderCapabilityEntry(entry: CapabilitySnapshotEntry): string {
  if (entry.bindings.length === 0) {
    return `- **${entry.id}** — ${entry.description}. (sin canal asignado todavía — un admin debe bindearlo desde el canal de configuración)`;
  }
  if (entry.bindings.length === 1) {
    return `- **${entry.id}** — ${entry.description}. ${renderBinding(entry.bindings[0])}`;
  }
  const head = `- **${entry.id}** — ${entry.description}.`;
  const lines = entry.bindings.map((b) => `  - ${renderBinding(b)}`);
  return [head, ...lines].join('\n');
}

function renderBinding(b: CapabilityBindingSnapshot): string {
  if (b.url && b.channelName) {
    const guildLabel = b.guildName ? ` (${b.guildName})` : '';
    return `Vive en #${b.channelName}${guildLabel}: ${b.url}`;
  }
  return `(canal no accesible, id: ${b.channelId})`;
}
