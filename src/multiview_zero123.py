"""
Local Zero123++ runner. Generates 6 alt views of an input image, locally,
so we don't depend on Replicate or any external API.

Usage:
    python multiview_zero123.py --image input.png --output-dir /tmp/views

Outputs PNG files into output-dir with canonical labels:
    three_q.png   (~30° azimuth)
    side.png      (~90°)
    back.png      (~150°)
    plus three more unmapped (210/270/330) saved as v3/v4/v5 for inspection.

Prints a final RESULT:{...} JSON line with the absolute paths of the
three labelled views so the worker can pick them up.
"""
import argparse
import json
import os
import sys
import time

from PIL import Image
import torch


# Index → canonical label.
# Zero123++ outputs 6 views at 30° azimuth increments around the equator.
# Hunyuan3D-2-mv was trained on triplets {front, back, left} per Tencent's
# example_mv_images. So we pick the indices that map closest to those:
#   index 2 (~150° azimuth) -> 'back'
#   index 4 (~270° azimuth) -> 'left'
# The "front" view is the user's original input image (provided separately
# by generate.py, NOT from Zero123++).
INDEX_TO_LABEL = {2: 'back', 4: 'left'}


def emit_progress(pct: int, detail: str = '') -> None:
    obj = {'pct': min(pct, 100), 'phase': 'multiview', 'step': 0, 'total': 0, 'detail': detail}
    print(f'PROGRESS:{json.dumps(obj)}', flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', required=True, help='input image path')
    ap.add_argument('--output-dir', required=True, help='where to write the 6 PNGs')
    ap.add_argument('--steps', type=int, default=36)
    args = ap.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    t0 = time.time()
    emit_progress(2, 'Loading Zero123++…')

    from diffusers import DiffusionPipeline, EulerAncestralDiscreteScheduler

    pipe = DiffusionPipeline.from_pretrained(
        'sudo-ai/zero123plus-v1.2',
        custom_pipeline='sudo-ai/zero123plus-pipeline',
        torch_dtype=torch.float16,
        trust_remote_code=True,
    )
    pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(
        pipe.scheduler.config, timestep_spacing='trailing',
    )
    pipe.to('cuda:0')
    print(f'[mv] Zero123++ loaded in {time.time() - t0:.1f}s', flush=True)
    emit_progress(20, 'Generating views…')

    cond = Image.open(args.image)
    if cond.mode != 'RGBA':
        cond = cond.convert('RGBA')

    t1 = time.time()
    out = pipe(cond, num_inference_steps=args.steps).images[0]
    print(f'[mv] generated grid in {time.time() - t1:.1f}s', flush=True)
    emit_progress(80, 'Splitting grid…')

    # Zero123++ outputs a 2 cols × 3 rows grid (the canvas is taller
    # than wide, e.g. 640×960). Reading order: 6 views at 30° azimuth
    # increments around the equator. Auto-detect orientation just in
    # case a future model version changes layout.
    W, H = out.size
    if H > W:
        cols, rows = 2, 3
    else:
        cols, rows = 3, 2
    cw, ch = W // cols, H // rows

    # Background removal — Zero123++ leaves a solid grey backdrop, and
    # Hunyuan3D-2-mv interprets that as geometry (it draws a hollow box
    # around the subject). Run each saved view through the same
    # BackgroundRemover Hunyuan3D itself uses, so the alpha channel
    # tells the mv pipeline what's foreground.
    bg_remover = None
    try:
        sys.path.insert(0, os.environ.get('HUNYUAN3D_DIR', r'C:/projects/ai/hunyuan3d/Hunyuan3D-2'))
        try:
            from hy3dgen import rembg as _rb
        except ImportError:
            from hy3dgen.shapegen import rembg as _rb
        bg_remover = _rb.BackgroundRemover()
    except Exception as e:
        print(f'[mv] WARN: bg remover unavailable ({e}); views will keep grey backdrop', flush=True)

    emit_progress(85, 'Removing backgrounds…')
    paths = {}
    for r in range(rows):
        for c in range(cols):
            i = r * cols + c
            crop = out.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch))
            label = INDEX_TO_LABEL.get(i, f'v{i}')
            # rembg expects RGBA; convert if needed.
            if bg_remover is not None and label in INDEX_TO_LABEL.values():
                rgba = crop if crop.mode == 'RGBA' else crop.convert('RGBA')
                try:
                    crop = bg_remover(rgba)
                except Exception as e:
                    print(f'[mv] WARN: bg removal failed for {label} ({e}); using raw crop', flush=True)
            path = os.path.join(args.output_dir, f'{label}.png')
            crop.save(path)
            if label in INDEX_TO_LABEL.values():
                paths[label] = path

    emit_progress(100, 'Done')
    print(f'RESULT:{json.dumps({"status": "success", "views": paths, "total_time": round(time.time() - t0, 1)})}', flush=True)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(f'RESULT:{json.dumps({"status": "error", "error": f"{type(e).__name__}: {e}"})}', flush=True)
        sys.exit(1)
