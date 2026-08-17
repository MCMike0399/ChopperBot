// Live end-to-end proof of the minutas (voice-minutes) capability.
//
//   1. Synthesizes two Spanish "speakers" (gTTS → wav → 48k PCM → Opus frames,
//      the exact shape Discord's voice receiver emits).
//   2. Proves the audio path standalone: frames → recordOpusStreamToPcm → wav
//      → whisper.cpp → the expected words come back.
//   3. Joins a REAL RevZ voice channel with the bot (joinVoiceChannel, Ready).
//   4. Injects both speeches through the capability's REAL burst pipeline
//      (manifest + recorder), plus chat comments through the chat seam.
//   5. Closes the session and runs the REAL finalize: whisper → merged draft
//      → MinIO structured upload → DeepSeek minutes → post to
//      #minutas-de-asambleas (1503986918784766072).
//   6. Asserts every artifact (DB row, MinIO keys, Discord message) and prints
//      the published minutes URL.
//
// Everything it touches is live: it spends a little DeepSeek budget and posts
// a clearly-marked PRUEBA to the real minutes channel. Run:
//   npx tsx scripts/verify-minutas.ts
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { ChannelType, Client, GatewayIntentBits, VoiceChannel } from 'discord.js';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import prism from 'prism-media';
import { config } from '../src/config.js';
import { runMigrations } from '../src/memory/migrations.js';
import { SqliteMemoryStore } from '../src/memory/store.js';
import { createObjectStorage } from '../src/storage/index.js';
import { MINUTAS_MIGRATIONS, MinutasStore } from '../src/capabilities/minutas/store.js';
import { MinutasSessions } from '../src/capabilities/minutas/session.js';
import { WhisperCliTranscriber } from '../src/capabilities/minutas/transcriber.js';
import { finalizeSession, type FinalizeDeps } from '../src/capabilities/minutas/pipeline.js';
import { recordOpusStreamToPcm, pcmToWav } from '../src/capabilities/minutas/audio.js';

const execFileAsync = promisify(execFile);

const REVZ_GUILD_ID = '1435843683541979248';
/** "🖥️ Sala de echar desmadre" — casual voice channel; the right place for a test. */
const VOICE_CHANNEL_ID = '1440131304397213838';
const MINUTAS_CHANNEL_ID = '1503986918784766072';

const FIXTURE_DIR = join(tmpdir(), 'minutas-e2e');
const VENV_PYTHON = resolve('data/minutas/tools/venv/bin/python3');

const SPEAKERS = [
  {
    userId: 'e2e-voz-1',
    name: 'Voz Uno (prueba)',
    tld: 'com.mx',
    text: 'Abrimos la asamblea de hoy. El primer punto del orden del día es la organización del foro de octubre: propongo que sea el sábado dieciocho en el salón de eventos y que Carla confirme el sonido.',
  },
  {
    userId: 'e2e-voz-2',
    name: 'Voz Dos (prueba)',
    tld: 'es',
    text: 'De acuerdo con la propuesta. Además propongo destinar quinientos pesos del presupuesto a la impresión de volantes, y que la compañera Ana prepare la minuta para publicarla en el canal.',
  },
];

const CHAT_LINES = [
  { userId: 'e2e-voz-3', author: 'Carla (chat prueba)', content: 'yo confirmo el sonido el viernes 👍' },
  { userId: 'e2e-voz-3', author: 'Carla (chat prueba)', content: 'y yo apoyo lo de los volantes' },
];

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function ttsToWav(text: string, tld: string, outWav: string): Promise<void> {
  const mp3 = outWav.replace(/\.wav$/, '.mp3');
  await execFileAsync(VENV_PYTHON, [
    '-c',
    `import sys; from gtts import gTTS; gTTS(text=sys.argv[1], lang='es', tld=sys.argv[2]).save(sys.argv[3])`,
    text,
    tld,
    mp3,
  ]);
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', mp3, '-ar', '16000', '-ac', '1', outWav,
  ]);
}

async function wavToOpusFrames(wavPath: string): Promise<Buffer[]> {
  const pcmPath = wavPath.replace(/\.wav$/, '.48k.pcm');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', wavPath, '-ar', '48000', '-ac', '2', '-f', 's16le', pcmPath,
  ]);
  const pcm = await readFile(pcmPath);
  const encoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  const frames: Buffer[] = [];
  await new Promise<void>((resolvePromise, rejectPromise) => {
    encoder.on('data', (frame: Buffer) => frames.push(frame));
    encoder.on('end', () => resolvePromise());
    encoder.on('error', rejectPromise);
    encoder.end(pcm);
  });
  return frames;
}

async function main(): Promise<void> {
  console.log('— minutas e2e — preparando fixtures de voz (gTTS + ffmpeg + opus)…');
  await mkdir(FIXTURE_DIR, { recursive: true });
  const fixtures: Array<{ speaker: (typeof SPEAKERS)[number]; frames: Buffer[]; seconds: number }> = [];
  for (const [i, speaker] of SPEAKERS.entries()) {
    const wav = join(FIXTURE_DIR, `voz${i + 1}.wav`);
    await ttsToWav(speaker.text, speaker.tld, wav);
    const frames = await wavToOpusFrames(wav);
    fixtures.push({ speaker, frames, seconds: (frames.length * 960) / 48000 });
  }
  check('fixtures TTS generados', fixtures.every((f) => f.frames.length > 100));

  // ── Step 1: audio path proof (opus frames → PCM → wav → whisper) ─────────
  console.log('— probando la ruta de audio: tramas opus → PCM → whisper.cpp…');
  const transcriber = new WhisperCliTranscriber({
    bin: resolve(config.MINUTAS_WHISPER_BIN),
    modelPath: resolve(config.MINUTAS_WHISPER_MODEL_PATH),
    language: config.MINUTAS_WHISPER_LANGUAGE,
    threads: config.MINUTAS_WHISPER_THREADS,
  });
  check('whisper-cli + modelo disponibles', transcriber.isAvailable());

  const proofPcm = join(FIXTURE_DIR, 'proof.pcm');
  await recordOpusStreamToPcm(Readable.from(fixtures[0]!.frames), proofPcm);
  const proofWav = join(FIXTURE_DIR, 'proof.wav');
  await pcmToWav(proofPcm, proofWav);
  const proofSegments = await transcriber.transcribe(proofWav, join(FIXTURE_DIR, 'proof'));
  const proofText = proofSegments.map((s) => s.text).join(' ').toLowerCase();
  check(
    'opus→PCM→whisper transcribe palabras esperadas',
    proofText.includes('asamblea') && proofText.includes('foro'),
    proofText.slice(0, 110),
  );

  // ── Step 2: live Discord session ──────────────────────────────────────────
  console.log('— conectando a Discord y abriendo sesión de voz real…');
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
    ],
  });
  await client.login(config.DISCORD_TOKEN);
  await new Promise<void>((r) => (client.isReady() ? r() : client.once('ready', () => r())));

  const guild = await client.guilds.fetch(REVZ_GUILD_ID);
  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    throw new Error(`Canal de voz ${VOICE_CHANNEL_ID} no encontrado`);
  }

  const mem = new SqliteMemoryStore({ path: resolve(config.CHOPPERBOT_DATA_DIR, 'chopperbot.db') });
  runMigrations(mem.db(), 'minutas', MINUTAS_MIGRATIONS);
  const store = new MinutasStore(mem.db());
  store.seedOutputChannelId(config.MINUTAS_OUTPUT_CHANNEL_ID);
  check('canal de minutas configurado', store.getOutputChannelId() === MINUTAS_CHANNEL_ID, store.getOutputChannelId() ?? 'unset');

  const storage = createObjectStorage();
  const storageReady = storage ? await storage.ensureReady() : false;
  check('MinIO accesible', storageReady, storage?.backend ?? 'disabled');
  if (!storage) throw new Error('MinIO no configurado — la prueba exige el almacenamiento real');

  const sessionsDir = resolve(config.CHOPPERBOT_DATA_DIR, 'minutas', 'sessions');
  let finalizePromise: Promise<import('../src/capabilities/minutas/pipeline.js').FinalizeResult> | null = null;
  const sessions = new MinutasSessions({
    store,
    sessionsDir,
    onClosed: (closed) => {
      const deps: FinalizeDeps = { store, storage, transcriber, sessionsDir, client };
      finalizePromise = finalizeSession(deps, closed.row.id);
      finalizePromise.catch((err) => console.error('finalize failed:', err));
    },
  });

  const row = await sessions.start({
    guild,
    channel: channel as VoiceChannel,
    startedBy: { id: client.user!.id, tag: client.user!.tag },
    title: 'PRUEBA e2e del sistema de minutas',
  });
  check('sesión abierta y conexión de voz Ready', sessions.getActive(REVZ_GUILD_ID)?.id === row.id, row.id);

  // Burst 1, then chat 1, then burst 2, then chat 2 — in real time so the
  // merged timeline is coherent.
  console.log(`— inyectando voz 1 (${fixtures[0]!.seconds.toFixed(1)}s de audio)…`);
  const injected1 = sessions.injectTestAudioStream(
    REVZ_GUILD_ID,
    fixtures[0]!.speaker.userId,
    fixtures[0]!.speaker.name,
    Readable.from(fixtures[0]!.frames),
  );
  check('burst 1 aceptado por el pipeline', injected1);
  await new Promise((r) => setTimeout(r, Math.ceil(fixtures[0]!.seconds * 1000) + 800));
  sessions.recordChatLine(REVZ_GUILD_ID, CHAT_LINES[0]!);

  console.log(`— inyectando voz 2 (${fixtures[1]!.seconds.toFixed(1)}s de audio)…`);
  const injected2 = sessions.injectTestAudioStream(
    REVZ_GUILD_ID,
    fixtures[1]!.speaker.userId,
    fixtures[1]!.speaker.name,
    Readable.from(fixtures[1]!.frames),
  );
  check('burst 2 aceptado por el pipeline', injected2);
  await new Promise((r) => setTimeout(r, Math.ceil(fixtures[1]!.seconds * 1000) + 800));
  sessions.recordChatLine(REVZ_GUILD_ID, CHAT_LINES[1]!);

  console.log('— cerrando la sesión y corriendo finalize REAL (whisper + DeepSeek + MinIO + Discord)…');
  const closed = await sessions.endAndReport(REVZ_GUILD_ID, 'prueba e2e');
  check('sesión cerrada y entregada al finalizador', closed !== null);
  if (!finalizePromise) throw new Error('onClosed no disparó finalizeSession');
  const result = await finalizePromise;

  // ── Step 3: assertions ────────────────────────────────────────────────────
  const done = store.getSession(row.id)!;
  check('DB: sesión done', done.status === 'done', done.status);
  check('DB: minio_prefix estructurado', /^minutas\/\d+\/\d{4}-\d{2}-\d{2}\/.+\/$/.test(done.minio_prefix ?? ''), done.minio_prefix ?? 'unset');
  check('DB: summary_message_id registrado', !!done.summary_message_id, done.summary_message_id ?? 'unset');

  const s3 = new S3Client({
    endpoint: config.MINIO_ENDPOINT,
    region: config.MINIO_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: config.MINIO_ACCESS_KEY!, secretAccessKey: config.MINIO_SECRET_KEY! },
  });
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: config.MINIO_BUCKET, Prefix: done.minio_prefix! }),
  );
  const keys = (listed.Contents ?? []).map((o) => o.Key!.replace(done.minio_prefix!, '')).sort();
  console.log('   MinIO keys:', keys.join(', '));
  for (const expected of [
    'session.json',
    'bursts.jsonl',
    'chat.jsonl',
    'draft.md',
    'transcript.jsonl',
    'minuta.md',
  ]) {
    check(`MinIO contiene ${expected}`, keys.includes(expected));
  }
  check('MinIO contiene 2 WAV de audio', keys.filter((k) => k.startsWith('audio/') && k.endsWith('.wav')).length === 2);
  check('MinIO contiene 2 JSON crudos de whisper', keys.filter((k) => k.startsWith('transcript/') && k.endsWith('.json')).length === 2);

  const draftObj = await storage.get(`${done.minio_prefix}draft.md`);
  const draftText = draftObj ? Buffer.from(draftObj).toString('utf8') : '';
  check(
    'borrador distingue a les dos hablantes',
    draftText.includes('Voz Uno (prueba)') && draftText.includes('Voz Dos (prueba)'),
  );
  check('borrador incluye los comentarios del chat', (draftText.match(/💬/g) ?? []).length === 2);
  check(
    'borrador transcribe contenido esperado',
    draftText.toLowerCase().includes('foro') && draftText.toLowerCase().includes('asamblea'),
  );

  const minutaObj = await storage.get(`${done.minio_prefix}minuta.md`);
  const minutaText = minutaObj ? Buffer.from(minutaObj).toString('utf8') : '';
  check('minuta.md tiene estructura de acta', minutaText.includes('## Resumen') && minutaText.includes('## Acuerdos'));

  const posted = await (await client.channels.fetch(MINUTAS_CHANNEL_ID).then((c) => (c as { isTextBased(): boolean; messages: { fetch(id: string): Promise<{ content: string; url: string }> } }).messages.fetch(done.summary_message_id!)));
  check(
    'mensaje publicado en #minutas-de-asambleas con encabezado',
    posted.content.includes('# 📜 Minuta') && posted.content.includes('PRUEBA e2e'),
  );
  console.log(`\n🔗 Minuta publicada: ${posted.url}`);
  console.log(`📦 Borradores en MinIO: ${config.MINIO_BUCKET}/${done.minio_prefix}`);
  console.log(`⏱️  Resultado finalize: empty=${result.empty}`);

  const localDir = join(sessionsDir, row.id);
  check('directorio local limpiado tras subida completa', !existsSync(localDir));

  await client.destroy();
  mem.close();
  if (failures > 0) {
    console.error(`\n❌ ${failures} comprobaciones fallaron`);
    process.exit(1);
  }
  console.log('\n✅ E2E MINUTAS: TODAS LAS COMPROBACIONES PASARON');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
