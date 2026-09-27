"""Submit a portrait edit through uFleet and save the returned JPEG.

Usage: venv/Scripts/python.exe prove_fleet.py portrait.png proof.jpg
The node key is read from C:/ufleet/kit.json; no key is stored here.
"""

import base64
import io
import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

from PIL import Image


PROMPT = (
    "Edit this picture. Change ONLY the mouth and jaw: mouth wide open, jaw "
    "dropped, as when saying AH. Keep the eyes, brows, nose, hair and everything "
    "else exactly as they are. The head must not move, grow or shrink."
)


def main() -> None:
    source, output = map(Path, sys.argv[1:3])
    kit = json.loads(Path("C:/ufleet/kit.json").read_text(encoding="utf-8-sig"))
    with Image.open(source) as im:
        im = im.convert("RGB")
        if max(im.size) > 512:
            im.thumbnail((512, 512), Image.Resampling.LANCZOS)
        size = im.size
        stream = io.BytesIO()
        im.save(stream, "JPEG", quality=92, subsampling=0)
    data_url = "data:image/jpeg;base64," + base64.b64encode(stream.getvalue()).decode()
    headers = {
        "content-type": "application/json",
        "x-node-key": kit["nodeKey"],
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    }
    root = kit["controlPlane"].rstrip("/") + "/api"

    def call(method: str, path: str, body=None):
        request = urllib.request.Request(
            root + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"fleet HTTP {error.code}: {error.read()[:1000]!r}") from error

    started = time.monotonic()
    job = call(
        "POST", "/jobs/submit",
        {"type": "image.edit", "targetMachine": kit["machineId"],
         "input": {"image": data_url, "prompt": PROMPT}},
    )
    print(f"job={job['id']}", flush=True)
    status = None
    while time.monotonic() - started < 600:
        time.sleep(3)
        job = call("GET", f"/jobs/{job['id']}/as-node")
        if job["status"] != status:
            status = job["status"]
            print(f"status={status} elapsed={time.monotonic() - started:.1f}s", flush=True)
        if status in {"done", "failed", "dead", "cancelled"}:
            break
    if status != "done":
        raise RuntimeError(f"fleet edit did not complete: {job.get('error', status)}")

    result = job["output"]
    jpeg = base64.b64decode(result["image"].split(",", 1)[-1])
    with Image.open(io.BytesIO(jpeg)) as im:
        if im.format != "JPEG" or im.size != size:
            raise RuntimeError(f"wrong output image: {im.format} {im.size}, input {size}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(jpeg)
    print(
        f"job={job['id']} elapsed={time.monotonic() - started:.1f}s "
        f"edit_ms={result['ms']} input={size} output={output} jpeg_bytes={len(jpeg)}",
        flush=True,
    )


if __name__ == "__main__":
    main()
