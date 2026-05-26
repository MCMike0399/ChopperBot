// Pre-populate env so `src/config.ts` (which validates at module load) is happy
// in tests. Using `??=` so a real value (e.g. CI-provided) takes precedence.
// DISCORD_CHANNEL_ID is optional now (tests may use DISCORD_AUTHORIZED_CHANNELS instead).
process.env.DISCORD_TOKEN ??= 'test-discord-token';
process.env.DISCORD_CHANNEL_ID ??= '12345678901234567890';
process.env.CHOPPERBOT_CONFIG_CHANNEL_ID ??= '12345678901234567899';
process.env.AWS_REGION ??= 'us-east-1';
process.env.KIMI_API_KEY ??= 'test-kimi-api-key';
process.env.KIMI_BASE_URL ??= 'https://api.kimi.com/coding/v1';
process.env.KIMI_MODEL_ID ??= 'test-model';
process.env.MAX_OUTPUT_TOKENS ??= '4096';
process.env.MAX_TOOL_ITERATIONS ??= '5';
process.env.LOG_LEVEL ??= 'fatal';
process.env.MAX_ATTACHMENT_BYTES ??= '10485760';
process.env.MAX_ATTACHMENT_COUNT ??= '5';
