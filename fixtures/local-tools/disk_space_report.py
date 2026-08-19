"""이 PC 의 디스크 여유 공간을 Markdown 보고서로 만든다 — 스케줄 데모용.

Desktop 로컬 Tool(D-084) 샘플. "매일 9시" 같은 스케줄에 걸어 두고 이력에
쌓인 보고서를 나중에 확인하는 흐름을 보여주려고 만들었다. 표준 라이브러리
(`shutil`/`platform`)만 쓰고 네트워크에 접근하지 않으며, 읽기 전용이다.
"""

import platform
import shutil


def disk_space_report(paths: list[str], warn_below_percent: float = 15.0) -> str:
    """주어진 경로들의 디스크 여유 공간을 Markdown 표로 돌려준다.

    warn_below_percent 미만이면 경고 표시를 붙인다. 읽을 수 없는 경로는
    건너뛰지 않고 사유와 함께 표에 남긴다 — 조용히 빠지면 "확인했는데
    문제없음" 과 구분되지 않는다.
    """
    lines = [
        "## 디스크 여유 공간",
        "",
        f"- 호스트: {platform.node()} ({platform.system()})",
        "",
        "| 경로 | 전체 | 사용 | 여유 | 여유율 | 상태 |",
        "| --- | --- | --- | --- | --- | --- |",
    ]

    def human(num_bytes: int) -> str:
        size = float(num_bytes)
        for unit in ("B", "KB", "MB", "GB", "TB"):
            if size < 1024 or unit == "TB":
                return f"{size:.1f}{unit}"
            size /= 1024
        return f"{size:.1f}TB"

    warned = 0
    for path in paths:
        try:
            usage = shutil.disk_usage(path)
        except OSError as exc:
            lines.append(f"| {path} | - | - | - | - | 읽을 수 없음: {exc.__class__.__name__} |")
            continue
        percent_free = usage.free / usage.total * 100 if usage.total else 0.0
        low = percent_free < warn_below_percent
        if low:
            warned += 1
        lines.append(
            "| {} | {} | {} | {} | {:.1f}% | {} |".format(
                path, human(usage.total), human(usage.used), human(usage.free), percent_free,
                "⚠ 부족" if low else "정상",
            )
        )

    lines.append("")
    lines.append(f"경고 임계값 {warn_below_percent}% 미만 · 경고 {warned}건")
    return "\n".join(lines)
