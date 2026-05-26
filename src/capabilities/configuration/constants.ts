export const CONFIGURATION_CAPABILITY_ID = 'configuration';

/**
 * The single hardcoded channel that runs the configuration capability. Every
 * other channel→capability binding lives in SQLite and is managed from chat.
 *
 * REQUIRED env var (no default) — set CHOPPERBOT_CONFIG_CHANNEL_ID to the
 * snowflake of the Discord channel you want to designate as your admin
 * console. The bot fails to boot if this is unset.
 */
function requireConfigChannel(): string {
  const id = process.env.CHOPPERBOT_CONFIG_CHANNEL_ID;
  if (!id || !/^\d{17,20}$/.test(id)) {
    throw new Error(
      'CHOPPERBOT_CONFIG_CHANNEL_ID env var is required — set it to the ' +
        'Discord snowflake (17–20 digits) of the channel that should run the ' +
        'configuration capability.',
    );
  }
  return id;
}

export const CONFIGURATION_CHANNEL_ID = requireConfigChannel();
