import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

/**
 * Thin wrapper around AWS Lambda's Invoke API for the Instagram relay. The
 * Lambda accepts `{ username }` and returns `{ statusCode, body }` where body
 * is the raw response text from the IG `web_profile_info` endpoint.
 */
export interface LambdaRelayResponse {
  statusCode: number;
  body: string;
  /** Lambda sets this when it detects a session-expired / login-required signal. */
  authError?: boolean;
}

/** Thrown when the relay reports IG session-expired. Surfaced to logs so an
 *  operator knows to re-run scripts/ig-login.sh. */
export class IgAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IgAuthError';
  }
}

export interface LambdaRelay {
  fetchWebProfile(username: string): Promise<LambdaRelayResponse>;
}

export class AwsLambdaRelay implements LambdaRelay {
  private readonly client: LambdaClient;

  constructor(
    private readonly functionArn: string,
    region: string,
  ) {
    this.client = new LambdaClient({ region });
  }

  async fetchWebProfile(username: string): Promise<LambdaRelayResponse> {
    const cmd = new InvokeCommand({
      FunctionName: this.functionArn,
      InvocationType: 'RequestResponse',
      Payload: new TextEncoder().encode(JSON.stringify({ username })),
    });
    const res = await this.client.send(cmd);
    if (res.FunctionError) {
      throw new Error(`Lambda function error (${res.FunctionError}): ${decode(res.Payload)}`);
    }
    const raw = decode(res.Payload);
    if (!raw) throw new Error('Lambda returned empty payload');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Lambda payload was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { statusCode?: unknown }).statusCode !== 'number' ||
      typeof (parsed as { body?: unknown }).body !== 'string'
    ) {
      throw new Error(`Lambda payload missing { statusCode, body }: ${raw.slice(0, 200)}`);
    }
    const resp = parsed as LambdaRelayResponse;
    if (resp.authError) {
      throw new IgAuthError(
        `Instagram session expired or challenge required (HTTP ${resp.statusCode}). ` +
          `Re-run scripts/ig-login.sh to refresh cookies in Secrets Manager, then re-deploy the Lambda.`,
      );
    }
    return resp;
  }
}

function decode(payload: Uint8Array | undefined): string {
  if (!payload) return '';
  return new TextDecoder().decode(payload);
}
