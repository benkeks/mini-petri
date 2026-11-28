import { version } from "../../package.json";
import { endless } from "./endless";
import { Game, type GameSnapshot } from "./game";

const PREFIX = "mini-petri:session:";
const FORMAT = 1;

export interface SavedSession {
  id: string;
  name?: string;
  startedAt?: number;
  thumbnail?: string;
  version?: string;
  updatedAt?: number;
  epoch?: number;
  score?: number;
  damaged: boolean;
}

interface SaveFile {
  format: number;
  version: string;
  name?: string;
  startedAt?: number;
  thumbnail?: string;
  updatedAt: number;
  epoch: number;
  score: number;
  state: GameSnapshot;
}

export function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseMetadata(data: unknown): Omit<SaveFile, "format" | "state"> {
  if (!data || typeof data !== "object" || !("version" in data) || typeof data.version !== "string"
    || !("updatedAt" in data) || typeof data.updatedAt !== "number" || !Number.isFinite(data.updatedAt)
    || !("epoch" in data) || typeof data.epoch !== "number" || !Number.isFinite(data.epoch)
    || !("score" in data) || typeof data.score !== "number" || !Number.isFinite(data.score)) {
    throw new Error("Unrecognized or damaged save file");
  }
  const name = "name" in data ? data.name : undefined;
  const startedAt = "startedAt" in data ? data.startedAt : undefined;
  const thumbnail = "thumbnail" in data ? data.thumbnail : undefined;
  if ((name !== undefined && (typeof name !== "string" || !/^\d{4}-\d{2}-\d{2}(?:::|-)\d{2,}$/.test(name)))
    || (startedAt !== undefined && (typeof startedAt !== "number" || !Number.isFinite(new Date(startedAt).getTime())))
    || (thumbnail !== undefined && (typeof thumbnail !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(thumbnail)))) {
    throw new Error("Invalid saved session metadata");
  }
  return {
    version: data.version, updatedAt: data.updatedAt, epoch: data.epoch, score: data.score,
    name: name?.replace(/^(\d{4}-\d{2}-\d{2})-/, "$1::"), startedAt, thumbnail,
  };
}

function parseSave(raw: string): SaveFile {
  const data: unknown = JSON.parse(raw);
  const metadata = parseMetadata(data);
  if (!data || typeof data !== "object" || !("format" in data) || data.format !== FORMAT
    || !("state" in data) || !data.state || typeof data.state !== "object") throw new Error("Unsupported save format");
  return { ...metadata, format: FORMAT, state: data.state as GameSnapshot };
}

export function olderVersion(saved: string, current = version): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\./.exec(value)?.slice(1).map(Number);
  const old = parse(saved), now = parse(current);
  return !!old && !!now && (old[0] < now[0] || (old[0] === now[0] && old[1] < now[1]));
}

export class Saves {
  private readonly pending = new Map<string, number>();
  constructor(private readonly storage: Storage) {}

  newId(): string {
    const now = Date.now();
    const id = this.nextName(now);
    this.pending.set(id, now);
    return id;
  }

  private nextName(startedAt: number): string {
    const day = localDay(startedAt);
    const names = [...this.list().flatMap((session) => [session.name ?? session.id, session.id]), ...this.pending.keys()];
    const highest = Math.max(0, ...names.flatMap((name) => {
      const match = /^(\d{4}-\d{2}-\d{2})(?:::|-)(\d{2,})$/.exec(name);
      return match?.[1] === day ? [Number(match[2])] : [];
    }));
    return `${day}::${String(highest + 1).padStart(2, "0")}`;
  }

  list(): SavedSession[] {
    const sessions: SavedSession[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const id = key.slice(PREFIX.length);
      const raw = this.storage.getItem(key);
      if (raw === null) continue;
      try {
        const save = parseMetadata(JSON.parse(raw));
        sessions.push({ id, ...save, damaged: false });
      } catch (error) {
        console.error("Could not read saved session", error);
        sessions.push({ id, damaged: true });
      }
    }
    const counts = new Map<string, number>();
    for (const session of sessions) {
      if (!session.name) continue;
      const day = session.name.slice(0, 10);
      counts.set(day, Math.max(counts.get(day) ?? 0, Number(session.name.slice(12))));
    }
    // Old saves have no start date; use their saved date until they are saved again.
    for (const session of sessions.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || a.id.localeCompare(b.id))) {
      if (session.name || session.updatedAt === undefined || !Number.isFinite(new Date(session.updatedAt).getTime())) continue;
      const day = localDay(session.startedAt ?? session.updatedAt);
      const count = (counts.get(day) ?? 0) + 1;
      counts.set(day, count);
      session.name = `${day}::${String(count).padStart(2, "0")}`;
    }
    return sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  save(id: string, game: Game, thumbnail?: string): void {
    const raw = this.storage.getItem(PREFIX + id);
    let previous: SavedSession | undefined;
    if (raw !== null) {
      try {
        previous = { id, ...parseMetadata(JSON.parse(raw)), damaged: false };
      } catch (error) {
        console.error("Could not read saved session", error);
        previous = { id, damaged: true };
      }
      if (!previous.name && !previous.damaged) previous = this.list().find((session) => session.id === id);
    }
    const now = Date.now();
    const startedAt = previous?.startedAt ?? this.pending.get(id) ?? previous?.updatedAt ?? now;
    const file: SaveFile = {
      format: FORMAT, version, name: previous?.name ?? (this.pending.has(id) ? id : this.nextName(startedAt)),
      startedAt, thumbnail: thumbnail ?? previous?.thumbnail,
      updatedAt: now, epoch: game.epoch, score: game.score, state: game.snapshot(),
    };
    this.storage.setItem(PREFIX + id, JSON.stringify(file));
    this.pending.delete(id);
  }

  load(id: string): Game {
    const raw = this.storage.getItem(PREFIX + id);
    if (raw === null) throw new Error("Saved session no longer exists");
    const file = parseSave(raw);
    return new Game(endless, Math.random, { snapshot: file.state });
  }

  remove(id: string): void {
    this.storage.removeItem(PREFIX + id);
    this.pending.delete(id);
  }
}
