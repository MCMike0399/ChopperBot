// Pre-populate env so `src/config.ts` (which validates at module load) is happy
// in tests. Using `??=` so a real value (e.g. CI-provided) takes precedence.
// DISCORD_CHANNEL_ID is optional now (tests may use DISCORD_AUTHORIZED_CHANNELS instead).
process.env.DISCORD_TOKEN ??= "test-discord-token";
process.env.DISCORD_CHANNEL_ID ??= "12345678901234567890";
process.env.CHOPPERBOT_CONFIG_CHANNEL_ID ??= "12345678901234567899";
// DeepSeek is the ONLY brain since the 2026-09-14 v4.1 migration (text AND
// images), so its key is unconditionally required — there is no second backend
// to fall back to. `src/config.ts` exits the process without it.
process.env.DEEPSEEK_API_KEY ??= "sk-deepseek-test";
process.env.MAX_TOOL_ITERATIONS ??= "5";
process.env.LOG_LEVEL ??= "fatal";
process.env.MAX_ATTACHMENT_BYTES ??= "10485760";
process.env.MAX_ATTACHMENT_COUNT ??= "5";
