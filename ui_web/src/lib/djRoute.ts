import type { DjRouteKind } from './api';
import type { PlaybackQueueEntry } from './playbackQueue';
import { queueIdentity } from './queueDiscovery';

/**
 * The DJ route rules both clients apply to a session's occurrences.
 *
 * Android executes the same rules natively (`ProgramDjRoutePolicy.kt`), and
 * both run the vectors in `shared/contracts/dj_route_rules.json`. Keep these
 * functions free of store state: they decide, the caller writes.
 *
 * A route is the whole queue, history included. A *block* is a requested song
 * and the bridges the planner placed in front of it; edits move, keep or drop
 * a block as one unit so a bridge never strands its owner.
 */
export interface RouteRow {
  /** Occurrence identity: the queue id. */
  key: string;
  kind: DjRouteKind;
  /** For a bridge: the occurrence it leads into. */
  owner?: string;
  /** Set when the request arrived with a whole collection. */
  group?: string;
  /** Recording identity; two occurrences of one song share it. */
  recording: string;
}

export function routeKind(entry: PlaybackQueueEntry): DjRouteKind {
  if (entry.queueLane === 'manual' || entry.autoRoute?.kind === 'user') return 'user';
  return entry.autoRoute?.kind ?? 'generated';
}

export function routeRow(entry: PlaybackQueueEntry): RouteRow {
  const kind = routeKind(entry);
  return {
    key: entry.queueId,
    kind,
    owner: kind === 'bridge' ? entry.autoRoute?.ownerQueueId : undefined,
    group: entry.autoRoute?.requestGroup,
    recording: queueIdentity(entry),
  };
}

export function routeRows(entries: readonly PlaybackQueueEntry[]): RouteRow[] {
  return entries.map(routeRow);
}

/** The last queue index the route may not rewrite: the playing entry, or the
 * entry whose handoff is already loaded and cued after it. */
export function insertionFloor(queue: readonly PlaybackQueueEntry[], index: number, committedQueueId: string | null | undefined): number {
  if (!committedQueueId) return index;
  const committed = queue.findIndex(entry => entry.queueId === committedQueueId);
  return committed > index ? committed : index;
}

function ownerOf(row: RouteRow): string | undefined {
  return row.kind === 'bridge' ? row.owner : undefined;
}

/** The first index nothing playing or committed depends on: past `floor`, and
 * past every row of a block that a protected row belongs to. */
export function editableFrom(rows: readonly RouteRow[], current: number, floor: number): number {
  const protectedEnd = Math.max(current, floor);
  const live = rows.slice(Math.max(0, current), protectedEnd + 1);
  const owners = new Set(live.map(ownerOf).filter((owner): owner is string => !!owner));
  const locked = new Set(live.map(row => row.key));
  let last = protectedEnd;
  rows.forEach((row, index) => {
    if (locked.has(row.key) || owners.has(row.key) || (ownerOf(row) !== undefined && owners.has(ownerOf(row)!))) {
      last = Math.max(last, index);
    }
  });
  return last + 1;
}

/** The keys of `target`'s block in route order, or null for an unknown row. */
export function routeBlock(rows: readonly RouteRow[], target: string): string[] | null {
  const row = rows.find(candidate => candidate.key === target);
  if (!row) return null;
  const parent = ownerOf(row) ?? target;
  return rows.filter(candidate => candidate.key === parent || ownerOf(candidate) === parent).map(candidate => candidate.key);
}

function blockStartKey(rows: readonly RouteRow[], key: string): string | undefined {
  return routeBlock(rows, key)?.[0];
}

/**
 * The route after moving `target`'s block in front of `before`'s block (the
 * end when absent). Null when the move is not allowed: an unknown or ownerless
 * block, a destination inside the moving block, or a block at or before
 * `floor`. A destination at or before the floor lands right after it.
 */
export function moveRouteBlock(rows: readonly RouteRow[], target: string, before: string | undefined, floor: number): string[] | null {
  const row = rows.find(candidate => candidate.key === target);
  if (!row) return null;
  const parent = ownerOf(row) ?? target;
  const block = new Set(routeBlock(rows, target));
  if (!block.has(parent) || (before !== undefined && block.has(before))) return null;
  const start = rows.findIndex(candidate => block.has(candidate.key));
  if (start <= floor) return null;
  const moving = rows.filter(candidate => block.has(candidate.key));
  const rest = rows.filter(candidate => !block.has(candidate.key));
  const anchor = before === undefined ? undefined : blockStartKey(rows, before);
  const found = anchor === undefined ? rest.length : rest.findIndex(candidate => candidate.key === anchor);
  const at = Math.max(floor + 1, found === -1 ? rest.length : found);
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)].map(candidate => candidate.key);
}

/** Where a request is queued at once: in front of `before`'s block when that
 * block is past the floor, otherwise right after the floor. */
export function requestInsertion(rows: readonly RouteRow[], floor: number, before?: string): number {
  if (before !== undefined) {
    const anchor = blockStartKey(rows, before);
    const index = anchor === undefined ? -1 : rows.findIndex(row => row.key === anchor);
    if (index > floor) return index;
  }
  return Math.min(rows.length, floor + 1);
}

/** What removing one occurrence takes with it: the bridges that lead into it.
 * Removing a bridge removes only that bridge. */
export function removedOccurrences(rows: readonly RouteRow[], target: string): string[] {
  if (!rows.some(row => row.key === target)) return [];
  return rows.filter(row => row.key === target || ownerOf(row) === target).map(row => row.key);
}

/** How many future rows a repair sends: `limit`, extended so no bridge inside
 * it is sent without the request it leads into. */
export function repairHorizon(future: readonly RouteRow[], limit: number): number {
  let count = Math.min(limit, future.length);
  for (const row of future.slice(0, count)) {
    const owner = ownerOf(row);
    if (owner !== undefined) count = Math.max(count, future.findIndex(candidate => candidate.key === owner) + 1);
  }
  return count;
}

/** The future rows a session change keeps: single requests (never a whole
 * collection's) other than the session's new lead recording, with their
 * bridges. */
export function sessionSurvivors(future: readonly RouteRow[], lead?: string): string[] {
  const wanted = new Set(future
    .filter(row => row.kind === 'user' && !row.group && (lead === undefined || row.recording !== lead))
    .map(row => row.key));
  return future.filter(row => wanted.has(row.key) || (ownerOf(row) !== undefined && wanted.has(ownerOf(row)!))).map(row => row.key);
}

/**
 * The future a replan writes. Requests and their bridges keep their depth;
 * the generated rows fill the other places in order, skipping any recording a
 * kept row already plays, and continue after the last kept row. When the
 * generated rows run out first, the kept rows close up in their order.
 */
export function replanRunway(previous: readonly RouteRow[], generated: readonly RouteRow[]): string[] {
  const requests = new Set(previous.filter(row => row.kind === 'user').map(row => row.key));
  const pinned = (row: RouteRow) => row.kind === 'user' || (ownerOf(row) !== undefined && requests.has(ownerOf(row)!));
  const kept = previous.map((row, index) => ({ row, index })).filter(({ row }) => pinned(row));
  const keptRecordings = new Set(kept.map(({ row }) => row.recording));
  const filler = generated.filter(row => !keptRecordings.has(row.recording));
  const result: string[] = [];
  let next = 0;
  for (const { row, index } of kept) {
    while (result.length < index && next < filler.length) result.push(filler[next++].key);
    result.push(row.key);
  }
  while (next < filler.length) result.push(filler[next++].key);
  return result;
}
