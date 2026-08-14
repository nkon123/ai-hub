// 대화 답변의 Markdown 표시 (`react-markdown` + `remark-gfm`).
//
// 의존성을 쓰는 이유(루트 CLAUDE.md: "새 의존성을 추가할 때 이유와 폐쇄망
// 설치 방법을 문서화한다"): 모델 답변은 표·중첩 목록·인용문까지 자유롭게
// 쓰므로 부분집합 파서로는 계속 새는 곳이 생긴다. CommonMark + GFM을 제대로
// 구현한 것을 쓰는 편이 정확하고, 폐쇄망 설치 절차는
// `docs/implementation-spec/13-windows-local-setup.md` §2.6에 적었다.
//
// ── 이 파일이 지켜야 하는 두 가지 안전 규칙 ──────────────────────────────
//
// 1. **raw HTML을 절대 켜지 않는다.** 여기서 렌더링하는 것은 LLM이 만든
//    텍스트다. `react-markdown`은 기본적으로 HTML을 문자열로 이스케이프하지만,
//    `rehype-raw`를 추가하는 순간 그 보호가 사라진다 — 이 파일에 그 플러그인을
//    넣지 않는다.
// 2. **링크를 이동 가능한 앵커로 만들지 않는다.** Electron 렌더러에서 링크를
//    그대로 열면 SPA 문서 자체가 대체돼 앱이 사라진다(뒤로 가기도 없다).
//    외부 URL 열기 기능을 새로 만드는 것도 루트 CLAUDE.md가 금지한다("승인되지
//    않은 ... 외부 URL ... 기능을 만들지 않는다"). 그래서 `a`는 텍스트와 주소를
//    보여주기만 하고 클릭 대상이 되지 않는다 — 정보는 남기되 이동은 없다.

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 답변 텍스트를 서식과 함께 보여준다. 빈 문자열이면 아무것도 그리지 않는다
 * — "답변이 없습니다" 같은 문구는 호출부가 상태에 맞게 정한다. */
export function AnswerMarkdown({ source }: { source: string }) {
  if (!source) return null;
  return (
    <div className="min-w-0 space-y-2 text-body leading-relaxed">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 답변 안의 제목은 문서 구조가 아니라 본문 강조다 — 화면 자체의
          // 제목 계층(`h1`)과 경쟁하지 않도록 시맨틱 heading을 쓰지 않는다.
          h1: ({ children }) => <p className="mt-3 text-card-title font-semibold first:mt-0">{children}</p>,
          h2: ({ children }) => <p className="mt-3 font-semibold first:mt-0">{children}</p>,
          h3: ({ children }) => (
            <p className="mt-2 font-semibold text-text-secondary first:mt-0">{children}</p>
          ),
          h4: ({ children }) => (
            <p className="mt-2 font-semibold text-text-secondary first:mt-0">{children}</p>
          ),
          p: ({ children }) => <p className="mt-2 first:mt-0">{children}</p>,
          ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5 first:mt-0">{children}</ul>,
          ol: ({ children }) => (
            <ol className="mt-2 list-decimal space-y-1 pl-5 first:mt-0">{children}</ol>
          ),
          li: ({ children }) => <li className="[&>p]:mt-0">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
          blockquote: ({ children }) => (
            <blockquote className="mt-2 border-l-2 border-border pl-3 text-text-secondary first:mt-0">
              {children}
            </blockquote>
          ),
          code: ({ className, children }) => {
            // fenced code block 은 부모가 <pre> 이고 language 클래스가 붙는다.
            // 인라인 코드와 시각적으로 구분해야 읽힌다.
            const isBlock = typeof className === "string" && className.includes("language-");
            if (isBlock) return <code className="font-mono text-[12px]">{children}</code>;
            return (
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.9em] text-text-primary">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 leading-relaxed text-slate-50 first:mt-0">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="mt-2 overflow-x-auto first:mt-0">
              <table className="w-full border-collapse text-caption">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border bg-slate-50 px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
          hr: () => <hr className="my-3 border-border" />,
          // 이동하지 않는 링크 — 위 규칙 2 참고. 주소를 잃지 않도록 함께
          // 보여주고, 사용자가 필요하면 직접 복사할 수 있게 한다.
          a: ({ href, children }) => (
            <span className="text-text-primary underline decoration-dotted underline-offset-2">
              {children}
              {href ? <span className="ml-1 text-caption text-text-muted">({href})</span> : null}
            </span>
          ),
          img: ({ alt }) => (
            // 폐쇄망 클라이언트에서 원격 이미지를 불러오지 않는다 — 대체
            // 텍스트만 남긴다.
            <span className="text-caption text-text-muted">[이미지{alt ? `: ${alt}` : ""}]</span>
          ),
        }}
      >
        {source}
      </Markdown>
    </div>
  );
}
