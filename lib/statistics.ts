import type { RequestMetrics } from './chat-metrics';
import type { ChatModel } from './chat-request';

export type StatisticsSnapshot = {
  id: string;
  chatId: string;
  chatName: string;
  agentId: string;
  agentName: string;
  model: ChatModel;
  capturedAt: number;
  metrics: RequestMetrics[];
};

export const createStatisticsSnapshot = (
  source: Omit<StatisticsSnapshot, 'id' | 'capturedAt' | 'metrics'> & { metrics: RequestMetrics[] },
  id: string,
  capturedAt: number,
): StatisticsSnapshot => ({ ...source, id, capturedAt, metrics: structuredClone(source.metrics) });

export const removeStatisticsSnapshot = (
  snapshots: StatisticsSnapshot[],
  id: string,
) => snapshots.filter((snapshot) => snapshot.id !== id);
