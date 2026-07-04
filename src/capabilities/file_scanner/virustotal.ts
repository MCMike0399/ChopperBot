import type { Verdict, VerdictStats } from './store.js';

const VT_BASE = 'https://www.virustotal.com/api/v3';
const HTTP_TIMEOUT_MS = 30_000;

/** Raw VirusTotal analysis-stats block (also `last_analysis_stats` on a file). */
interface RawStats {
  harmless?: number;
  malicious?: number;
  suspicious?: number;
  undetected?: number;
  timeout?: number;
  'confirmed-timeout'?: number;
  failure?: number;
  'type-unsupported'?: number;
}

export type AnalysisStatus = 'queued' | 'in-progress' | 'completed';

export interface AnalysisResult {
  status: AnalysisStatus;
  /** Present once status === 'completed' (may be partial while running). */
  stats: VerdictStats | null;
}

/** Thrown when VirusTotal rejects the API key (401/403). Deterministic — pages the operator. */
export class VirusTotalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VirusTotalAuthError';
  }
}

/** Thrown when VirusTotal itself throttles us (429) despite our own spacing. */
export class VirusTotalRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VirusTotalRateLimitError';
  }
}

/**
 * Thin VirusTotal v3 client. Pure HTTP — knows nothing about rate limiting or
 * budgets; the caller (scanner.ts) funnels every method through the
 * {@link ScanRateLimiter} so spacing + the daily budget are enforced in one
 * place. This keeps the client trivially mockable in unit tests.
 */
export class VirusTotalClient {
  constructor(private readonly apiKey: string) {}

  /**
   * Look a file up by its SHA-256 without uploading. Returns its stats if
   * VirusTotal already knows the file (the common case → instant verdict), or
   * null on a 404 (unknown file, must be uploaded).
   */
  async lookupByHash(sha256: string): Promise<VerdictStats | null> {
    const res = await this.request('GET', `/files/${sha256}`);
    if (res.status === 404) return null;
    const body = await this.parseOk(res, 'lookupByHash');
    const raw = body?.data?.attributes?.last_analysis_stats as RawStats | undefined;
    return raw ? toStats(raw) : null;
  }

  /**
   * Upload a file for scanning. Returns the analysis id to poll with
   * {@link getAnalysis}. Uses the simple /files endpoint (public-API upload
   * cap ~32 MB; the caller rejects larger files before reaching here).
   */
  async uploadFile(bytes: Uint8Array, fileName: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([toArrayBuffer(bytes)]), fileName || 'upload.bin');
    const res = await this.request('POST', '/files', form);
    const body = await this.parseOk(res, 'uploadFile');
    const id = body?.data?.id;
    if (typeof id !== 'string') {
      throw new Error(`VirusTotal upload returned no analysis id: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return id;
  }

  /** Fetch the status + stats of an ongoing/finished analysis. */
  async getAnalysis(analysisId: string): Promise<AnalysisResult> {
    const res = await this.request('GET', `/analyses/${analysisId}`);
    const body = await this.parseOk(res, 'getAnalysis');
    const attrs = body?.data?.attributes ?? {};
    const status = (attrs.status as AnalysisStatus) ?? 'queued';
    const raw = attrs.stats as RawStats | undefined;
    return {
      status,
      stats: status === 'completed' && raw ? toStats(raw) : null,
    };
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: FormData,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(`${VT_BASE}${path}`, {
        method,
        headers: { 'x-apikey': this.apiKey, accept: 'application/json' },
        body,
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new VirusTotalAuthError(`VirusTotal rejected the API key (HTTP ${res.status})`);
      }
      if (res.status === 429) {
        throw new VirusTotalRateLimitError('VirusTotal rate limit hit (HTTP 429)');
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Assert 2xx and JSON-parse, else throw with a truncated body for context. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async parseOk(res: Response, op: string): Promise<any> {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`VirusTotal ${op} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }
}

/** Normalize raw VT stats into our tidy {@link VerdictStats}. */
export function toStats(raw: RawStats): VerdictStats {
  const malicious = raw.malicious ?? 0;
  const suspicious = raw.suspicious ?? 0;
  const harmless = raw.harmless ?? 0;
  const undetected = raw.undetected ?? 0;
  return { malicious, suspicious, harmless, undetected, total: malicious + suspicious + harmless + undetected };
}

/**
 * Map engine counts to a verdict. `malicious >= threshold` → malicious;
 * any malicious/suspicious detection below that → suspicious; otherwise clean.
 */
export function verdictFrom(stats: VerdictStats, maliciousThreshold: number): Verdict {
  if (stats.malicious >= maliciousThreshold) return 'malicious';
  if (stats.malicious > 0 || stats.suspicious > 0) return 'suspicious';
  return 'clean';
}

/** Copy into a fresh ArrayBuffer so Blob gets a plain ArrayBuffer (not a view). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}
