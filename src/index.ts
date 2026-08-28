import express, { Request, Response, NextFunction } from "express";
import fs from "fs";
import { createServer } from "http";
import path from "path";
import { Server, Socket } from "socket.io";
import { Expo } from "expo-server-sdk";
import {
  applyAction,
  ClientSnapshot,
  getAllThemeSnapshots,
  getThemeSnapshot,
  reconcileAppSnapshot,
  seedThemeSnapshot,
  StateAction,
  ThemeSnapshot,
} from "./stateStore";
import { setupConsoleLogger } from "./utils/logger";

setupConsoleLogger();

const app = express();
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

type ClientType = "control" | "app";

interface ClientInfo {
  socketId: string;
  type: ClientType;
  themeCode?: string;
  pushToken?: string;
  platform?: "android" | "ios";
  deviceId?: string;
}

const pushTokenDataDir = path.join(process.cwd(), "data");
const pushTokenPath =
  process.env.HINT_PUSH_TOKEN_FILE ||
  path.join(pushTokenDataDir, "push-tokens.json");
const pushTokenTempPath = `${pushTokenPath}.tmp`;

function loadPushTokens(): Map<string, string> {
  try {
    if (!fs.existsSync(pushTokenPath)) return new Map();
    const parsed = JSON.parse(fs.readFileSync(pushTokenPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Map();
    }
    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string"
      )
    );
  } catch (error) {
    console.log("Push token load failed:", error);
    return new Map();
  }
}

function persistPushTokens(tokens: Map<string, string>) {
  try {
    fs.mkdirSync(path.dirname(pushTokenPath), { recursive: true });
    fs.writeFileSync(
      pushTokenTempPath,
      JSON.stringify(Object.fromEntries(tokens), null, 2),
      "utf-8"
    );
    fs.renameSync(pushTokenTempPath, pushTokenPath);
  } catch (error) {
    console.log("Push token save failed:", error);
  }
}

const clients: Map<string, ClientInfo> = new Map();
const themeToAppSocket: Map<string, string> = new Map();
const themeToPushToken = loadPushTokens();

const expo = new Expo();

// -----------------------------
// 유틸
// -----------------------------
type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void>;

const asyncHandler =
  (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

function getSocketById(id: string): Socket | undefined {
  return io.sockets.sockets.get(id);
}

function forceDisconnect(socketId: string, reason: string) {
  const s = getSocketById(socketId);
  if (s) {
    try {
      logEventFull("SOCKET OUT forceDisconnect", { to: socketId, reason });
      s.disconnect(true);
      console.log("🧹 forceDisconnect:", { socketId, reason });
    } catch (e) {
      console.log("forceDisconnect error:", e);
    }
  }

  // 맵 정리도 같이
  const info = clients.get(socketId);
  if (info?.type === "app" && info.themeCode) {
    if (themeToAppSocket.get(info.themeCode) === socketId) {
      themeToAppSocket.delete(info.themeCode);
    }
  }
  clients.delete(socketId);
}

function notifyControls(payload: {
  themeCode: string | null;
  status: string;
  data: any;
}) {
  for (const c of clients.values()) {
    if (c.type === "control") {
      emitToSocket(c.socketId, "control", "status", payload);
    }
  }
}

function broadcastSnapshot(snapshot: ThemeSnapshot, syncStatus: string) {
  notifyControls({
    themeCode: snapshot.themeCode,
    status: "stateSnapshot",
    data: { snapshot, syncStatus },
  });
  const appSocketId = themeToAppSocket.get(snapshot.themeCode);
  if (appSocketId) {
    emitToSocket(appSocketId, "app", "stateSnapshot", { snapshot, syncStatus });
  }
}

// ✅ “전부 stringify” 로그 (chatData 포함)
// - 순환참조 터지면 try/catch로 안전하게
// - chatData가 너무 길 때 파일 용량 폭증할 수 있어서 limit 옵션도 같이 둠
function safeStringify(v: any, maxLen = 2_000_000) {
  try {
    const s = JSON.stringify(
      v,
      (key, value) => {
        const normalizedKey = key.toLowerCase();
        if (
          normalizedKey === "pushtoken" ||
          normalizedKey === "token" ||
          normalizedKey === "authorization" ||
          normalizedKey === "password" ||
          normalizedKey === "secret"
        ) {
          return value ? "<REDACTED>" : value;
        }
        if (typeof value === "bigint") return value.toString();
        return value;
      },
      2
    );
    if (s.length > maxLen) return s.slice(0, maxLen) + "\n...<TRUNCATED>";
    return s;
  } catch (e) {
    return `<<JSON.stringify failed: ${(e as any)?.message ?? e}>>`;
  }
}

function logEventFull(label: string, obj: Record<string, any>) {
  console.log(`[${label}]\n${safeStringify(obj)}\n[END ${label}]`);
}

function emitToSocket(
  socketId: string,
  recipientType: ClientType,
  event: string,
  payload: any
) {
  logEventFull(`SOCKET OUT ${event}`, {
    to: socketId,
    recipientType,
    payload,
  });
  io.to(socketId).emit(event, payload);
}

function sendAck(
  socketId: string,
  event: string,
  ack: ((response: any) => void) | undefined,
  response: any
) {
  if (!ack) return;
  logEventFull(`SOCKET OUT ${event}:ack`, { to: socketId, response });
  ack(response);
}

// -----------------------------
// 유틸: 푸시 전송 (기존 그대로)
// -----------------------------
async function sendPushToTheme(
  themeCode: string,
  title: string,
  body: string,
  data: Record<string, any> = {}
): Promise<void> {
  const token = themeToPushToken.get(themeCode);
  if (!token) {
    console.log("❌ PushToken not found for themeCode:", themeCode);
    return;
  }
  if (!Expo.isExpoPushToken(token)) {
    console.log("Invalid Expo push token:", { themeCode });
    return;
  }

  try {
    logEventFull("PUSH OUT notification", {
      themeCode,
      title,
      body,
      data,
      hasToken: true,
    });
    const tickets = await expo.sendPushNotificationsAsync([
      {
        to: token,
        sound: "default",
        title,
        body,
        data,
        channelId: "chat-messages-v2",
        priority: "high" as const,
      },
    ]);
    console.log("✅ Push tickets:", tickets);
  } catch (err) {
    console.log("❌ Push send error:", err);
  }
}

// -----------------------------
// 라우트
// -----------------------------
app.get("/", (_req: Request, res: Response) => {
  res.send("✅ 소켓+푸시 서버 실행 중입니다!");
});

app.get(
  "/who",
  asyncHandler(async (_req, res) => {
    const all = Array.from(clients.values()).map((c) => ({
      socketId: c.socketId,
      type: c.type,
      themeCode: c.themeCode ?? null,
      hasToken: !!c.pushToken,
      platform: c.platform ?? null,
      socketAlive: !!getSocketById(c.socketId),
    }));

    const tokens = Array.from(themeToPushToken.entries()).map(([t, v]) => ({
      themeCode: t,
      token: v,
    }));

    res.json({ clients: all, tokens });
  })
);

app.get(
  "/push/test",
  asyncHandler(async (req, res) => {
    const themeCode = String(req.query.theme ?? "");
    if (!themeCode) {
      res.status(400).json({ ok: false, error: "theme required" });
      return;
    }

    await sendPushToTheme(themeCode, "테스트 알림", `테마 ${themeCode} 테스트`, {
      kind: "test",
      ts: Date.now(),
    });

    res.json({ ok: true });
  })
);

// -----------------------------
// 주기적 청소: 맵엔 있는데 실제 소켓이 없으면 제거(좀비 엔트리 청소)
// -----------------------------
setInterval(() => {
  for (const [id, info] of clients.entries()) {
    if (!getSocketById(id)) {
      console.log("🧹 stale client entry removed:", {
        socketId: id,
        type: info.type,
        themeCode: info.themeCode ?? null,
      });

      if (info.type === "app" && info.themeCode) {
        if (themeToAppSocket.get(info.themeCode) === id) {
          themeToAppSocket.delete(info.themeCode);
        }
      }
      clients.delete(id);
    }
  }
}, 30_000);

// -----------------------------
// 소켓 핸들러
// -----------------------------
io.on("connection", (socket: Socket) => {
  logEventFull("SOCKET CONNECT", {
    socketId: socket.id,
    address: socket.handshake.address,
    transport: socket.conn.transport.name,
  });

  socket.onAny((event, ...args) => {
    const sender = clients.get(socket.id);
    const payloads = args.filter((value) => typeof value !== "function");
    logEventFull(`SOCKET IN ${event}`, {
      from: socket.id,
      senderType: sender?.type ?? "unregistered",
      themeCode: sender?.themeCode ?? null,
      payload: payloads.length === 1 ? payloads[0] : payloads,
    });
  });

  socket.on(
    "register",
    ({
      type,
      themeCode,
      pushToken,
      platform,
      deviceId,
    }: {
      type: ClientType;
      themeCode?: string;
      pushToken?: string;
      platform?: "android" | "ios";
      deviceId?: string;
    }, ack?: (response: any) => void) => {
      // ✅ app은 themeCode 필수 취급
      if (type === "app" && !themeCode) {
        console.log("❌ register rejected: app missing themeCode", socket.id);
        sendAck(socket.id, "register", ack, {
          status: "rejected",
          reason: "appMissingThemeCode",
        });
        return;
      }

      // ✅ 동일 themeCode app이 이미 있으면 "진짜로" 끊어버림(좀비 차단 핵심)
      if (type === "app" && themeCode) {
        const prevId = themeToAppSocket.get(themeCode);
        if (prevId && prevId !== socket.id) {
          forceDisconnect(prevId, `replaced by new app (${themeCode})`);
        }
      }

      const info: ClientInfo = {
        socketId: socket.id,
        type,
        themeCode: type === "app" ? themeCode : undefined,
        pushToken: type === "app" ? pushToken : undefined,
        platform: type === "app" ? platform : undefined,
        deviceId: type === "app" ? deviceId : undefined,
      };

      clients.set(socket.id, info);

      if (type === "app" && themeCode) {
        themeToAppSocket.set(themeCode, socket.id);

        if (pushToken) {
          themeToPushToken.set(themeCode, pushToken);
          persistPushTokens(themeToPushToken);
          console.log("Push token stored:", { themeCode, hasToken: true });
        }

        notifyControls({ themeCode, status: "appConnected", data: null });
        console.log("🔔 Notified control: appConnected", { themeCode });
      }

      if (type === "control") {
        const connectedThemes = Array.from(clients.values())
          .filter((c) => c.type === "app" && c.themeCode)
          .map((c) => ({
            themeCode: c.themeCode!,
            hasToken: !!c.pushToken,
          }));

        emitToSocket(socket.id, "control", "status", {
          themeCode: null,
          status: "initialAppConnections",
          data: connectedThemes,
        });

        emitToSocket(socket.id, "control", "status", {
          themeCode: null,
          status: "initialSnapshots",
          data: getAllThemeSnapshots(),
        });

        console.log("📤 Sent to control: initialAppConnections", {
          count: connectedThemes.length,
          themes: connectedThemes.map(
            (x) => `${x.themeCode}:${x.hasToken ? "T" : "-"}`
          ),
        });
      }

      console.log("✅ Registered:", {
        socketId: socket.id,
        type,
        themeCode: themeCode ?? null,
        hasToken: !!pushToken,
        platform: platform ?? null,
      });
      sendAck(socket.id, "register", ack, {
        status: "registered",
        serverTime: Date.now(),
        snapshot: themeCode ? getThemeSnapshot(themeCode) : null,
      });
    }
  );

  // ✅ toApp는 control만 허용
  // V2 control bootstrap: only fills themes that do not exist yet.
  socket.on("seedState", (payload: ClientSnapshot, ack?: (response: any) => void) => {
    const sender = clients.get(socket.id);
    if (!sender || sender.type !== "control" || !payload?.themeCode) {
      sendAck(socket.id, "seedState", ack, { status: "rejected" });
      return;
    }
    const snapshot = seedThemeSnapshot(payload);
    broadcastSnapshot(snapshot, "seeded");
    sendAck(socket.id, "seedState", ack, { status: "seeded", snapshot });
  });

  // V2 reconnect reconciliation. Delayed reset commands are never replayed.
  socket.on("appSync", (payload: ClientSnapshot, ack?: (response: any) => void) => {
    const sender = clients.get(socket.id);
    if (!sender || sender.type !== "app" || !sender.themeCode) {
      sendAck(socket.id, "appSync", ack, { status: "rejected" });
      return;
    }
    const result = reconcileAppSnapshot({ ...payload, themeCode: sender.themeCode });
    broadcastSnapshot(result.snapshot, result.status);
    sendAck(socket.id, "appSync", ack, { ...result, serverTime: Date.now() });
  });

  // V2 authoritative state changes. Commit first, broadcast second, ACK last.
  socket.on(
    "stateAction",
    (
      payload: { themeCode?: string; requestId: string; action: StateAction },
      ack?: (response: any) => void
    ) => {
      const sender = clients.get(socket.id);
      if (!sender || !payload?.requestId || !payload?.action) {
        sendAck(socket.id, "stateAction", ack, { status: "rejected" });
        return;
      }
      const themeCode = sender.type === "app" ? sender.themeCode : payload.themeCode;
      if (!themeCode) {
        sendAck(socket.id, "stateAction", ack, { status: "rejected" });
        return;
      }
      const result = applyAction(themeCode, payload.requestId, payload.action);
      if (result.snapshot && result.status !== "alreadyApplied") {
        broadcastSnapshot(result.snapshot, result.status);
      }
      sendAck(socket.id, "stateAction", ack, {
        ...result,
        appOnline: themeToAppSocket.has(themeCode),
      });

      if (payload.action.type === "appendChat" && sender.type === "control") {
        const message = payload.action.message;
        void sendPushToTheme(themeCode, " ", String(message.data || " "), {
          kind: "chat",
          message: message.data || "",
          ts: Date.now(),
        });
      }
    }
  );

  socket.on(
    "toApp",
    async ({
      themeCode,
      command,
      data,
      pushTitle,
      pushBody,
      push = true,
    }: {
      themeCode: string;
      command: string;
      data?: any;
      pushTitle?: string;
      pushBody?: string;
      push?: boolean;
    }) => {
      const sender = clients.get(socket.id);
      if (!sender || sender.type !== "control") {
        console.log("🚫 toApp blocked (not control):", socket.id);
        return;
      }

      // ✅ 대표 app 1개만 전송
      const appSocketId = themeToAppSocket.get(themeCode);
      if (appSocketId) {
        emitToSocket(appSocketId, "app", "command", { command, data });
        console.log("📡 toApp sent:", { themeCode, command, to: appSocketId });
      } else {
        console.log("⚠️ toApp: no connected app", { themeCode, command });
      }

      // ✅ push 로직은 그대로 유지
      if (push && command === "changeChat") {
        try {
          const title = pushTitle ?? " ";
          const last = data?.chatData?.[data.chatData.length - 1];
          const body = last?.data ?? pushBody ?? " ";
          await sendPushToTheme(themeCode, title, body, {
            kind: "command",
            command,
            data: data ?? null,
            ts: Date.now(),
          });
          console.log("📨 Push sent:", { themeCode, command });
        } catch (e) {
          console.log("push error:", e);
        }
      }
    }
  );

  // ✅ toControl은 app만 허용 + themeCode는 sender 기준으로 강제(위조 차단)
  socket.on(
    "toControl",
    (payload: { themeCode?: string; status: string; data: any }) => {
      const sender = clients.get(socket.id);
      if (!sender || sender.type !== "app" || !sender.themeCode) {
        console.log("🚫 toControl blocked (not registered app):", socket.id);
        return;
      }

      const themeCode = sender.themeCode; // ✅ payload 무시하고 sender로 고정
      const status = payload?.status;
      const data = payload?.data;

      notifyControls({ themeCode, status, data });

      console.log("📡 toControl forwarded:", { themeCode, status });
    }
  );

  socket.on("disconnect", (reason) => {
    const info = clients.get(socket.id);

    logEventFull("SOCKET DISCONNECT", {
      socketId: socket.id,
      type: info?.type ?? "untracked",
      themeCode: info?.themeCode ?? null,
      reason,
    });

    if (!info) {
      console.log("❌ Disconnected (untracked):", { socketId: socket.id, reason });
      return;
    }

    const { type, themeCode } = info;

    if (type === "app" && themeCode) {
      if (themeToAppSocket.get(themeCode) === socket.id) {
        themeToAppSocket.delete(themeCode);
      }
      notifyControls({ themeCode, status: "appDisconnected", data: { reason } });
      console.log("⚠️ Notified control: appDisconnected", { themeCode, reason });
    }

    clients.delete(socket.id);
    console.log("❌ Disconnected:", {
      socketId: socket.id,
      type,
      themeCode: themeCode ?? null,
      reason,
    });
  });
});

// -----------------------------
// 실행
// -----------------------------
const PORT = Number(process.env.PORT || 3000);
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Socket 서버 실행:", { url: `http://localhost:${PORT}` });
});
