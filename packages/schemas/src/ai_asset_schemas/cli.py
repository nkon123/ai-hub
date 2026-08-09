"""validate-manifest CLI — validates AI Asset manifest files."""

from __future__ import annotations

import sys
from pathlib import Path

import click

from .validator import SchemaType, ValidationError, validate_file


@click.command()
@click.argument("path", type=click.Path(exists=True, path_type=Path))
@click.option("--type", "schema_type", type=click.Choice([t.value for t in SchemaType]),
              default=None, help="Schema type to validate against (auto-inferred if omitted)")
@click.option("--all", "validate_all", is_flag=True,
              help="Validate all JSON files in directory recursively")
def main(path: Path, schema_type: str | None, validate_all: bool) -> None:
    """Validate AI Asset manifest files against their schemas."""
    schema_type_enum = SchemaType(schema_type) if schema_type else None

    if validate_all or path.is_dir():
        files = list(path.rglob("*.json"))
        if not files:
            click.echo(f"No JSON files found in {path}")
            sys.exit(0)
        failed = 0
        for f in files:
            try:
                validate_file(f, schema_type_enum)
                click.echo(f"  PASS  {f.relative_to(path)}")
            except ValidationError as e:
                click.echo(f"  FAIL  {f.relative_to(path)}: {e}", err=True)
                failed += 1
            except Exception as e:
                click.echo(f"  ERROR {f.relative_to(path)}: {e}", err=True)
                failed += 1
        if failed:
            sys.exit(1)
    else:
        try:
            validate_file(path, schema_type_enum)
            click.echo(f"PASS: {path}")
        except ValidationError as e:
            click.echo(f"FAIL: {path}\n{e}", err=True)
            for err in e.errors[1:]:
                click.echo(f"  - {err}", err=True)
            sys.exit(1)
