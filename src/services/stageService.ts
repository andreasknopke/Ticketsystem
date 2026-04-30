export type StageId = string | number;

export interface StageRecord {
  id: StageId;
  status?: string;
  name?: string;
  title?: string;
  error?: string;
  retryAttempts?: number;
  retry_count?: number;
  [key: string]: unknown;
}

export interface StageRetryResponse {
  stage?: StageRecord;
  status?: string;
  message?: string;
  [key: string]: unknown;
}

export interface RetryStageOptions {
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export class StageServiceError extends Error {
  status?: number;
  details?: unknown;

  constructor(message: string, status?: number, details?: unknown) {
    super(message);
    this.name = 'StageServiceError';
    this.status = status;
    this.details = details;
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const bodyText = await response.text();

  if (!bodyText) {
    return undefined;
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return bodyText;
  }
}

function getErrorMessage(details: unknown, fallback: string): string {
  if (details && typeof details === 'object') {
    const record = details as Record<string, unknown>;

    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message;
    }

    if (typeof record.error === 'string' && record.error.trim()) {
      return record.error;
    }
  }

  if (typeof details === 'string' && details.trim()) {
    return details;
  }

  return fallback;
}

function buildRetryUrl(stageId: StageId, baseUrl?: string): string {
  const normalizedBaseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
  return `${normalizedBaseUrl}/stages/${encodeURIComponent(String(stageId))}/retry`;
}

export async function retryStage(
  stageId: StageId,
  options: RetryStageOptions = {},
): Promise<StageRetryResponse> {
  if (stageId === undefined || stageId === null || String(stageId).trim() === '') {
    throw new StageServiceError('A valid stage id is required to retry a stage.');
  }

  const requestFetch = options.fetchImpl ?? fetch;

  try {
    const response = await requestFetch(buildRetryUrl(stageId, options.baseUrl), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
      },
      credentials: 'same-origin',
      signal: options.signal,
    });

    const responseBody = await readResponseBody(response);

    if (!response.ok) {
      throw new StageServiceError(
        getErrorMessage(responseBody, `Retry failed with status ${response.status}.`),
        response.status,
        responseBody,
      );
    }

    if (responseBody && typeof responseBody === 'object') {
      return responseBody as StageRetryResponse;
    }

    return {
      message: typeof responseBody === 'string' ? responseBody : 'Stage retry was triggered.',
    };
  } catch (error) {
    if (error instanceof StageServiceError) {
      throw error;
    }

    if (error instanceof Error) {
      throw new StageServiceError(`Unable to retry stage: ${error.message}`);
    }

    throw new StageServiceError('Unable to retry stage due to an unknown error.');
  }
}
