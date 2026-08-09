#!/usr/bin/env python3
"""Generates the small malicious/tampered ZIP fixtures used by
bundle-install.test.ts. Not run automatically (no Python dependency at test
time) — the resulting .zip files are committed as binary fixtures. Re-run
this manually if a fixture needs to change:

    python3 apps/desktop-client/electron/__tests__/fixtures/generate.py

`valid-bundle.zip` intentionally stays a real Bundle produced BEFORE D-060
(`included_assets[]` has no `asset_version_id` key at all) — it is the
regression fixture for the backward-compatibility path (legacy Bundle ->
InstalledAsset.assetVersionId === null, never falls back to assetId).

`valid-bundle-with-version-id.zip` is a real Bundle produced AFTER the D-060
fix (via `distribution_service.bundler` directly, same stage machine
`POST /bundle/v1/jobs` runs) whose Knowledge/root Service items carry an
`asset_version_id` deliberately different from `asset_id` — the regression
fixture for the fixed path (InstalledAsset.assetVersionId === the
AssetVersion id, distinct from assetId). Not reproducible by this script;
built once by a throwaway scratchpad script during the D-060 fix and copied
in as a binary fixture, same as valid-bundle.zip originally was.
"""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REAL_BUNDLE = os.path.join(
    HERE, "..", "..", "..", "..", "..",
    "b2-real-bundle-placeholder",  # replaced below if a real bundle path is passed
)


def write_minimal(path: str, extra_entries: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("bundle-manifest.yaml", "bundle_id: test\n")
        zf.writestr("checksums.sha256", "")
        for name, data in extra_entries.items():
            zf.writestr(name, data)


def make_zip_slip(path: str) -> None:
    write_minimal(path, {"../../evil.txt": b"pwned"})


def make_absolute_path(path: str) -> None:
    write_minimal(path, {"/etc/passwd": b"pwned"})


def make_zip_bomb(path: str) -> None:
    # 20MB of zeros compresses to a tiny fraction of that under DEFLATE —
    # comfortably trips the compression-ratio zip-bomb guard (>200x) without
    # needing a large fixture file on disk.
    bomb = bytes(20 * 1024 * 1024)
    write_minimal(path, {"bomb.bin": bomb})


def make_tampered_checksum(source_zip: str, dest_zip: str, target_entry_suffix: str) -> None:
    with zipfile.ZipFile(source_zip, "r") as src:
        names = src.namelist()
        target = next(n for n in names if n.endswith(target_entry_suffix))
        with zipfile.ZipFile(dest_zip, "w", zipfile.ZIP_DEFLATED) as dst:
            for info in src.infolist():
                data = src.read(info.filename)
                if info.filename == target:
                    # Flip a byte in the middle of the file's content. The
                    # checksums.sha256 entry (copied verbatim) still declares
                    # the ORIGINAL hash, so this simulates transit corruption
                    # or tampering.
                    data = bytearray(data)
                    mid = len(data) // 2
                    data[mid] ^= 0xFF
                    data = bytes(data)
                dst.writestr(info.filename, data)


if __name__ == "__main__":
    import sys

    make_zip_slip(os.path.join(HERE, "zip-slip.zip"))
    make_absolute_path(os.path.join(HERE, "absolute-path.zip"))
    make_zip_bomb(os.path.join(HERE, "zip-bomb.zip"))

    if len(sys.argv) > 1:
        real_bundle_path = sys.argv[1]
        make_tampered_checksum(
            real_bundle_path,
            os.path.join(HERE, "tampered-checksum.zip"),
            "source/remote-work-policy.md",
        )
        import shutil

        shutil.copyfile(real_bundle_path, os.path.join(HERE, "valid-bundle.zip"))
        print("Generated all fixtures including tampered-checksum.zip / valid-bundle.zip")
    else:
        print("Generated zip-slip/absolute-path/zip-bomb fixtures. Pass a real bundle path")
        print("as argv[1] to also generate tampered-checksum.zip and valid-bundle.zip.")
