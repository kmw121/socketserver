import util from "util";

type Level = "LOG" | "INFO" | "WARN" | "ERROR";

const SENSITIVE_KEYS = new Set([
  "pushtoken",
  "token",
  "authorization",
  "password",
  "secret",
]);

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

function redactSensitive(value: any, seen = new WeakSet<object>()): any {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return value.stack || value.message;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (seen.has(value)) return "<CIRCULAR>";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEYS.has(key.toLowerCase())
        ? item
          ? "<REDACTED>"
          : item
        : redactSensitive(item, seen),
    ])
  );
}

function safeToString(value: any) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  return util.inspect(redactSensitive(value), {
    depth: 5,
    maxArrayLength: 100,
    breakLength: 140,
  });
}

function wrap(level: Level, original: (...args: any[]) => void) {
  return (...args: any[]) => {
    const message = args.map(safeToString).join(" ");
    original(`[${nowStamp()}] [${level}] ${message}`);
  };
}

export function setupConsoleLogger() {
  const log = console.log.bind(console);
  const info = console.info.bind(console);
  const warn = console.warn.bind(console);
  const error = console.error.bind(console);

  console.log = wrap("LOG", log);
  console.info = wrap("INFO", info);
  console.warn = wrap("WARN", warn);
  console.error = wrap("ERROR", error);

  process.on("uncaughtException", (reason) => {
    console.error("uncaughtException:", reason);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection:", reason);
  });
}
