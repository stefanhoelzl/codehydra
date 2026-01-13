#!/usr/bin/env python3
"""CodeHydra launcher for PyPI - Downloads and caches the appropriate binary from GitHub Releases."""

import os
import platform
import stat
import subprocess
import sys
import zipfile
from importlib.metadata import version as get_version
from pathlib import Path
from urllib.request import Request, urlopen

REPO = "stefanhoelzl/codehydra"

ASSET_MAP = {
    ("Linux", "x86_64"): "CodeHydra-linux-x64.AppImage",
    ("Darwin", "x86_64"): "CodeHydra-darwin-x64.zip",
    ("Darwin", "arm64"): "CodeHydra-darwin-arm64.zip",
    ("Windows", "AMD64"): "CodeHydra-win-portable-x64.zip",
}


def get_cache_dir(pkg_version: str) -> Path:
    """Get the platform-specific cache directory."""
    system = platform.system()
    if system == "Linux":
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
        return base / "codehydra" / "releases" / pkg_version
    elif system == "Darwin":
        return Path.home() / "Library" / "Application Support" / "Codehydra" / "releases" / pkg_version
    elif system == "Windows":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        return base / "Codehydra" / "releases" / pkg_version
    raise RuntimeError(f"Unsupported platform: {system}")


def get_asset_name() -> str:
    """Get the GitHub release asset name for the current platform."""
    key = (platform.system(), platform.machine())
    asset = ASSET_MAP.get(key)
    if not asset:
        raise RuntimeError(f"Unsupported platform: {key[0]}-{key[1]}")
    return asset


def get_binary_path(cache_dir: Path, asset_name: str) -> Path:
    """Get the path to the executable binary."""
    system = platform.system()
    if system == "Windows":
        return cache_dir / "CodeHydra-win-portable-x64" / "CodeHydra.exe"
    elif system == "Darwin":
        app_name = asset_name.replace(".zip", "")
        return cache_dir / app_name / "CodeHydra.app" / "Contents" / "MacOS" / "CodeHydra"
    return cache_dir / asset_name


def download(url: str, dest_path: Path, pkg_version: str) -> None:
    """Download a file from URL to destination path."""
    tmp_path = dest_path.with_suffix(dest_path.suffix + ".tmp")
    request = Request(url, headers={"User-Agent": f"codehydra-pypi/{pkg_version}"})
    with urlopen(request) as response:
        with open(tmp_path, "wb") as f:
            while chunk := response.read(8192):
                f.write(chunk)
    tmp_path.rename(dest_path)


def main() -> None:
    """Main entry point for the launcher."""
    pkg_version = get_version("codehydra")
    cache_dir = get_cache_dir(pkg_version)
    asset_name = get_asset_name()
    binary_path = get_binary_path(cache_dir, asset_name)

    if not binary_path.exists():
        print(f"Downloading CodeHydra {pkg_version}...")
        cache_dir.mkdir(parents=True, exist_ok=True)

        download_url = f"https://github.com/{REPO}/releases/download/v{pkg_version}/{asset_name}"
        download_path = cache_dir / asset_name
        download(download_url, download_path, pkg_version)

        if asset_name.endswith(".zip"):
            print("Extracting...")
            with zipfile.ZipFile(download_path, "r") as zf:
                zf.extractall(cache_dir)
            download_path.unlink()

        if platform.system() != "Windows":
            binary_path.chmod(binary_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

        print("Done!\n")

    if platform.system() == "Windows":
        sys.exit(subprocess.run([str(binary_path)] + sys.argv[1:]).returncode)
    else:
        os.execv(str(binary_path), [str(binary_path)] + sys.argv[1:])


if __name__ == "__main__":
    main()
