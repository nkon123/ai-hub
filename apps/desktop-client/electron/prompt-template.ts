// 설치된 Prompt 자산(허브에서 받은 것)의 Manifest에서 "사람이 읽고 대화에
// 쓸 수 있는 것"만 추려내는 순수 함수들. fs/electron을 import하지 않는다 —
// 실제 파일 읽기는 `asset-management.ts::readPromptTemplate`(Main 전용)이
// 맡고, 이 파일은 그 결과를 어떻게 해석할지만 정한다(`bundle-verify.ts`가
// `bundle-install.ts`에 대해 갖는 관계와 같다).
//
// Prompt Manifest 계약은 `packages/schemas/manifests/prompt-manifest.schema.json`
// 이지만 이 저장소에는 아직 공용 TS 스키마 패키지가 없어 필드 이름만 참고해
// 로컬 타입으로 다시 적는다(`types.ts` 헤더의 같은 갭 설명 참고). 그래서
// 여기서는 **필드가 없거나 형이 다를 수 있다고 가정하고** 읽는다 — 설치된
// 자산은 이 앱이 만든 것이 아니다.

import path from "path";

export interface PromptVariableSummary {
  name: string;
  /** Manifest의 `variables[].type`. 모르는 값이면 그대로 둔다(표시용). */
  type: string;
  required: boolean;
  description: string | null;
}

/** Manifest에서 읽어낸, 화면에 보여줄 수 있는 Prompt 자산 요약. */
export interface PromptManifestSummary {
  /** Manifest의 `name` — 없으면 호출자가 설치 레코드의 이름을 쓴다. */
  name: string | null;
  version: string | null;
  description: string | null;
  /** `template.system` — 모델에게 주는 역할 지침. */
  system: string | null;
  /** `template.file` — 본문 파일 이름(자산 폴더 기준 상대 경로). */
  templateFile: string | null;
  variables: PromptVariableSummary[];
  tags: string[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Manifest(JSON.parse 결과 — 어떤 형태든 올 수 있다)에서 요약을 만든다.
 *
 * 객체가 아니거나 `type`이 `prompt`가 아니면 `null`을 돌려준다 — 다른 종류의
 * 자산 Manifest를 프롬프트로 보여주면 사용자는 고를 수 없는 것을 고르게 된다.
 */
export function summarizePromptManifest(manifest: unknown): PromptManifestSummary | null {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  const record = manifest as Record<string, unknown>;
  if (asString(record.type) !== "prompt") return null;

  const template =
    record.template && typeof record.template === "object" && !Array.isArray(record.template)
      ? (record.template as Record<string, unknown>)
      : {};

  const variables: PromptVariableSummary[] = Array.isArray(record.variables)
    ? record.variables.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const variable = entry as Record<string, unknown>;
        const name = asString(variable.name);
        if (!name) return [];
        return [
          {
            name,
            type: asString(variable.type) ?? "string",
            required: variable.required === true,
            description: asString(variable.description),
          },
        ];
      })
    : [];

  const tags = Array.isArray(record.tags)
    ? record.tags.flatMap((tag) => (asString(tag) ? [tag as string] : []))
    : [];

  return {
    name: asString(record.name),
    version: asString(record.version),
    description: asString(record.description),
    system: asString(template.system),
    templateFile: asString(template.file),
    variables,
    tags,
  };
}

/** 본문 파일의 절대 경로 — **반드시 자산 폴더 안쪽**일 때만 돌려준다.
 *
 * `templateFile`은 이 앱이 만든 값이 아니라 설치된 Manifest에 적혀 있던
 * 문자열이다. `../../`나 절대 경로가 들어 있으면 자산 폴더 밖의 파일을 읽게
 * 되므로 그 경우 `null`을 돌려준다(루트 CLAUDE.md: 사용자가 제공한 파일명으로
 * 파일 경로를 만들지 않는다 — agent-runtime의 `local_agent_registry`가 같은
 * 값에 대해 하는 `_is_contained` 검사와 같은 규칙).
 */
export function templatePathWithinAsset(assetDir: string, templateFile: string | null): string | null {
  if (!templateFile) return null;
  if (path.isAbsolute(templateFile)) return null;
  const base = path.resolve(assetDir);
  const resolved = path.resolve(base, templateFile);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}
