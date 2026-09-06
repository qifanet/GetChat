/**
 * Task Queue types for v1.5.0
 */

export type TaskType = 'PARALLEL_FORK' | 'TITLE_GENERATION';

export type TaskStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface TaskQueueItemDto {
  id: string;
  conversationId: string;
  taskType: TaskType;
  status: TaskStatus;
  parentForkId: string | null;
  config: Record<string, any>;
  result: Record<string, any> | null;
  errorMessage: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  /** Restart recoveries + 429 backoff cycles (M4.1). */
  attempts: number;
  /** Scheduled wake-up for PAUSED tasks (epoch seconds); null = immediately due. */
  nextRunAt: number | null;
}
