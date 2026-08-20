"""
PartCrafter runner (wgsxm/PartCrafter, NeurIPS 2025).

Structured part-level 3D generation: one image -> up to 16 separate,
non-overlapping part meshes, exported as a single GLB whose nodes are the
parts (each tinted a distinct color). Geometry only — no textures.

CLI + stdout protocol matches genshape3d_nvidia/generate.py:
  PROGRESS:{pct, phase, step, total, detail}
  RESULT:{status, output_path, ...}

Env:
  PARTCRAFTER_DIR      repo checkout   (default C:\\projects\\ai\\PartCrafter)
  PARTCRAFTER_WEIGHTS  weights dir     (default C:\\ai\\partcrafter)
  PARTCRAFTER_PARTS    number of parts (default 6, clamped 1..16)

Background removal: genshape3d strips backgrounds server-side at upload, so
the input already has clean alpha — we just flatten onto white (what the
model expects). No Bria RMBG dependency (its license is non-commercial).
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

PARTCRAFTER_DIR = Path(os.environ.get("PARTCRAFTER_DIR", r"C:\projects\ai\PartCrafter"))
WEIGHTS_DIR = Path(os.environ.get("PARTCRAFTER_WEIGHTS", r"C:\ai\partcrafter"))
sys.path.insert(0, str(PARTCRAFTER_DIR))


def emit_progress(pct, phase, step=0, total=0, detail=""):
    obj = {"pct": min(int(pct), 100), "phase": phase, "step": int(step), "total": int(total), "detail": detail}
    print(f"PROGRESS:{json.dumps(obj)}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--steps", type=int, default=50)
    ap.add_argument("--guidance-scale", type=float, default=7.0)
    ap.add_argument("--octree-resolution", type=int, default=0)   # accepted, unused
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--num-chunks", type=int, default=0)          # accepted, unused
    ap.add_argument("--target-face-count", type=int, default=0)   # accepted, unused (parts exported as generated)
    ap.add_argument("--export-format", default="glb")
    ap.add_argument("--remove-bg", action="store_true")           # input arrives pre-stripped
    ap.add_argument("--do-texture", action="store_true")          # geometry only; flag accepted
    ap.add_argument("--aux-images", nargs="*", default=[])
    ap.add_argument("--num-parts", type=int,
                    default=int(os.environ.get("PARTCRAFTER_PARTS", "6")))
    args = ap.parse_args()

    num_parts = max(1, min(int(args.num_parts), 16))
    # Worker presets send low step counts tuned for Hunyuan; PartCrafter's
    # sweet spot is ~50. Only honor explicitly-high values.
    steps = args.steps if args.steps >= 25 else 50
    guidance = args.guidance_scale if args.guidance_scale > 0 else 7.0

    t0_total = time.time()
    emit_progress(0, "starting", detail="Preparing...")

    try:
        import numpy as np
        import torch
        import trimesh
        from PIL import Image
        from src.pipelines.pipeline_partcrafter import PartCrafterPipeline
        from src.utils.data_utils import get_colored_mesh_composition
    except ImportError as e:
        print(f"RESULT:{json.dumps({'status':'error','error':f'import: {e}'})}", flush=True)
        return 1

    if not torch.cuda.is_available():
        print(f"RESULT:{json.dumps({'status':'error','error':'CUDA not available'})}", flush=True)
        return 1

    emit_progress(5, "loading", detail="Loading PartCrafter...")
    t0 = time.time()
    pipe = PartCrafterPipeline.from_pretrained(str(WEIGHTS_DIR)).to("cuda", torch.float16)
    print(f"[partcrafter] pipeline loaded in {time.time() - t0:.1f}s", flush=True)

    emit_progress(25, "analyzing", detail="Analyzing image...")
    img = Image.open(args.image)
    if img.mode in ("RGBA", "LA"):
        # flatten pre-stripped alpha onto white (model's expected background)
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        img = bg
    else:
        img = img.convert("RGB")

    emit_progress(35, "generating", step=1, total=1,
                  detail=f"Generating {num_parts} parts...")
    t1 = time.time()
    with torch.no_grad():
        meshes = pipe(
            image=[img] * num_parts,
            attention_kwargs={"num_parts": num_parts},
            num_tokens=1024,
            generator=torch.Generator(device=pipe.device).manual_seed(args.seed),
            num_inference_steps=steps,
            guidance_scale=guidance,
            max_num_expanded_coords=int(1e9),
            use_flash_decoder=False,
        ).meshes
    print(f"[partcrafter] generated in {time.time() - t1:.1f}s", flush=True)

    for i in range(len(meshes)):
        if meshes[i] is None:  # decoder hiccup on a part — keep indices stable
            meshes[i] = trimesh.Trimesh(vertices=[[0, 0, 0]], faces=[[0, 0, 0]])

    emit_progress(85, "exporting", detail="Composing part scene...")
    scene = get_colored_mesh_composition(meshes)

    out_path = args.output
    if not out_path.lower().endswith(".glb"):
        out_path = os.path.splitext(out_path)[0] + ".glb"
    scene.export(out_path)
    size = os.path.getsize(out_path)

    total_faces = sum(int(len(m.faces)) for m in meshes)
    total_verts = sum(int(len(m.vertices)) for m in meshes)
    emit_progress(100, "done", detail="Generation complete!")
    print(f"RESULT:{json.dumps({'status':'success','output_path':out_path,'vertices':total_verts,'faces':total_faces,'parts':len(meshes),'file_size':size,'total_time':round(time.time()-t0_total,1)})}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(f"RESULT:{json.dumps({'status':'error','error':f'{type(e).__name__}: {e}'})}", flush=True)
        sys.exit(1)
