// D11 로그/진단 — "실제 Prompt·문서·DB 결과·Secret은 제외"를 실제로 강제하는
// 유일한 지점. 순수 함수(fs/네트워크 없음) — 진단 Bundle에 들어가는 모든
// 문자열 필드는 반드시 이 함수를 거친다(`diagnostic-bundle.ts`).
//
// 새 패턴 집합을 발명하지 않고, Python 쪽에 이미 있는 두 정책을 그대로
// 옮긴다(CLAUDE.md 구현 원칙 3 — 다만 Python↔TypeScript 사이에는 코드를 직접
// import할 방법이 없으므로 "같은 패턴을 미러링"하는 것이 이 언어 경계에서
// 할 수 있는 최선이다 — 두 사본이 갈라지지 않도록 이 파일과 정책 파일 양쪽에
// 서로를 가리키는 주석을 남긴다):
//   - `packages/security-policy/src/security_policy/redaction.py`
//     (`looks_like_secret`) — bearer token, api key, password/secret/token=,
//     URL에 박힌 자격증명, PEM 개인키 헤더.
//   - `packages/knowledge-packager/config/package-policy.yaml`의
//     `forbidden_content_patterns` — 위와 겹치는 Secret 패턴에 더해
//     macOS/Linux/Windows 홈 디렉터리 절대경로(빌드 호스트 사용자명 노출).
export interface SanitizePattern {
  id: string;
  regex: RegExp;
}

// 순서가 결과에 영향을 주지 않도록 각 패턴은 서로 겹치지 않는 문자열만
// 대상으로 한다 — 그래도 항상 전체 패턴을 다 적용한다(첫 매치에서 멈추지
// 않음).
export const LOG_SANITIZE_PATTERNS: SanitizePattern[] = [
  { id: "private_key_header", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: "bearer_token", regex: /bearer\s+[A-Za-z0-9\-_.]{16,}/gi },
  { id: "generic_api_key", regex: /api[_-]?key["'\s:=]+[A-Za-z0-9\-_]{16,}/gi },
  { id: "credential_assignment", regex: /(password|secret|token)\s*[=:]\s*[^\s"']{4,}/gi },
  // URL 권한부(authority)에 박힌 자격증명 — https://user:pass@host
  { id: "url_embedded_credential", regex: /[a-z][a-z0-9+.\-]*:\/\/[^\s/@]+:[^\s/@]+@/gi },
  { id: "absolute_path_unix_users", regex: /\/Users\/[A-Za-z0-9_.\-]+/g },
  { id: "absolute_path_unix_home", regex: /\/home\/[A-Za-z0-9_.\-]+/g },
  { id: "absolute_path_windows_users", regex: /C:\\Users\\[A-Za-z0-9_.\-]+/g },
  // 아래 두 패턴은 Python 쪽 정책을 그대로 옮긴 것이 아니라, 이 모듈이 추가로
  // 책임지는 "Prompt 원문·문서 발췌·DB 결과는 제외"(CLAUDE.md)를 위한 것이다.
  // 임의의 자연어를 의미적으로 "이건 Prompt다/문서다"라고 판별할 방법은 없다
  // — 그래서 이 둘은 특정 업무 용어가 아니라 "로그 메시지에 외부 콘텐츠가
  // 그대로 끼워 넣어졌을 때 흔히 나타나는 구조적 모양"만 잡는다. 1차 방어선은
  // 항상 `app-logger.ts`가 문서화한 대로 "애초에 그런 내용을 message에 넣지
  // 않는다"이고, 이 두 패턴은 그 규칙이 지켜지지 않았을 때의 2차 방어선이다.
  // 과탐지(정상 메시지를 과도하게 마스킹)는 허용 가능한 실패 방향이지만
  // 미탐지(원문 유출)는 아니다.
  {
    // 로그 메시지에 외부 문자열을 가독성을 위해 인용부호로 감싸 끼워 넣는
    // 흔한 습관(예: `Prompt 전송 실패: "..."`)을 겨냥 — 30자 이상의 인용된
    // 구간은 개발자가 직접 작성한 진단 문구가 아니라 Prompt/질문/문서 발췌가
    // 그대로 흘러들어 왔을 가능성이 높다.
    id: "long_quoted_span",
    regex: /"[^"\n]{30,}"|'[^'\n]{30,}'/g,
  },
  {
    // "key=value, key=value, key=value" 형태로 3개 이상 이어지는 구간 —
    // DB 조회 결과 Row를 그대로 문자열화했을 때 나타나는 전형적인 모양.
    // 특정 컬럼명(예: ssn, salary)을 하드코딩하지 않아 어떤 업무 데이터에도
    // 동일하게 적용된다.
    id: "structured_record_dump",
    regex: /\b[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^,\n]+(?:,\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^,\n]+){2,}/g,
  },
];

const PLACEHOLDER = "***REDACTED***";

/** Replaces every matched span (not the whole string) with a placeholder —
 * enough surrounding context survives for the log line to stay diagnostic,
 * while the sensitive substring itself never appears in the output. Applied
 * to every log message and every "Sanitized 설정" value before either is
 * allowed into a diagnostic Bundle. */
export function sanitizeText(text: string): string {
  let result = text;
  for (const { regex } of LOG_SANITIZE_PATTERNS) {
    result = result.replace(regex, PLACEHOLDER);
  }
  return result;
}

export function looksSensitive(text: string): boolean {
  return LOG_SANITIZE_PATTERNS.some(({ regex }) => new RegExp(regex.source, regex.flags).test(text));
}
