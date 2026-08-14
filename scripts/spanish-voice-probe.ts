/**
 * Live probe of the Spanish voice contract: real prompts, real text backend,
 * real agent loop — then `lintSpanish` on whatever comes back.
 *
 *   npx tsx scripts/spanish-voice-probe.ts            # current .env backend
 *   LLM_TEXT_BACKEND=kimi npx tsx scripts/spanish-voice-probe.ts
 *
 * Spends real tokens (a handful of turns). Posts nothing to Discord and touches
 * no production SQLite — every scene gets a fresh `:memory:` store.
 *
 * The scenes are not invented. Scene 1 replays, verbatim, the two messages that
 * produced the reply the community flagged on 2026-08-13 (message
 * 1537630365106315406: "se le habla como en una conversación normal … le
 * pregunto UNA cosa a la vez … ¿Se lo resumo … para elx?"). Scene 2 is the same
 * trap from the other side — a member writing in formal Spanish, which is what
 * pulls a model into usted. Scene 3 is the ordinary 94% case.
 *
 * Read the replies, don't just read the verdict: the linter grades the defects
 * we have seen, not taste.
 */
import 'dotenv/config';
import { textBackend } from '../src/config.js';
import { SqliteMemoryStore, NamespacedMemory } from '../src/memory/store.js';
import { CalendarCapability } from '../src/capabilities/calendar/capability.js';
import { ask } from '../src/llm/client.js';
import { lintSpanish, describeFindings } from '../src/lang/spanish-style.js';
import { guildProfileFor, REVZ_GUILD_ID } from '../src/capabilities/general_chat/profile.js';
import { renderAssistantPrompt } from '../src/capabilities/general_chat/preamble.js';
import type { Turn } from '../src/discord/history.js';
import type { ComposedTools } from '../src/tools/source.js';

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RST = '\x1b[0m';
const NOW = new Date('2026-08-14T01:00:00.000Z'); // Wed 2026-08-13 19:00 CDMX

const NO_TOOLS: ComposedTools = { tools: [], handle: async () => ({ status: 'error', payload: 'no tools' }) };

/** The calendar capability's real mod bundle, on an empty in-memory calendar. */
async function calendarBundle() {
  const memory = new SqliteMemoryStore({ path: ':memory:' });
  const cap = new CalendarCapability();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await cap.init({ memory: new NamespacedMemory(memory, cap.id), projectRoot: '.' } as any);
  const bundle = await cap.buildTurn({
    channelId: 'C', guildId: 'G', userId: 'U', userTag: 'mod', now: NOW,
    isAdministrator: true,
  });
  return { bundle, memory };
}

interface Scene {
  name: string;
  why: string;
  run(): Promise<string>;
}

const scenes: Scene[] = [
  {
    name: 'calendar · "explícale a otra persona cómo crear eventos"',
    why: 'the exact turn that shipped "se le habla … UNA cosa a la vez … para elx"',
    async run() {
      const { bundle, memory } = await calendarBundle();
      const messages: Turn[] = [
        { role: 'user', content: 'explicale a <@544704579577839616> cómo ser de la comisión de gestión de eventos' },
        { role: 'assistant', content: 'En la Revolución Z las comisiones se proponen y se arman en la asamblea. Que lo plantee ahí y lxs mods lo acomodan.' },
        { role: 'user', content: 'pero cómo debe hablarte para crear los eventos, por ejemplo' },
      ];
      try {
        return await ask({ system: bundle.system, messages, tools: bundle.tools, effort: bundle.effort });
      } finally {
        memory.close();
      }
    },
  },
  {
    name: 'calendar · a member writing in formal Spanish',
    why: 'models mirror register; this is what pulls a reply into usted',
    async run() {
      const { bundle, memory } = await calendarBundle();
      const messages: Turn[] = [
        {
          role: 'user',
          content:
            'Buenas tardes. Quisiera solicitarle información sobre el procedimiento para registrar un evento en el calendario, por favor. Le agradezco de antemano su amable atención.',
        },
      ];
      try {
        return await ask({ system: bundle.system, messages, tools: bundle.tools, effort: bundle.effort });
      } finally {
        memory.close();
      }
    },
  },
  {
    name: 'general_chat · the ordinary case',
    why: '94% of real turns: a plain question in an unbound channel',
    async run() {
      const profile = guildProfileFor(REVZ_GUILD_ID)!;
      const system = renderAssistantPrompt(profile, NOW, [], 'general');
      // `medium` = thinking off, the tier handlers.ts applies to general_chat.
      return ask({
        system,
        messages: [{ role: 'user', content: '¿de qué va este servidor y qué puedo hacer aquí?' }],
        tools: NO_TOOLS,
        effort: 'medium',
      });
    },
  },
];

async function main(): Promise<void> {
  console.log(`\n${BOLD}Spanish voice probe${RST} — backend ${BOLD}${textBackend.provider}${RST} · model ${textBackend.modelId}\n`);
  let dirty = 0;

  for (const scene of scenes) {
    console.log(`${BOLD}▸ ${scene.name}${RST}\n${DIM}  ${scene.why}${RST}`);
    let reply: string;
    try {
      reply = await scene.run();
    } catch (e) {
      console.log(`  ${RED}[ERR ${(e as Error).message.slice(0, 120)}]${RST}\n`);
      dirty++;
      continue;
    }
    console.log(`${DIM}${reply.split('\n').map((l) => `  │ ${l}`).join('\n')}${RST}`);
    const findings = lintSpanish(reply);
    if (findings.length === 0) {
      console.log(`  ${GREEN}✓ clean${RST}\n`);
    } else {
      dirty++;
      console.log(`  ${RED}✗ ${describeFindings(findings)}${RST}`);
      for (const f of findings) console.log(`${DIM}      ${f.rule}: ${f.why}${RST}`);
      console.log('');
    }
  }

  console.log(
    dirty === 0
      ? `${GREEN}All scenes in voice.${RST} ${DIM}Read the replies anyway — the linter grades known defects, not taste.${RST}\n`
      : `${RED}${dirty} scene(s) off-voice.${RST} ${DIM}Tighten src/lang/voice.ts (it rides every prompt) and re-run.${RST}\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
