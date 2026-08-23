import type { ExtensionAPI, ExtensionContext, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { hostname } from "node:os";

const require = createRequire(import.meta.url);
const runtime = require("./src/runtime.cjs") as {
  attach(pi: ExtensionAPI): void;
  notify(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    notification: { sessionId: string; cwd: string },
    title: string,
    body: string,
  ): Promise<void>;
};

const SEMANTIC_HOOK_CHANNEL = "pi:semantic-hook:v1";

interface SemanticHook {
  version: 1;
  name: string;
  values?: Record<string, string>;
}

function cleanHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
}

function cleanBody(value: unknown): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

function sessionInfo(ctx: ExtensionContext): { sessionId: string; cwd: string } {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
  };
}

function questionBody(event: ToolExecutionStartEvent, ctx: ExtensionContext): string {
  const args = event.args as Record<string, unknown> | undefined;
  const direct = args && typeof args.question === "string" ? args.question : undefined;
  const questions = args && Array.isArray(args.questions)
    ? args.questions
        .map((item) => {
          if (!item || typeof item !== "object") return "";
          const value = Reflect.get(item, "question") ?? Reflect.get(item, "prompt") ?? Reflect.get(item, "header");
          return typeof value === "string" ? value : "";
        })
        .filter(Boolean)
        .join("\n\n")
    : "";
  return cleanBody(direct || questions || `Pi needs your input in ${ctx.cwd}`);
}

function isSemanticHook(value: unknown): value is SemanticHook {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.name === "string";
}

export default function piNotifyTelegram(pi: ExtensionAPI): void {
  runtime.attach(pi);

  let liveContext: ExtensionContext | undefined;
  let unsubscribeBus: (() => void) | undefined;

  const send = async (ctx: ExtensionContext, title: string, body: string): Promise<void> => {
    try {
      await runtime.notify(pi, ctx, sessionInfo(ctx), cleanHeader(title), cleanBody(body));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[pi-notify-telegram] Notification failed: ${detail}\n`);
    }
  };

  const handleHook = (data: unknown): void => {
    if (!liveContext || !isSemanticHook(data)) return;
    const values = data.values ?? {};
    const host = hostname();
    const cwd = liveContext.cwd;

    if (data.name === "agent-notify" && typeof values.TITLE === "string" && typeof values.CONTENT === "string") {
      void send(liveContext, `🤖 ${values.TITLE} · ${host} · ${cwd}`, values.CONTENT);
      return;
    }
    if (data.name !== "user-ready") return;
    if (values.STOP_KIND === "AI_UNLOCK") {
      void send(liveContext, `🙋 Pi Done · ${host} · ${cwd}`, values.REASON || "Pi is ready for input");
    } else if (values.STOP_KIND === "EXHAUSTED") {
      void send(liveContext, `🛑 Pi Continue stopped · ${host} · ${cwd}`, "Continue watchdog retry limit reached");
    } else if (values.STOP_KIND === "DECISION_FAILED") {
      void send(liveContext, `⚠️ Pi Continue failed · ${host} · ${cwd}`, "Continue watchdog decision failed");
    }
  };

  pi.on("session_start", (_event, ctx) => {
    liveContext = ctx;
    if (!unsubscribeBus && pi.events && typeof pi.events.on === "function") {
      unsubscribeBus = pi.events.on(SEMANTIC_HOOK_CHANNEL, handleHook);
    }
  });

  pi.on("session_info_changed", (_event, ctx) => {
    liveContext = ctx;
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "ask_user_question") return;
    const host = hostname();
    void send(ctx, `❓ Pi Question · ${host} · ${ctx.cwd}`, questionBody(event, ctx));
  });

  pi.on("session_shutdown", () => {
    unsubscribeBus?.();
    unsubscribeBus = undefined;
    liveContext = undefined;
  });
}
