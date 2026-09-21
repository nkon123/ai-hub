/**
 * P05 자산 등록 Wizard — 유형별 개발 가이드 원문 제공 (GET /assets/new/{type}/guide).
 *
 * MCP 서버를 처음 만드는 사람이 등록 화면에서 "무엇을 지켜야 통과하는가"를 바로 볼 수
 * 있어야 한다. 지금까지는 화면이 `docs/...` 경로를 문자열로만 보여줬는데, 폐쇄망 PC 에서
 * 저장소를 받아 두지 않은 사람에게는 그 경로가 아무것도 아니다.
 *
 * `examples/route.ts` 와 같은 방식으로 **저장소의 실제 파일을 그대로 읽어** 돌려준다.
 * 화면용으로 요약본을 따로 두면 문서와 화면이 조용히 갈라진다 — 지켜야 할 값(확장자
 * 목록, 크기 한도, 정규식)이 갈라지면 화면을 믿은 사람이 등록에서 거부된다.
 *
 * 마크다운을 렌더링하지 않고 원문 그대로 내보낸다. 렌더러를 넣으려면 새 의존성과
 * 폐쇄망 설치 절차가 따라오는데(CLAUDE.md 코드 규칙), 이 문서의 용도는 읽는 것보다
 * **AI 코딩 도구에 붙여넣는 것**이라 원문이 오히려 맞다.
 */
import { readFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";

/** 가이드가 있는 유형만. 없는 유형은 404 로 분명히 알린다. */
const GUIDE_BY_TYPE: Record<string, string> = {
  mcp_server: "docs/mcp-server-authoring-prompt.md",
};

// apps/portal-web is `next dev`'s cwd — repo root is two levels up.
const REPO_ROOT = path.resolve(process.cwd(), "..", "..");

export async function GET(_req: Request, { params }: { params: { type: string } }) {
  const relative = GUIDE_BY_TYPE[params.type];
  if (!relative) {
    return NextResponse.json(
      {
        error: {
          code: "GUIDE_NOT_AVAILABLE",
          message: `개발 가이드가 아직 없는 유형입니다: ${params.type}`,
        },
      },
      { status: 404 },
    );
  }

  try {
    const markdown = await readFile(path.join(REPO_ROOT, relative), "utf-8");
    return NextResponse.json({ path: relative, markdown });
  } catch (err) {
    // 경로는 저장소 상수라 사용자 입력이 섞이지 않는다 — 그대로 보여줘도 안전하고,
    // 문서가 빠진 배포에서 무엇이 없는지 알 수 있어야 한다.
    console.error(`[guide] failed to read ${relative}`, err);
    return NextResponse.json(
      {
        error: {
          code: "GUIDE_READ_FAILED",
          message: `개발 가이드 파일을 읽지 못했습니다: ${relative}`,
        },
      },
      { status: 500 },
    );
  }
}
