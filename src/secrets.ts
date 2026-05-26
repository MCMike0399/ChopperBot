import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * If SECRETS_MANAGER_ID is set, fetch the JSON secret and merge its keys into
 * process.env (without overriding values already explicitly set in the env).
 * Must run before ./config.js is imported, since config validates at load.
 */
export async function hydrateFromSecretsManager(): Promise<void> {
  const id = process.env.SECRETS_MANAGER_ID;
  if (!id) return;

  const region = process.env.AWS_REGION ?? 'us-east-1';
  const client = new SecretsManagerClient({ region });
  const res = await client.send(new GetSecretValueCommand({ SecretId: id }));
  if (!res.SecretString) {
    throw new Error(`Secret ${id} has no SecretString`);
  }

  const parsed = JSON.parse(res.SecretString) as Record<string, string>;
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined || process.env[k] === '') {
      process.env[k] = v;
    }
  }
}
