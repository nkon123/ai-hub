<#
.SYNOPSIS
    portal-api DB(SQLite, portal.db) 스키마를 최신 마이그레이션까지
    적용한다.

.DESCRIPTION
    apps/portal-api 에서 `alembic upgrade head` 를 실행한다.
    새로 반입한 저장소에서 처음 기동하기 전, 또는
    코드 업데이트 후 모델 컬럼이 추가됐을 때 실행한다
    (docs/implementation-spec/progress-log.md "스키마 변경 절차",
    project_no_db_migrations 메모 참고 — 이 프로젝트는 수동 ALTER TABLE
    대신 Alembic을 사용한다).
#>

. "$PSScriptRoot\_python.ps1"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location (Join-Path $RepoRoot "apps\portal-api")

Invoke-Py -m alembic upgrade head
