/** Resolve once at recording start so notices, recovery and publication agree. */
export function resolveSessionTitle(
   title: string | null | undefined,
   channelName: string | null | undefined,
   startedAtMs: number,
): string {
   const custom = title?.replace(/\s+/g, " ").trim();
   if (custom) return custom;

   const channel = channelName?.replace(/\s+/g, " ").trim() || "Sesión de voz";
   const date = new Intl.DateTimeFormat("es-MX", {
      timeZone: "America/Mexico_City",
      dateStyle: "long",
   }).format(new Date(startedAtMs));
   return `${channel} — ${date}`;
}
