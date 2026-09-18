"use client";

/**
 * MCP 자산 목록 — 좌측 Nav "자산 > MCP".
 *
 * 등록 단위가 D-094 에서 "Tool 하나"에서 "서버 하나"로 바뀌었지만 이전 방식으로
 * 만들어진 `mcp_tool` 자산이 남아 있다. 두 유형을 한 화면에 함께 보여준다 —
 * 유형을 나눠 두 메뉴로 만들면 사용자는 자기 자산이 어느 쪽에 있는지 알 수 없다.
 * 새 등록은 우상단 버튼이 가리키는 "MCP 서버" 방식만 권한다.
 */

import { AssetTypePage } from "../../_components/asset-type-page";

export default function McpAssetsPage() {
  return (
    <AssetTypePage
      title="MCP"
      description="사내·외부 시스템 기능을 제공하는 MCP 서버와 이전 방식으로 등록된 MCP Tool 목록입니다."
      types={["mcp_server", "mcp_tool"]}
      registerHref="/assets/new/mcp_server"
      registerLabel="MCP 서버 등록"
      emptyTitle="등록된 MCP 자산이 없습니다."
      emptyDescription="연결 방식(HTTP/STDIO)과 제공 Tool 목록을 준비해 첫 MCP 서버를 등록하세요."
      searchPlaceholder="MCP 자산 이름 검색..."
    />
  );
}
