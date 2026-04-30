import * as React from 'react';
import {
  retryStage,
  StageServiceError,
  type StageRecord,
  type StageRetryResponse,
} from '../services/stageService';

export interface StageActionsProps {
  stage: StageRecord;
  onStageUpdated?: (stage: StageRecord) => void;
  onRetrySuccess?: (stage: StageRecord, response: StageRetryResponse) => void;
  onRetryError?: (error: Error) => void;
  onRetry?: (stage: StageRecord) => Promise<StageRetryResponse> | StageRetryResponse;
  maxRetryAttempts?: number;
  retryButtonLabel?: string;
}

export function isFailedStage(stage?: Pick<StageRecord, 'status'> | null): boolean {
  return String(stage?.status ?? '').toLowerCase() === 'failed';
}

function getRetryAttempts(stage: StageRecord): number | undefined {
  const record = stage as Record<string, unknown>;
  const value = record.retryAttempts ?? record.retry_count ?? record.retryAttemptsCount;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : undefined;
  }

  return undefined;
}

function hasReachedMaxRetries(stage: StageRecord, maxRetryAttempts?: number): boolean {
  if (maxRetryAttempts === undefined) {
    return false;
  }

  const retryAttempts = getRetryAttempts(stage);
  return retryAttempts !== undefined && retryAttempts >= maxRetryAttempts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRetriedStage(stage: StageRecord, response: StageRetryResponse): StageRecord {
  if (isRecord(response.stage)) {
    return {
      ...stage,
      ...response.stage,
    };
  }

  if (typeof response.status === 'string' && response.status.trim()) {
    return {
      ...stage,
      status: response.status,
    };
  }

  return {
    ...stage,
    status: 'queued',
  };
}

function getReadableError(error: unknown): string {
  if (error instanceof StageServiceError && error.message) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'The stage could not be retried. Please try again.';
}

export function StageActions({
  stage,
  onStageUpdated,
  onRetrySuccess,
  onRetryError,
  onRetry,
  maxRetryAttempts,
  retryButtonLabel = 'Retry',
}: StageActionsProps): React.ReactElement | null {
  const [isRetrying, setIsRetrying] = React.useState(false);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  if (!isFailedStage(stage)) {
    return null;
  }

  const retryLimitReached = hasReachedMaxRetries(stage, maxRetryAttempts);
  const isDisabled = isRetrying || retryLimitReached;

  async function handleRetryClick(): Promise<void> {
    if (isRetrying || retryLimitReached) {
      return;
    }

    if (!isFailedStage(stage)) {
      setErrorMessage('Retry is only available for failed stages.');
      setSuccessMessage(null);
      return;
    }

    setIsRetrying(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = onRetry ? await onRetry(stage) : await retryStage(stage.id);
      const updatedStage = normalizeRetriedStage(stage, response);

      onStageUpdated?.(updatedStage);
      onRetrySuccess?.(updatedStage, response);
      setSuccessMessage(response.message || 'Stage retry was triggered.');
    } catch (error) {
      const message = getReadableError(error);
      const retryError = error instanceof Error ? error : new Error(message);

      setErrorMessage(message);
      onRetryError?.(retryError);
    } finally {
      setIsRetrying(false);
    }
  }

  return (
    <div className="stage-actions" aria-live="polite">
      <button
        type="button"
        className="stage-actions__retry-button"
        onClick={handleRetryClick}
        disabled={isDisabled}
        aria-busy={isRetrying}
      >
        {isRetrying ? 'Retrying…' : retryButtonLabel}
      </button>

      {retryLimitReached ? (
        <p className="stage-actions__message" role="status">
          Retry limit reached for this stage.
        </p>
      ) : null}

      {successMessage ? (
        <p className="stage-actions__message stage-actions__message--success" role="status">
          {successMessage}
        </p>
      ) : null}

      {errorMessage ? (
        <p className="stage-actions__message stage-actions__message--error" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
