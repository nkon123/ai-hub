/**
 * P05 자산 등록 Wizard — 유형별 예시 Manifest/파일 제공 (GET
 * /assets/new/{type}/examples).
 *
 * 실 사용자 피드백("어떤 파일을 등록하라는건지 모르겠어, 예시 파일을
 * 넣어두고 짧은 주석 예제도 넣어줘")에 대한 응답. 새 예시 JSON을 손으로
 * 작성하지 않는다 — 스키마와 어긋나면 조용히 사용자를 잘못된 방향으로
 * 안내하게 되므로, 이미 스키마를 통과하는 실제 `fixtures/valid/*`를 그대로
 * 서버에서 읽어 돌려준다. 어떤 fixture가 어떤 유형의 예시인지는
 * `fixtures/wizard-examples-index.json` 한 곳에서만 정의하며, 같은 파일을
 * `tests/contract/test_wizard_examples.py`가 읽어 "이 화면이 보여주는 예시가
 * 실제로 검증을 통과하는가"를 테스트한다 — 두 목록이 따로 놀며 어긋날 수
 * 없다.
 *
 * 유일한 변형은 `id`를 새 UUID로 바꾸는 것뿐이다(여러 사용자가 예시를 그대로
 * 눌러 채우면 동일 asset id 충돌이 생기므로) — 그 외 필드는 절대 손으로
 * 다시 쓰지 않는다. `manifest_hash`/`created_at`은 두 스키마 모두 optional이며
 * 서버가 채우는 값이라 fixture의 placeholder 그대로 보여주면 "내가 이 해시를
 * 계산해야 하나?"라는 새 혼란을 주므로 제거한다.
 */
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";

type WizardType = "agent" | "prompt" | "mcp_tool";

const WIZARD_TYPES: WizardType[] = ["agent", "prompt", "mcp_tool"];

// apps/portal-web is `next dev`'s cwd — repo root is two levels up.
const FIXTURES_ROOT = path.resolve(process.cwd(), "..", "..", "fixtures");
const INDEX_PATH = path.join(FIXTURES_ROOT, "wizard-examples-index.json");

interface IndexEntry {
  sourceFixture: string;
  manifest: string;
  companionFiles: string[];
}

export async function GET(_req: Request, { params }: { params: { type: string } }) {
  const type = params.type;
  if (!WIZARD_TYPES.includes(type as WizardType)) {
    return NextResponse.json(
      { error: { code: "UNSUPPORTED_TYPE", message: `예시가 없는 유형입니다: ${type}` } },
      { status: 404 },
    );
  }

  try {
    const indexRaw = await readFile(INDEX_PATH, "utf-8");
    const index = JSON.parse(indexRaw) as Record<WizardType, IndexEntry>;
    const entry = index[type as WizardType];

    const manifestRaw = await readFile(path.join(FIXTURES_ROOT, entry.manifest), "utf-8");
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;

    // Only transform: fresh id, drop server-computed placeholder fields.
    manifest.id = randomUUID();
    delete manifest.manifest_hash;
    delete manifest.created_at;

    const companionFiles = await Promise.all(
      entry.companionFiles.map(async (relPath) => ({
        name: path.basename(relPath),
        content: await readFile(path.join(FIXTURES_ROOT, relPath), "utf-8"),
      })),
    );

    return NextResponse.json({
      sourceFixture: entry.sourceFixture,
      manifest,
      companionFiles,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: {
          code: "EXAMPLE_UNAVAILABLE",
          message: "예시를 불러오지 못했습니다. fixtures 디렉터리를 확인해 주세요.",
          details: { reason: e instanceof Error ? e.message : String(e) },
        },
      },
      { status: 500 },
    );
  }
}
