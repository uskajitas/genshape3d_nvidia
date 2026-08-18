"""
TRELLIS.2-4B runner (microsoft/TRELLIS.2).

Native PBR image-to-3D: outputs a GLB with baked base color + metallic/
roughness + alpha straight from the model — no separate paint stage.

CLI + stdout protocol matches genshape3d_nvidia/generate.py so the Electron
worker.js can spawn this like any other runner:
  PROGRESS:{pct, phase, step, total, detail}  per stage
  RESULT:{status, output_path, ...}           at the end

Gated-model workaround: upstream pipeline.json points at facebook/dinov3
(manually gated) and briaai/RMBG-2.0 (gated + NON-COMMERCIAL license). We
write a patched pipeline.genshape.json into the local weights snapshot that
swaps in visualbruno's DINOv3 mirror (identical weights) and the MIT-licensed
ZhengPeng7/BiRefNet for background removal.

Env:
  TRELLIS2_DIR       TRELLIS.2 repo checkout (default C:\\projects\\ai\\trellis2\\TRELLIS.2)
  TRELLIS2_WEIGHTS   local snapshot dir (default C:\\ai\\trellis2-4b)
  TRELLIS2_DINOV3    override the DINOv3 repo (e.g. facebook's once gate approved)
  TRELLIS2_PIPELINE  override pipeline type ('512'|'1024'|'1024_cascade'|'1536_cascade')
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

# Must be set before torch/cv2 imports.
os.environ["OPENCV_IO_ENABLE_OPENEXR"] = "1"
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
# 3090 (sm86) has no flash-attn wheel here; xformers covers both attention paths.
os.environ.setdefault("ATTN_BACKEND", "xformers")
os.environ.setdefault("SPARSE_ATTN_BACKEND", "xformers")
os.environ.setdefault("SPARSE_CONV_BACKEND", "flex_gemm")

TRELLIS2_DIR = Path(os.environ.get("TRELLIS2_DIR", r"C:\projects\ai\trellis2\TRELLIS.2"))
sys.path.insert(0, str(TRELLIS2_DIR))


def emit_progress(pct, phase, step=0, total=0, detail=""):
    obj = {"pct": min(int(pct), 100), "phase": phase, "step": int(step), "total": int(total), "detail": detail}
    print(f"PROGRESS:{json.dumps(obj)}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--steps", type=int, default=12)
    ap.add_argument("--guidance-scale", type=float, default=7.5)
    ap.add_argument("--octree-resolution", type=int, default=1024,
                    help="voxel resolution: <=512 runs the fast '512' pipeline, else '1024_cascade'")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--num-chunks", type=int, default=8000)  # accepted, unused
    ap.add_argument("--target-face-count", type=int, default=30000)
    ap.add_argument("--export-format", default="glb")
    ap.add_argument("--remove-bg", action="store_true")  # always on (BiRefNet inside pipeline)
    ap.add_argument("--do-texture", action="store_true")  # PBR is native; flag accepted, always textured
    ap.add_argument("--aux-images", nargs="*", default=[],
                    help="Additional view images. Accepted but unused — single-view runner.")
    args = ap.parse_args()

    t0_total = time.time()
    emit_progress(0, "starting", detail="Preparing...")

    try:
        import torch
        from PIL import Image
        from trellis2.pipelines import Trellis2ImageTo3DPipeline
        import o_voxel
    except ImportError as e:
        print(f"RESULT:{json.dumps({'status':'error','error':f'import: {e}'})}", flush=True)
        return 1

    if not torch.cuda.is_available():
        print(f"RESULT:{json.dumps({'status':'error','error':'CUDA not available'})}", flush=True)
        return 1

    emit_progress(5, "loading", detail="Loading TRELLIS.2-4B...")
    t0 = time.time()
    weights_dir = Path(os.environ.get("TRELLIS2_WEIGHTS", r"C:\ai\trellis2-4b"))
    if not (weights_dir / "pipeline.json").exists():
        emit_progress(6, "loading", detail="Downloading TRELLIS.2-4B weights (first run)...")
        from huggingface_hub import snapshot_download
        snapshot_download("microsoft/TRELLIS.2-4B", local_dir=str(weights_dir))
    cfg_name = "pipeline.genshape.json"
    cfg = json.loads((weights_dir / "pipeline.json").read_text())
    cfg["args"]["image_cond_model"]["args"]["model_name"] = os.environ.get(
        "TRELLIS2_DINOV3", "visualbruno/dinov3-vitl16-pretrain-lvd1689m")
    cfg["args"]["rembg_model"]["args"]["model_name"] = "ZhengPeng7/BiRefNet"
    (weights_dir / cfg_name).write_text(json.dumps(cfg, indent=1))
    pipeline = Trellis2ImageTo3DPipeline.from_pretrained(str(weights_dir), config_file=cfg_name)
    # ZhengPeng7/BiRefNet ships fp16 weights but the wrapper feeds fp32 input
    pipeline.rembg_model.model.float()
    pipeline.cuda()
    print(f"[trellis2] pipeline loaded in {time.time() - t0:.1f}s", flush=True)

    image = Image.open(args.image).convert("RGB")
    emit_progress(25, "analyzing", detail="Analyzing image...")

    pipeline_type = os.environ.get("TRELLIS2_PIPELINE") or (
        "512" if args.octree_resolution <= 512 else "1024_cascade"
    )

    # Only override sampler params when the caller diverges from the
    # pipeline.json defaults (steps=12, guidance=7.5) — the tuned interval/
    # rescale settings stay intact either way.
    sp = {}
    if args.steps and args.steps != 12:
        sp["steps"] = max(8, min(args.steps, 50))
    if args.guidance_scale and abs(args.guidance_scale - 7.5) > 1e-6:
        sp["guidance_strength"] = args.guidance_scale

    emit_progress(35, "generating", step=1, total=1,
                  detail=f"Generating 3D ({pipeline_type})...")
    t1 = time.time()
    with torch.no_grad():
        mesh = pipeline.run(
            image,
            seed=args.seed,
            pipeline_type=pipeline_type,
            sparse_structure_sampler_params=sp,
            shape_slat_sampler_params=sp,
            tex_slat_sampler_params=sp,
        )[0]
    print(f"[trellis2] generated in {time.time() - t1:.1f}s", flush=True)

    emit_progress(75, "exporting", detail="Extracting mesh + baking PBR textures...")
    mesh.simplify(16777216)  # nvdiffrast raster limit

    target = max(int(args.target_face_count), 2000)
    t2 = time.time()
    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices,
        faces=mesh.faces,
        attr_volume=mesh.attrs,
        coords=mesh.coords,
        attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=target,
        texture_size=2048,
        remesh=True,
        remesh_band=1,
        remesh_project=0,
        verbose=True,
    )
    print(f"[trellis2] GLB baked in {time.time() - t2:.1f}s", flush=True)

    out_path = args.output
    if not out_path.lower().endswith(".glb"):
        out_path = os.path.splitext(out_path)[0] + ".glb"
    emit_progress(92, "exporting", detail="Writing GLB...")
    # webp textures shrink the file but three.js needs EXT_texture_webp; keep png/jpg for max viewer compat
    glb.export(out_path)
    size = os.path.getsize(out_path)

    faces = int(glb.faces.shape[0]) if hasattr(glb, "faces") else 0
    verts = int(glb.vertices.shape[0]) if hasattr(glb, "vertices") else 0
    emit_progress(100, "done", detail="Generation complete!")
    print(f"RESULT:{json.dumps({'status':'success','output_path':out_path,'vertices':verts,'faces':faces,'file_size':size,'textured':True,'total_time':round(time.time()-t0_total,1)})}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(f"RESULT:{json.dumps({'status':'error','error':f'{type(e).__name__}: {e}'})}", flush=True)
        sys.exit(1)
