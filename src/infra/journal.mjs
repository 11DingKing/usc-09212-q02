import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// 预写日志（WAL）：所有状态变更先落盘再应用，故障后按序重放即可继续聚合。
// 崩溃时被截断的尾部记录会被丢弃，对应操作未确认，客户端可安全重试。
export class Journal {
  #file;
  #seq = 0;

  constructor(dir) {
    this.dir = dir;
    this.#file = path.join(dir, "journal.jsonl");
  }

  get seq() {
    return this.#seq;
  }

  append(record) {
    this.#seq += 1;
    const stored = { seq: this.#seq, ...record };
    appendFileSync(this.#file, `${JSON.stringify(stored)}\n`);
    return stored;
  }

  *read() {
    if (!existsSync(this.#file)) return;
    const text = readFileSync(this.#file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        break; // 尾部截断：停止重放
      }
      if (typeof record.seq === "number") this.#seq = Math.max(this.#seq, record.seq);
      yield record;
    }
  }
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function loadSnapshot(dir) {
  const file = path.join(dir, "snapshot.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

// 快照先写临时文件再原子改名，避免写一半损坏。
export function saveSnapshot(dir, state) {
  const file = path.join(dir, "snapshot.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}
