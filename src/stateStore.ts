import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

export type RunState = 0 | 1 | 2;

export interface ChatEntry {
  id: string;
  generation: string;
  type: "server" | "client" | "app";
  data: string;
  createdAt: string;
}

export interface ThemeSnapshot {
  themeCode: string;
  generation: string;
  previousGeneration: string | null;
  revision: number;
  isRunning: RunState;
  startedAt: number | null;
  endTime: number;
  remainingTime: number;
  progress: number;
  progressIndex: number;
  hintCount: number;
  usedHintCodes: string[];
  chatData: ChatEntry[];
  resetAt: number;
  updatedAt: number;
  lastRequestId?: string;
}

export interface ClientSnapshot extends Partial<ThemeSnapshot> {
  themeCode: string;
  baseGeneration?: string | null;
  baseRevision?: number;
  localBranchId?: string | null;
  localResetAt?: number | null;
}

export type StateAction =
  | { type: "reset"; durationMs?: number }
  | { type: "start"; durationMs: number; startedAt?: number }
  | { type: "stop"; remainingTime?: number }
  | { type: "changeTime"; remainingTime: number; isRunning: RunState }
  | { type: "changeProgress"; progress: number; progressIndex: number }
  | { type: "useHint"; code?: string; hintCount?: number }
  | { type: "replaceChat"; chatData: Partial<ChatEntry>[] }
  | { type: "appendChat"; message: Partial<ChatEntry> };

const dataDir = path.join(process.cwd(), "data");
const statePath = process.env.HINT_STATE_FILE || path.join(dataDir, "theme-state.json");
const tempPath = `${statePath}.tmp`;
const states = new Map<string, ThemeSnapshot>();
const handledRequests = new Map<string, number>();

function now() {
  return Date.now();
}

function makeGeneration() {
  return randomUUID();
}

function normalizeChat(
  entries: Partial<ChatEntry>[] | undefined,
  generation: string
): ChatEntry[] {
  const seen = new Set<string>();
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const createdAt = entry.createdAt || new Date().toISOString();
      const type: ChatEntry["type"] =
        entry.type === "server" || entry.type === "app" ? entry.type : "client";
      const data = String(entry.data ?? "");
      const id = entry.id || `${type}:${createdAt}:${data}`;
      return { id, generation, type, data, createdAt };
    })
    .filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function normalizeSnapshot(input: ClientSnapshot): ThemeSnapshot {
  const generation = input.generation || makeGeneration();
  const usedHintCodes = Array.isArray(input.usedHintCodes)
    ? [...new Set(input.usedHintCodes.map(String))]
    : [];
  const hintCount = Math.max(Number(input.hintCount || 0), usedHintCodes.length);
  return {
    themeCode: input.themeCode,
    generation,
    previousGeneration: input.previousGeneration || null,
    revision: Number(input.revision || 0),
    isRunning: input.isRunning === 1 || input.isRunning === 2 ? input.isRunning : 0,
    startedAt: Number(input.startedAt || 0) || null,
    endTime: Number(input.endTime || 0),
    remainingTime: Number(input.remainingTime || 0),
    progress: Number(input.progress || 0),
    progressIndex: Number(input.progressIndex || 0),
    hintCount,
    usedHintCodes,
    chatData: normalizeChat(input.chatData, generation),
    resetAt: Number(input.resetAt || input.localResetAt || now()),
    updatedAt: now(),
    lastRequestId: input.lastRequestId,
  };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    for (const item of Array.isArray(parsed) ? parsed : []) {
      if (item?.themeCode) states.set(item.themeCode, normalizeSnapshot(item));
    }
  } catch {
    // First run or a missing file is valid.
  }
}

function persist() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify([...states.values()], null, 2));
  fs.renameSync(tempPath, statePath);
}

function rememberRequest(requestId: string) {
  handledRequests.set(requestId, now());
  if (handledRequests.size > 5000) {
    const oldest = [...handledRequests.entries()].sort((a, b) => a[1] - b[1]).slice(0, 1000);
    oldest.forEach(([id]) => handledRequests.delete(id));
  }
}

function mergeChats(a: ChatEntry[], b: Partial<ChatEntry>[], generation: string) {
  return normalizeChat([...a, ...b], generation);
}

export function getThemeSnapshot(themeCode: string) {
  return states.get(themeCode) || null;
}

export function getAllThemeSnapshots() {
  return [...states.values()];
}

export function seedThemeSnapshot(input: ClientSnapshot) {
  const existing = states.get(input.themeCode);
  if (existing) {
    // During the first V2 migration, control's persisted snapshot wins over an
    // app that happened to connect a few milliseconds earlier.
    if (existing.revision === 0 && existing.previousGeneration === null) {
      const bootstrapped = normalizeSnapshot({
        ...input,
        generation: existing.generation,
        previousGeneration: null,
      });
      states.set(input.themeCode, bootstrapped);
      persist();
      return bootstrapped;
    }
    return existing;
  }
  const seeded = normalizeSnapshot(input);
  states.set(input.themeCode, seeded);
  persist();
  return seeded;
}

export function applyAction(themeCode: string, requestId: string, action: StateAction) {
  if (handledRequests.has(requestId) || states.get(themeCode)?.lastRequestId === requestId) {
    return { status: "alreadyApplied" as const, snapshot: states.get(themeCode) || null };
  }
  const existing = states.get(themeCode) || normalizeSnapshot({ themeCode });
  let next: ThemeSnapshot = { ...existing, updatedAt: now(), lastRequestId: requestId };

  if (action.type === "reset") {
    const requestedDuration = Number(action.durationMs);
    const resetDuration = Number.isFinite(requestedDuration)
      ? Math.max(0, requestedDuration)
      : Math.max(0, Number(existing.remainingTime || 0));
    const alreadyReset =
      existing.isRunning === 0 &&
      existing.hintCount === 0 &&
      existing.usedHintCodes.length === 0 &&
      existing.chatData.length === 0 &&
      existing.progress === 0 &&
      existing.progressIndex === 0;
    if (!alreadyReset) {
      next = {
        ...next,
        generation: makeGeneration(),
        previousGeneration: existing.generation,
        revision: 0,
        isRunning: 0,
        startedAt: null,
        endTime: 0,
        remainingTime: resetDuration,
        progress: 0,
        progressIndex: 0,
        hintCount: 0,
        usedHintCodes: [],
        chatData: [],
        resetAt: now(),
      };
    } else {
      // Repeated resets must refresh the configured idle timer too.
      next = {
        ...next,
        isRunning: 0,
        startedAt: null,
        endTime: 0,
        remainingTime: resetDuration,
      };
    }
  } else {
    next.revision = existing.revision + 1;
    if (action.type === "start") {
      if (existing.isRunning !== 1) {
        const startedAt = Number(action.startedAt || now());
        next.startedAt = startedAt;
        next.endTime = startedAt + Number(action.durationMs || existing.remainingTime || 0);
        next.remainingTime = Math.max(0, next.endTime - now());
        next.isRunning = 1;
      }
    } else if (action.type === "stop") {
      next.remainingTime = Number(action.remainingTime ?? Math.max(0, existing.endTime - now()));
      next.endTime = next.remainingTime;
      next.isRunning = 2;
    } else if (action.type === "changeTime") {
      next.remainingTime = Number(action.remainingTime || 0);
      next.endTime = action.isRunning === 1 ? now() + next.remainingTime : next.remainingTime;
      next.isRunning = action.isRunning;
    } else if (action.type === "changeProgress") {
      next.progress = Number(action.progress || 0);
      next.progressIndex = Number(action.progressIndex || 0);
    } else if (action.type === "useHint") {
      if (action.code) next.usedHintCodes = [...new Set([...existing.usedHintCodes, action.code])];
      next.hintCount = Math.max(next.usedHintCodes.length, Number(action.hintCount || 0));
    } else if (action.type === "replaceChat") {
      next.chatData = normalizeChat(action.chatData, existing.generation);
    } else if (action.type === "appendChat") {
      next.chatData = mergeChats(existing.chatData, [action.message], existing.generation);
    }
  }

  states.set(themeCode, next);
  rememberRequest(requestId);
  persist();
  return { status: "applied" as const, snapshot: next };
}

export function reconcileAppSnapshot(input: ClientSnapshot) {
  const server = states.get(input.themeCode);
  if (!server) {
    const adopted = normalizeSnapshot({ ...input, generation: makeGeneration(), previousGeneration: input.baseGeneration || null });
    states.set(input.themeCode, adopted);
    persist();
    return { status: "adopted" as const, snapshot: adopted };
  }

  const isLocalBranch = Boolean(input.localBranchId || String(input.generation || "").startsWith("local:"));
  if (isLocalBranch) {
    const serverUnchanged =
      input.baseGeneration === server.generation && Number(input.baseRevision || 0) === server.revision;
    const directSibling = server.previousGeneration === input.baseGeneration;
    const bothPlaying = server.isRunning === 1 && input.isRunning === 1;

    if (serverUnchanged) {
      const adopted = normalizeSnapshot({
        ...input,
        generation: makeGeneration(),
        previousGeneration: server.generation,
        revision: server.revision + 1,
      });
      states.set(input.themeCode, adopted);
      persist();
      return { status: "offlineBranchAdopted" as const, snapshot: adopted };
    }

    if (bothPlaying && (directSibling || input.baseGeneration === server.generation)) {
      const appStart = Number(input.startedAt || 0);
      const serverStart = Number(server.startedAt || 0);
      const startedAt = appStart && serverStart ? Math.min(appStart, serverStart) : appStart || serverStart || now();
      const appEnd = Number(input.endTime || 0);
      const serverEnd = Number(server.endTime || 0);
      const endTime = appEnd && serverEnd ? Math.min(appEnd, serverEnd) : appEnd || serverEnd;
      const usedHintCodes = [...new Set([...server.usedHintCodes, ...(input.usedHintCodes || [])])];
      const merged: ThemeSnapshot = {
        ...server,
        revision: server.revision + 1,
        startedAt,
        endTime,
        remainingTime: Math.max(0, endTime - now()),
        progress: Math.max(server.progress, Number(input.progress || 0)),
        progressIndex: Math.max(server.progressIndex, Number(input.progressIndex || 0)),
        usedHintCodes,
        hintCount: Math.max(usedHintCodes.length, server.hintCount, Number(input.hintCount || 0)),
        chatData: mergeChats(server.chatData, input.chatData || [], server.generation),
        updatedAt: now(),
      };
      states.set(input.themeCode, merged);
      persist();
      return { status: "offlineBranchMerged" as const, snapshot: merged };
    }

    return { status: "serverWins" as const, snapshot: server };
  }

  if (input.generation === server.generation) {
    const usedHintCodes = [...new Set([...server.usedHintCodes, ...(input.usedHintCodes || [])])];
    const merged: ThemeSnapshot = {
      ...server,
      revision: Math.max(server.revision, Number(input.revision || 0)) + 1,
      usedHintCodes,
      hintCount: Math.max(usedHintCodes.length, server.hintCount, Number(input.hintCount || 0)),
      chatData: mergeChats(server.chatData, input.chatData || [], server.generation),
      updatedAt: now(),
    };
    states.set(input.themeCode, merged);
    persist();
    return { status: "sameGenerationMerged" as const, snapshot: merged };
  }

  return { status: "serverWins" as const, snapshot: server };
}

load();
