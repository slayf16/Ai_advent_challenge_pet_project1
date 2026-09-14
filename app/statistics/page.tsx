'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { STORAGE_KEY, physicalRequests, restoreStore, type ChatSession } from '@/hooks/use-chat';
import { aggregateMetrics } from '@/lib/chat-metrics';
import { MODELS, type ChatModel } from '@/lib/chat-request';
import { createStatisticsSnapshot, removeStatisticsSnapshot, type StatisticsSnapshot } from '@/lib/statistics';

const SNAPSHOTS_KEY = 'deepchat.statistics-snapshots.v1';
type SavedSnapshot = StatisticsSnapshot;
const number = (value: number | null) => value === null ? 'Нет данных' : value.toLocaleString('ru-RU');
const money = (value: number | null) => value === null ? 'Нет данных' : `$${value.toFixed(6)}`;

export default function StatisticsPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [chatId, setChatId] = useState('');
  const [model, setModel] = useState<ChatModel>(MODELS[0].id);
  const [snapshots, setSnapshots] = useState<SavedSnapshot[]>([]);
  useEffect(() => {
    const store = restoreStore(window.localStorage.getItem(STORAGE_KEY));
    queueMicrotask(() => {
      setSessions(store.sessions); setChatId(store.activeSessionId);
      try { const stored = JSON.parse(window.localStorage.getItem(SNAPSHOTS_KEY) ?? '[]'); if (Array.isArray(stored)) setSnapshots(stored); } catch { /* snapshots are optional */ }
    });
  }, []);
  const chat = sessions.find((item) => item.id === chatId) ?? sessions[0];
  const modelMetrics = useMemo(() => chat ? physicalRequests(chat).filter((item) => item.model === model) : [], [chat, model]);
  const aggregate = aggregateMetrics(modelMetrics, 0, 0);
  const addSnapshot = () => {
    if (!chat) return;
    const next = createStatisticsSnapshot({ chatId: chat.id, chatName: chat.title, agentId: chat.agent.id, agentName: chat.agent.name, model, metrics: modelMetrics }, crypto.randomUUID(), Date.now());
    const saved = [next, ...snapshots]; setSnapshots(saved); window.localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(saved));
  };
  const removeSnapshot = (id: string) => { const saved = removeStatisticsSnapshot(snapshots, id); setSnapshots(saved); window.localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(saved)); };
  return <main className="mx-auto min-h-dvh max-w-5xl p-6 text-foreground">
    <div className="flex items-center justify-between gap-4"><h1 className="text-2xl font-semibold">Сравнение статистики</h1><Link href="/" className="rounded border px-3 py-2 text-sm">К чатам</Link></div>
    <p className="mt-2 text-sm text-muted-foreground">Снимок содержит историю выбранного чата, агента и модели на момент сохранения. Удаление чата не удаляет снимок.</p>
    <div className="mt-6 grid gap-3 sm:grid-cols-3"><label>Чат<select className="mt-1 w-full rounded border bg-background p-2" value={chat?.id ?? ''} onChange={(e) => setChatId(e.target.value)}>{sessions.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.agent.name}</option>)}</select></label><label>Модель<select className="mt-1 w-full rounded border bg-background p-2" value={model} onChange={(e) => setModel(e.target.value as ChatModel)}>{MODELS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="flex items-end"><Button onClick={addSnapshot} disabled={!chat}>Добавить снимок</Button></div></div>
    <Summary title="Предпросмотр истории" aggregate={aggregate} total={modelMetrics.length} />
    <section className="mt-8 space-y-3"><h2 className="text-lg font-semibold">Сохранённые снимки</h2>{snapshots.length === 0 ? <p className="text-sm text-muted-foreground">Снимков пока нет.</p> : snapshots.map((snapshot) => <Snapshot key={snapshot.id} snapshot={snapshot} onRemove={() => removeSnapshot(snapshot.id)} />)}</section>
  </main>;
}
function Summary({ title, aggregate, total }: { title: string; aggregate: ReturnType<typeof aggregateMetrics>; total: number }) { return <section className="mt-6 rounded-xl border p-4"><h2 className="font-semibold">{title}</h2><dl className="mt-3 grid gap-3 sm:grid-cols-3"><div><dt className="text-sm text-muted-foreground">Токены (вход / выход / всего)</dt><dd>{aggregate.usage ? `${number(aggregate.usage.prompt_tokens ?? null)} / ${number(aggregate.usage.completion_tokens ?? null)} / ${number(aggregate.usage.total_tokens ?? null)}` : 'Нет данных'} · покрытие {aggregate.promptCount}/{total} · {aggregate.completionCount}/{total} · {aggregate.totalTokenCount}/{total}</dd></div><div><dt className="text-sm text-muted-foreground">Стоимость</dt><dd>{money(aggregate.minimumCostUsd)}{aggregate.minimumCostUsd !== aggregate.maximumCostUsd && `–${money(aggregate.maximumCostUsd)}`} · тариф/usage {aggregate.costCount}/{total} · {aggregate.isPartial && 'частичные данные'}</dd></div><div><dt className="text-sm text-muted-foreground">Средняя скорость</dt><dd>{aggregate.averageTokensPerSecond === null ? 'Нет данных' : `${aggregate.averageTokensPerSecond.toFixed(1)} токен/с`} · покрытие {aggregate.speedCount}/{total}</dd></div></dl></section>; }
function Snapshot({ snapshot, onRemove }: { snapshot: SavedSnapshot; onRemove: () => void }) { const aggregate = aggregateMetrics(snapshot.metrics, 0, 0); return <article className="rounded-xl border p-4"><div className="flex justify-between gap-3"><div><h3 className="font-medium">{snapshot.chatName} · {snapshot.agentName}</h3><p className="text-sm text-muted-foreground">{MODELS.find((item) => item.id === snapshot.model)?.name} · {new Date(snapshot.capturedAt).toLocaleString('ru-RU')}</p></div><Button variant="ghost" onClick={onRemove}>Удалить снимок</Button></div><Summary title="" aggregate={aggregate} total={snapshot.metrics.length} /></article>; }
