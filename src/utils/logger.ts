// src/utils/logger.ts
import fs from "fs";
import path from "path";
import util from "util";

type Level = "LOG" | "INFO" | "WARN" | "ERROR";

const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function dateKey(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function nowStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
}

function safeToString(v: any) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || v.message;
  return util.inspect(v, { depth: 2, maxArrayLength: 20, breakLength: 140 });
}

let currentKey = dateKey();
let stream = fs.createWriteStream(path.join(LOG_DIR, `${currentKey}.log`), {
  flags: "a",
});

// ??backpressure ?쒖뼱: ?ㅽ듃由쇱씠 苑?李⑤㈃ ?뚯씪濡쒓렇瑜??좉퉸 ?쒕엻
let dropping = false;
let droppedCount = 0;

function rotateIfNeeded() {
  const k = dateKey();
  if (k === currentKey) return;

  try {
    stream.end();
  } catch {}
  currentKey = k;
  stream = fs.createWriteStream(path.join(LOG_DIR, `${currentKey}.log`), {
    flags: "a",
  });

  // ???ㅽ듃由쇱뿉?쒕룄 drain 泥섎━
  stream.on("drain", () => {
    dropping = false;
    if (droppedCount > 0) {
      const line = `[${nowStamp()}] [WARN] (logger) dropped ${droppedCount} log lines due to backpressure`;
      droppedCount = 0;
      stream.write(line + "\n");
    }
  });

  stream.on("error", (e) => {
    // ?뚯씪?곌린 ?먮윭??肄섏넄留?
    // eslint-disable-next-line no-console
    console.error("log stream error:", e);
  });
}

function writeLine(line: string) {
  rotateIfNeeded();

  if (dropping) {
    droppedCount++;
    return;
  }

  const ok = stream.write(line + "\n");
  if (!ok) {
    // highWaterMark 珥덇낵 ???댄썑???쒕엻 紐⑤뱶濡?
    dropping = true;
    droppedCount++;
  }
}

function wrap(level: Level, orig: (...args: any[]) => void) {
  return (...args: any[]) => {
    const msg = args.map(safeToString).join(" ");
    writeLine(`[${nowStamp()}] [${level}] ${msg}`);
    orig(...args);
  };
}

export function setupFileLogger() {
  const _log = console.log.bind(console);
  const _info = console.info.bind(console);
  const _warn = console.warn.bind(console);
  const _error = console.error.bind(console);

  console.log = wrap("LOG", _log);
  console.info = wrap("INFO", _info);
  console.warn = wrap("WARN", _warn);
  console.error = wrap("ERROR", _error);

  // 湲곗〈 ?ㅽ듃由쇱뿉??drain/error
  stream.on("drain", () => {
    dropping = false;
    if (droppedCount > 0) {
      const line = `[${nowStamp()}] [WARN] (logger) dropped ${droppedCount} log lines due to backpressure`;
      droppedCount = 0;
      stream.write(line + "\n");
    }
  });

  stream.on("error", (e) => {
    _error("log stream error:", e);
  });

  process.on("uncaughtException", (err) => {
    console.error("uncaughtException:", err);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection:", reason);
  });
}
