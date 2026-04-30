import * as React from 'react';
import { StageActions, isFailedStage } from './StageActions';
import type { StageRecord, StageRetryResponse } from '../services/stageService';

export interface StageDetailsProps {
  stage: StageRecord;
  className?: string;
  onStageUpdated?: (stage: StageRecord) => void;
  onRetrySuccess?: (stage: StageRecord, response: StageRetryResponse) => void;
  onRetryError?: (error: Error) => void;
  onRetry?: (stage: StageRecord) => Promise<StageRetryResponse> | StageRetryResponse;
  maxRetryAttempts?: number;
}

function getTextField(stage: StageRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stage[key];

    if (typeof value === 'string' && value.trim()) {
      return value;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

function formatStatus(status: unknown): string {
  if (typeof status !== 'string' || !status.trim()) {
    return 'Unknown';
  }

  return status
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function StageDetails({
  stage,
  className,
  onStageUpdated,
  onRetrySuccess,
  onRetryError,
  onRetry,
  maxRetryAttempts,
}: StageDetailsProps): React.ReactElement {
  const stageName = getTextField(stage, ['name', 'title', 'label']) || `Stage ${stage.id}`;
  const stageType = getTextField(stage, ['type', 'kind']);
  const startedAt = getTextField(stage, ['startedAt', 'started_at', 'createdAt', 'created_at']);
  const completedAt = getTextField(stage, ['completedAt', 'completed_at', 'finishedAt', 'finished_at']);
  const failureMessage = getTextField(stage, ['error', 'errorMessage', 'failureReason', 'failure_reason']);
  const rootClassName = ['stage-details', className].filter(Boolean).join(' ');

  return (
    <section className={rootClassName} data-stage-id={stage.id} data-stage-status={stage.status}>
      <header className="stage-details__header">
        <h3 className="stage-details__title">{stageName}</h3>
        <span className="stage-details__status">{formatStatus(stage.status)}</span>
      </header>

      <dl className="stage-details__metadata">
        <div className="stage-details__metadata-row">
          <dt>Stage ID</dt>
          <dd>{stage.id}</dd>
        </div>

        {stageType ? (
          <div className="stage-details__metadata-row">
            <dt>Type</dt>
            <dd>{stageType}</dd>
          </div>
        ) : null}

        {startedAt ? (
          <div className="stage-details__metadata-row">
            <dt>Started</dt>
            <dd>{startedAt}</dd>
          </div>
        ) : null}

        {completedAt ? (
          <div className="stage-details__metadata-row">
            <dt>Completed</dt>
            <dd>{completedAt}</dd>
          </div>
        ) : null}
      </dl>

      {failureMessage ? (
        <div className="stage-details__failure" role="alert">
          <strong>Failure reason:</strong> {failureMessage}
        </div>
      ) : null}

      {isFailedStage(stage) ? (
        <StageActions
          stage={stage}
          onStageUpdated={onStageUpdated}
          onRetrySuccess={onRetrySuccess}
          onRetryError={onRetryError}
          onRetry={onRetry}
          maxRetryAttempts={maxRetryAttempts}
        />
      ) : null}
    </section>
  );
}
