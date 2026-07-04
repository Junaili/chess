#!/usr/bin/env python3
from pathlib import Path
import argparse
import os
import signal
import subprocess
import tempfile
import time

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

WIDTH = 640
HEIGHT = 360
FPS = 5


def scene_offsets_for(duration_seconds: int) -> list[float]:
    return [
        0,
        duration_seconds * 0.16,
        duration_seconds * 0.32,
        duration_seconds * 0.48,
        duration_seconds * 0.64,
        duration_seconds * 0.8,
    ]


def frame_overrides(seconds: float, scene_offsets: list[float]) -> str:
    lines = [
        "html, body { width: 640px !important; height: 360px !important; }",
        ".trailer { width: 640px !important; height: 360px !important; min-height: 360px !important; }",
        f".trailer::before {{ animation-delay: {-seconds:.3f}s !important; }}",
    ]

    for index, base in enumerate(scene_offsets, start=1):
        delay = base - seconds
        scene = f".scene-{index}"
        lines.extend([
            f"{scene} {{ animation-delay: {delay:.3f}s !important; }}",
            f"{scene} .copy {{ animation-delay: {delay:.3f}s !important; }}",
            f"{scene} .mark {{ animation-delay: {delay:.3f}s !important; }}",
            f"{scene} .piece-fly {{ animation-delay: {delay:.3f}s !important; }}",
        ])

    chip_offsets = {}
    for scene_index, scene_start in enumerate(scene_offsets[:-1], start=1):
        chip_offsets[scene_index] = [
            scene_start + 0.18,
            scene_start + 0.34,
            scene_start + 0.5,
        ]
    for scene_index, offsets in chip_offsets.items():
        for chip_index, base in enumerate(offsets, start=1):
            delay = base - seconds
            lines.append(
                f".scene-{scene_index} .chip:nth-child({chip_index}) "
                f"{{ animation-delay: {delay:.3f}s !important; }}"
            )

    for selector, base in [
        (".scene-3 .phone", scene_offsets[2] + 0.2),
        (".scene-4 .phone", scene_offsets[3] + 0.2),
        (".scene-5 .phone", scene_offsets[4] + 0.2),
        (".scene-4 .video-bubbles", scene_offsets[3] + 0.35),
        (".scene-5 .analysis-card", scene_offsets[4] + 0.2),
    ]:
        lines.append(f"{selector} {{ animation-delay: {base - seconds:.3f}s !important; }}")

    return "<style>" + "\n".join(lines) + "</style>"


def capture_html_for(html_path: Path, seconds: float, scene_offsets: list[float], output_path: Path) -> None:
    html = html_path.read_text()
    html = html.replace("</head>", f"{frame_overrides(seconds, scene_offsets)}\n</head>")
    html = html.replace(
        "https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=Cormorant+Garamond:wght@700&display=swap",
        "",
    )
    output_path.write_text(html)


def capture_frame(frame_path: Path, capture_html: Path, user_data_dir: Path) -> None:
    cmd = [
        str(CHROME),
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--no-first-run",
        "--no-default-browser-check",
        f"--user-data-dir={user_data_dir}",
        f"--window-size={WIDTH},{HEIGHT}",
        "--force-device-scale-factor=1",
        f"--screenshot={frame_path}",
        capture_html.resolve().as_uri(),
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if frame_path.exists() and frame_path.stat().st_size > 0:
            break
        if proc.poll() is not None:
            break
        time.sleep(0.08)

    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=2)

    if not frame_path.exists() or frame_path.stat().st_size == 0:
        raise RuntimeError(f"Chrome did not capture {frame_path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--html", default=str(ROOT / "trailer.html"))
    parser.add_argument("--output", default=str(ROOT / "ethans-chess-trailer.gif"))
    parser.add_argument("--duration", type=int, default=20)
    parser.add_argument("--fps", type=int, default=FPS)
    args = parser.parse_args()

    html_path = Path(args.html)
    output_path = Path(args.output)
    duration_seconds = args.duration
    fps = args.fps
    scene_offsets = scene_offsets_for(duration_seconds)

    if not html_path.exists():
        raise SystemExit(f"Missing {html_path}")
    if not CHROME.exists():
        raise SystemExit(f"Missing Chrome at {CHROME}")

    frame_count = duration_seconds * fps
    frame_duration_ms = int(1000 / fps)

    with tempfile.TemporaryDirectory(prefix="ethans-chess-trailer-") as tmp:
        tmp_path = Path(tmp)
        frames_dir = tmp_path / "frames"
        user_data_dir = tmp_path / "chrome-profile"
        html_dir = tmp_path / "html"
        frames_dir.mkdir()
        html_dir.mkdir()

        png_paths = []
        for index in range(frame_count):
            frame_path = frames_dir / f"frame-{index:04d}.png"
            capture_html = html_dir / f"frame-{index:04d}.html"
            capture_html_for(html_path, index / fps, scene_offsets, capture_html)
            capture_frame(frame_path, capture_html, user_data_dir)
            png_paths.append(frame_path)
            if (index + 1) % fps == 0:
                print(f"captured {index + 1}/{frame_count} frames", flush=True)

        images = []
        for path in png_paths:
            image = Image.open(path).convert("RGB")
            image = image.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
            images.append(image)

        images[0].save(
            output_path,
            save_all=True,
            append_images=images[1:],
            duration=frame_duration_ms,
            loop=0,
            optimize=True,
        )

    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"wrote {output_path} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
