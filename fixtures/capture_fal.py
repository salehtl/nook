"""Capture REAL fal responses into fixtures/fal/ (replaces the synthetic ones). Costs about $0.27.

  uv run --no-project --python 3.12 --with fal-client --with httpx python -I fixtures/capture_fal.py [image] [prompt]

Reads FAL_KEY from the environment or from .env at the repo root. Never prints the key.
"""
import json
import os
import shutil
import sys
from pathlib import Path
from urllib.parse import urlparse

import httpx

REPO = Path(__file__).resolve().parent.parent
FAL = Path(os.environ.get("NOOK_CAPTURE_OUT", REPO / "fixtures" / "fal"))
CALLS = {
    "sam-3-3d-objects": ("fal-ai/sam-3/3d-objects", lambda url, prompt: {"image_url": url, "prompt": prompt, "export_textured_glb": True}),
    "trellis-2": ("fal-ai/trellis-2", lambda url, prompt: {"image_url": url, "resolution": 512}),
}


def load_key():
    if os.environ.get("FAL_KEY"):
        return
    env = REPO / ".env"
    if env.is_file():
        for line in env.read_text().splitlines():
            if line.strip().startswith("FAL_KEY="):
                os.environ["FAL_KEY"] = line.split("=", 1)[1].strip().strip('"').strip("'")
                return
    sys.exit("FAL_KEY not set: add FAL_KEY=... to nook/.env")


def file_urls(obj):
    if isinstance(obj, dict):
        if isinstance(obj.get("url"), str) and obj["url"].startswith("http"):
            yield obj["url"]
        for v in obj.values():
            yield from file_urls(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from file_urls(v)


def main():
    image = Path(sys.argv[1] if len(sys.argv) > 1 else REPO / "evals" / "golden" / "morris-chair.jpg")
    prompt = sys.argv[2] if len(sys.argv) > 2 else "armchair"
    load_key()
    import fal_client  # after the key is in the environment

    image_url = fal_client.upload_file(str(image))
    for slug, (endpoint, args) in CALLS.items():
        out = FAL / slug
        shutil.rmtree(out, ignore_errors=True)
        (out / "files").mkdir(parents=True)
        request = args(image_url, prompt)
        print(f"calling {endpoint} ...", flush=True)
        response = fal_client.subscribe(endpoint, arguments=request)
        (out / "request.json").write_text(json.dumps(request, indent=2) + "\n")
        (out / "response.json").write_text(json.dumps(response, indent=2) + "\n")
        shutil.copy(image, out / f"input{image.suffix.lower()}")
        for url in sorted(set(file_urls(response))):
            name = Path(urlparse(url).path).name
            with httpx.stream("GET", url, follow_redirects=True, timeout=120) as r:
                r.raise_for_status()
                with open(out / "files" / name, "wb") as f:
                    for chunk in r.iter_bytes():
                        f.write(chunk)
            print(f"  saved {slug}/files/{name}")
    print("done. Now inspect frames and update fixtures/fal/NOTES.md.")


if __name__ == "__main__":
    main()
