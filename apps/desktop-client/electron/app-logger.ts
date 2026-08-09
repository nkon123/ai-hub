// D11 로그/진단의 로그 소스. 이 파일이 만드는 것이 Desktop이 가진 유일한
// 영속 로그다 — 지금까지는 어디에도 기록되지 않았다(main.ts는 IPC 처리
// 실패를 호출자에게만 반환했다).
//
// 설계상 핵심 결정: 로그 SOURCE 자체를 최소한으로 유지한다. 호출자
// (`main.ts`)는 사용자가 입력한 질문, 문서 내용, DB 조회 결과, Bundle
// Manifest의 자유 텍스트(name 등)를 절대 `message`에 넣지 않고 — id·버전·
// 단계 이름·개수·상태 코드 같은 구조적 정보만 기록한다. CLAUDE.md 코드
// 규칙("Log에 Prompt 원문, 문서 전체, DB 결과, Secret을 기본 저장하지
// 않는다")을 "일단 다 적고 나중에 지운다"가 아니라 애초에 쓰지 않는 방식으로
// 지킨다. `log-sanitizer.ts`의 마스킹은 그럼에도 로그 문자열에 원치 않게
// 섞여 들어갈 수 있는 값(예: 에러 메시지에 실려 온 파일 경로)에 대한
// 이중 방어선이다 — D11 진단 Bundle 생성 시점에 항상 한 번 더 적용된다.
import fs from "node:fs";
import path from "node:path";
import type { LogEntry, LogLevel } from "./types";

function isValidLogEntry(v: unknown): v is LogEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.timestamp === "string" && typeof e.level === "string" && typeof e.module === "string" && typeof e.message === "string";
}

export class AppLogger {
  private readonly filePath: string;

  constructor(stateDir: string) {
    const logsDir = path.join(stateDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    this.filePath = path.join(logsDir, "app.log");
  }

  log(entry: Omit<LogEntry, "timestamp">): void {
    const full: LogEntry = { timestamp: new Date().toISOString(), ...entry };
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(full)}\n`, "utf-8");
    } catch {
      // 로그 기록 실패가 실제 기능(설치/제거/연결 확인)을 막아서는 안 된다
      // (CLAUDE.md: Desktop은 장애 시 종료되지 않는다) — 조용히 무시한다.
    }
  }

  info(module: string, message: string, extra: Partial<Pick<LogEntry, "runId" | "traceId" | "errorCode">> = {}): void {
    this.log({ level: "INFO", module, message, ...extra });
  }

  warn(module: string, message: string, extra: Partial<Pick<LogEntry, "runId" | "traceId" | "errorCode">> = {}): void {
    this.log({ level: "WARN", module, message, ...extra });
  }

  error(module: string, message: string, extra: Partial<Pick<LogEntry, "runId" | "traceId" | "errorCode">> = {}): void {
    this.log({ level: "ERROR", module, message, ...extra });
  }

  /** Every line that parses as a well-formed `LogEntry` — a malformed line
   * (partial write, disk corruption) is skipped rather than aborting the
   * whole read (same "장애 시 종료되지 않는다" principle as `log()` above). */
  readAll(): LogEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = fs.readFileSync(this.filePath, "utf-8");
    const entries: LogEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (isValidLogEntry(parsed)) entries.push(parsed);
      } catch {
        // skip
      }
    }
    return entries;
  }
}

export const KNOWN_LOG_LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];
