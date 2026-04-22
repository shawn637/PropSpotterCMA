/**
 * Thin HTTP client for the Apify REST API. Covers the three calls we
 * need: start a run, poll its status, fetch the dataset items. Read-only
 * aside from starting runs.
 *
 * All requests are authenticated with APIFY_API_TOKEN via the
 * Authorization header. Token is never logged.
 *
 * Spec:
 *   POST  https://api.apify.com/v2/acts/{actorId}/runs      — start
 *   GET   https://api.apify.com/v2/actor-runs/{runId}       — poll
 *   GET   https://api.apify.com/v2/datasets/{datasetId}/items?format=json&clean=true
 */

const APIFY_BASE = 'https://api.apify.com/v2';
const FETCH_TIMEOUT_MS = 15_000;

export type ApifyRunStatus =
  | 'READY'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMING-OUT'
  | 'TIMED-OUT'
  | 'ABORTING'
  | 'ABORTED';

export interface ApifyStartRunResult {
  runId: string;
  datasetId: string;
  status: ApifyRunStatus;
}

export interface ApifyRunSnapshot {
  runId: string;
  datasetId: string;
  status: ApifyRunStatus;
  /** True when the run has terminated in any state (success or failure). */
  finished: boolean;
  /** True when the run finished successfully and its dataset is safe to fetch. */
  succeeded: boolean;
}

export class ApifyError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApifyError';
  }
}

function token(): string {
  const t = process.env.APIFY_API_TOKEN;
  if (!t) {
    throw new ApifyError('APIFY_API_TOKEN not set', '(config)');
  }
  return t;
}

function actorId(): string {
  return process.env.APIFY_ACTOR_ID ?? 'B6a0UcnIyffP49AmN';
}

async function apifyFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${APIFY_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    throw new ApifyError(
      `Apify ${init.method ?? 'GET'} ${path} network error: ${
        err instanceof Error ? err.message : String(err)
      }`,
      path,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApifyError(
      `Apify ${init.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText}${
        body ? ` — ${body.slice(0, 200)}` : ''
      }`,
      path,
      res.status,
    );
  }
  return (await res.json()) as T;
}

/**
 * Kick off a new actor run with the given input body. Input shape:
 *   { maxPagesToScrape: number, startUrl: string }
 * Returns immediately with the runId and defaultDatasetId — the caller
 * polls getRunStatus to know when the dataset is ready.
 */
export async function startRun(input: {
  maxPagesToScrape: number;
  startUrl: string;
}): Promise<ApifyStartRunResult> {
  const path = `/acts/${actorId()}/runs`;
  const response = await apifyFetch<{
    data: {
      id: string;
      status: ApifyRunStatus;
      defaultDatasetId: string;
    };
  }>(path, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return {
    runId: response.data.id,
    datasetId: response.data.defaultDatasetId,
    status: response.data.status,
  };
}

export async function getRunStatus(
  runId: string,
): Promise<ApifyRunSnapshot> {
  const path = `/actor-runs/${encodeURIComponent(runId)}`;
  const response = await apifyFetch<{
    data: {
      id: string;
      status: ApifyRunStatus;
      defaultDatasetId: string;
    };
  }>(path);
  const status = response.data.status;
  const finished =
    status === 'SUCCEEDED' ||
    status === 'FAILED' ||
    status === 'TIMED-OUT' ||
    status === 'ABORTED';
  return {
    runId: response.data.id,
    datasetId: response.data.defaultDatasetId,
    status,
    finished,
    succeeded: status === 'SUCCEEDED',
  };
}

/**
 * Fetch the dataset items after a run completes successfully. Cleaned
 * items (empty fields removed) via `clean=true`. No pagination since a
 * single-page REA sold search yields at most ~25 listings, well inside
 * Apify's default 1000-item page.
 */
export async function getDatasetItems<T = unknown>(
  datasetId: string,
): Promise<T[]> {
  const path = `/datasets/${encodeURIComponent(datasetId)}/items?format=json&clean=true`;
  const response = await apifyFetch<T[]>(path);
  if (!Array.isArray(response)) {
    throw new ApifyError(
      `Apify dataset ${datasetId} did not return an array`,
      path,
    );
  }
  return response;
}
