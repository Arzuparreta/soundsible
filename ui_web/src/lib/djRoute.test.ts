import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  editableFrom,
  moveRouteBlock,
  removedOccurrences,
  repairHorizon,
  replanRunway,
  requestInsertion,
  routeBlock,
  routeRow,
  sessionSurvivors,
  type RouteRow,
} from './djRoute';
import { createQueueEntry } from './playbackQueue';

interface VectorRow { key: string; kind: RouteRow['kind']; owner?: string; group?: string; recording?: string }
type Vector = Record<string, unknown> & { rule: string; name: string; expect: unknown };

const vectors: Vector[] = JSON.parse(readFileSync(
  new NodeURL('../../../shared/contracts/dj_route_rules.json', import.meta.url), 'utf8')).cases;

function rows(value: unknown): RouteRow[] {
  return (value as VectorRow[]).map(row => ({ ...row, recording: row.recording ?? row.key }));
}

function evaluate(vector: Vector): unknown {
  const before = (vector.before ?? undefined) as string | undefined;
  switch (vector.rule) {
    case 'editable_from': return editableFrom(rows(vector.rows), vector.current as number, vector.floor as number);
    case 'block': return routeBlock(rows(vector.rows), vector.target as string);
    case 'move': return moveRouteBlock(rows(vector.rows), vector.target as string, before, vector.floor as number);
    case 'request_insertion': return requestInsertion(rows(vector.rows), vector.floor as number, before);
    case 'remove': return removedOccurrences(rows(vector.rows), vector.target as string);
    case 'repair_horizon': return repairHorizon(rows(vector.future), vector.limit as number);
    case 'session_survivors': return sessionSurvivors(rows(vector.future), (vector.lead ?? undefined) as string | undefined);
    case 'replan': return replanRunway(rows(vector.previous), rows(vector.generated));
    default: throw new Error(`unknown rule ${vector.rule}`);
  }
}

describe('shared DJ route rules', () => {
  it('covers every rule', () => {
    expect(new Set(vectors.map(vector => vector.rule))).toEqual(new Set([
      'editable_from', 'block', 'move', 'request_insertion', 'remove', 'repair_horizon', 'session_survivors', 'replan',
    ]));
  });
  for (const vector of vectors) {
    it(`${vector.rule}: ${vector.name}`, () => {
      expect(evaluate(vector)).toEqual(vector.expect);
    });
  }
});

describe('route rows from queue entries', () => {
  const track = { id: 't', title: 'T', artist: 'A' };
  it('treats a manual occurrence as a request and keeps bridge ownership', () => {
    const manual = createQueueEntry(track, 'manual', 'play_next');
    expect(routeRow(manual).kind).toBe('user');
    const bridge = { ...createQueueEntry(track, 'generated', 'auto_mode'), autoRoute: { kind: 'bridge' as const, ownerQueueId: manual.queueId } };
    expect(routeRow(bridge)).toMatchObject({ kind: 'bridge', owner: manual.queueId });
    const grouped = { ...createQueueEntry(track, 'generated', 'auto_mode'), autoRoute: { kind: 'user' as const, requestGroup: 'g' } };
    expect(routeRow(grouped)).toMatchObject({ kind: 'user', group: 'g' });
  });
});
