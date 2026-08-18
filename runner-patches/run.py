"""
Hunyuan3D-2.1 runner — image-to-3d with PBR paint pipeline.

Differs from the 2.0 runner in three big ways:
  - hy3dshape (not hy3dgen.shapegen) for the shape DiT
  - PBR paint pipeline that writes textured OBJ + albedo/metallic-roughness/normal maps
  - .ckpt-format weights (not .safetensors) — needs torch>=2.4

The runner cwds into the cloned 2.1 repo so the config relative paths in
hy3dpaint resolve (multiview_cfg_path, custom_pipeline, realesrgan ckpt).

Worker contract (matches sf3d/triposr runners):
  args: --image --output --steps --guidance-scale --octree-resolution --seed
        --num-chunks --target-face-count --export-format --remove-bg
        [--do-texture] [--aux-images ...]
  stdout: PROGRESS:{json} per progress update
  stdout: RESULT:{status, output_path, vertices, faces, total_time} at end
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path


# ─── Worker contract emitters ────────────────────────────────────────────────
def emit_progress(pct, phase, step=0, total=0, detail=''):
    obj = {'pct': min(int(pct), 100), 'phase': phase, 'step': step, 'total': total, 'detail': detail}
    print(f'PROGRESS:{json.dumps(obj)}', flush=True)

def emit_result(status='success', **kw):
    print(f'RESULT:{json.dumps({"status": status, **kw})}', flush=True)

def log(msg):
    print(f'[h21] {msg}', flush=True)


# Repo lives at C:\projects\ai\hunyuan3d\Hunyuan3D-2.1 by default. Override via env.
H21_DIR = os.environ.get("HUNYUAN3D_2_1_DIR", r"C:\projects\ai\hunyuan3d\Hunyuan3D-2.1")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, H21_DIR)  # for torchvision_fix.py at repo root
sys.path.insert(0, os.path.join(H21_DIR, "hy3dshape"))
sys.path.insert(0, os.path.join(H21_DIR, "hy3dpaint"))


def finalize_pbr_maps(out_path, tmp_dir):
    """Post-paint: bake an AO map and pack ORM (R=AO, G=roughness,
    B=metallic) into the GLB. The paint pipeline writes textured_metallic /
    textured_roughness JPGs next to the OBJ, but the OBJ→GLB conversion
    drops them (leaving metallicFactor=1.0 — everything rendered as bare
    metal). Non-fatal: on any failure the un-finalized GLB ships as before.
    Set BAKE_AO=0 to skip."""
    if os.environ.get("BAKE_AO", "1") == "0":
        return
    try:
        emit_progress(96, "texturing", detail="Baking AO + packing PBR maps...")
        sys.path.insert(0, SCRIPT_DIR)
        from bake_ao import finalize
        metallic = os.path.join(str(tmp_dir), "textured_metallic.jpg")
        roughness = os.path.join(str(tmp_dir), "textured_roughness.jpg")
        # Normal-bake source preference: bake_source.glb (the lineage's
        # original high-poly, downloaded by the worker when texturing a
        # refined derivative) over shape.obj (the pre-paint mesh — same
        # face count as the paint output, so it usually adds nothing).
        bake_src = os.path.join(str(tmp_dir), "bake_source.glb")
        source_mesh = bake_src if os.path.exists(bake_src) else os.path.join(str(tmp_dir), "shape.obj")
        finalize(
            str(out_path), str(out_path),
            metallic_path=metallic if os.path.exists(metallic) else None,
            roughness_path=roughness if os.path.exists(roughness) else None,
            source_mesh_path=source_mesh if os.path.exists(source_mesh) else None,
        )
        log("AO + ORM finalize OK")
    except Exception as e:
        log(f"AO/ORM finalize failed (non-fatal, shipping unfinalized GLB): {e}")


REALESRGAN_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"

def ensure_realesrgan_ckpt() -> str:
    ckpt_dir = Path(H21_DIR) / "hy3dpaint" / "ckpt"
    ckpt_path = ckpt_dir / "RealESRGAN_x4plus.pth"
    if ckpt_path.exists() and ckpt_path.stat().st_size > 1_000_000:
        return str(ckpt_path)
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    log(f"downloading RealESRGAN_x4plus.pth (~64 MB)")
    urllib.request.urlretrieve(REALESRGAN_URL, str(ckpt_path))
    log(f"realesrgan ckpt ready ({ckpt_path.stat().st_size} bytes)")
    return str(ckpt_path)


def install_trimesh_obj_to_glb_patch() -> None:
    """Override hy3dpaint's bpy-based OBJ→GLB with a trimesh fallback so we
    don't need a 200-MB Blender install just for the final conversion step."""
    import trimesh
    from DifferentiableRenderer import mesh_utils as mu

    def _trimesh_convert(obj_path: str, glb_path: str, **_kwargs) -> bool:
        try:
            scene = trimesh.load(obj_path, force="scene", process=False)
            scene.export(glb_path)
            return True
        except Exception as e:
            log(f"trimesh convert_obj_to_glb failed: {e}")
            return False

    mu.convert_obj_to_glb = _trimesh_convert


class TqdmProgressHook:
    """Maps Diffusion (5-15%) and Volume Decoding (15-80%) to overall pct."""
    def __init__(self):
        self.original_tqdm = None

    def install(self):
        import tqdm as tqdm_module
        self.original_tqdm = tqdm_module.tqdm

        class HookedTqdm(self.original_tqdm):
            def __init__(self, iterable=None, desc=None, total=None, **kwargs):
                super().__init__(iterable, desc=desc, total=total, **kwargs)
                self._hook_desc = desc or ""
                self._hook_total = total or (
                    len(iterable) if iterable is not None and hasattr(iterable, "__len__") else 0
                )

            def update(self, n=1):
                super().update(n)
                if "Volume Decoding" in self._hook_desc and self._hook_total > 0:
                    overall = round(15 + (self.n / self._hook_total) * 65)
                    emit_progress(overall, "generating", step=self.n, total=self._hook_total,
                                  detail=f"Building 3D structure... {overall}%")
                elif "Diffusion" in self._hook_desc and self._hook_total > 0:
                    overall = round(5 + (self.n / self._hook_total) * 10)
                    emit_progress(overall, "analyzing", step=self.n, total=self._hook_total,
                                  detail=f"Analyzing image... {overall}%")

        tqdm_module.tqdm = HookedTqdm
        for modname in (
            "hy3dshape.models.autoencoders.volume_decoders",
            "hy3dshape.pipelines",
        ):
            try:
                __import__(modname)
                sys.modules[modname].tqdm = HookedTqdm
            except Exception:
                pass

    def uninstall(self):
        if self.original_tqdm:
            import tqdm as tqdm_module
            tqdm_module.tqdm = self.original_tqdm


def run_texture_only(args) -> int:
    """Paint-only mode: apply PBR texture to an existing mesh. No shape pipeline."""
    import torch
    from PIL import Image

    if not torch.cuda.is_available():
        emit_result(status="error", error="CUDA not available")
        return 1
    if not args.source_mesh or not Path(args.source_mesh).exists():
        emit_result(status="error", error=f"source mesh not found: {args.source_mesh}")
        return 1

    t0 = time.time()
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_dir = out_path.parent

    emit_progress(2, "loading", detail="Loading source mesh...")
    log(f"texture-only mode: loading mesh from {args.source_mesh}")

    import trimesh
    scene = trimesh.load(args.source_mesh, force="scene", process=False)
    shape_obj = tmp_dir / "shape.obj"
    scene.export(str(shape_obj))
    log(f"mesh exported to OBJ: {shape_obj}")

    emit_progress(10, "loading", detail="Loading reference image...")
    image = Image.open(args.image)
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    # Save image to disk so paint pipeline can read it
    img_path = tmp_dir / "ref_image.png"
    image.save(str(img_path))

    emit_progress(15, "texturing", detail="Loading PBR paint pipeline...")
    os.chdir(H21_DIR)
    ensure_realesrgan_ckpt()
    install_trimesh_obj_to_glb_patch()

    from textureGenPipeline import Hunyuan3DPaintPipeline, Hunyuan3DPaintConfig
    conf = Hunyuan3DPaintConfig(args.paint_max_views, args.paint_resolution)
    conf.realesrgan_ckpt_path = "hy3dpaint/ckpt/RealESRGAN_x4plus.pth"
    conf.multiview_cfg_path = "hy3dpaint/cfgs/hunyuan-paint-pbr.yaml"
    conf.custom_pipeline = "hy3dpaint/hunyuanpaintpbr"
    conf.render_size = int(os.environ.get("PAINT_RENDER_SIZE", "1024"))
    conf.texture_size = int(os.environ.get("PAINT_TEXTURE_SIZE", "2048"))
    paint_pipe = Hunyuan3DPaintPipeline(conf)

    emit_progress(20, "texturing", detail="Generating PBR materials...")
    t1 = time.time()
    textured_obj = tmp_dir / "textured.obj"
    paint_pipe(
        mesh_path=str(shape_obj),
        image_path=str(img_path),
        output_mesh_path=str(textured_obj),
    )
    paint_time = time.time() - t1
    log(f"PBR paint done in {paint_time:.1f}s")

    emit_progress(92, "exporting", detail="Exporting textured GLB...")
    paint_glb = tmp_dir / "textured.glb"
    if paint_glb.exists():
        paint_glb.replace(out_path)
    else:
        scene2 = trimesh.load(str(textured_obj), force="scene", process=False)
        scene2.export(str(out_path))

    finalize_pbr_maps(out_path, tmp_dir)

    total = time.time() - t0
    emit_progress(100, "done", detail="Texture complete!")
    emit_result(
        output_path=str(out_path),
        file_size=os.path.getsize(out_path),
        texture_time=round(paint_time, 1),
        total_time=round(total, 1),
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--guidance-scale", type=float, default=5.0)
    ap.add_argument("--octree-resolution", type=int, default=256)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--num-chunks", type=int, default=200000)
    ap.add_argument("--target-face-count", type=int, default=100000)
    ap.add_argument("--export-format", default="glb")
    ap.add_argument("--remove-bg", action="store_true")
    ap.add_argument("--do-texture", action="store_true")
    ap.add_argument("--aux-images", nargs="*", default=[])
    # 2.1-specific paint knobs (not sent by current admin UI; safe defaults).
    ap.add_argument("--paint-max-views", type=int, default=int(os.environ.get("PAINT_MAX_VIEWS", "6")))
    ap.add_argument("--paint-resolution", type=int, default=int(os.environ.get("PAINT_RESOLUTION", "512")))
    ap.add_argument("--texture-only", action="store_true")
    ap.add_argument("--source-mesh", default="")
    args = ap.parse_args()

    if args.texture_only:
        sys.exit(run_texture_only(args))

    # cwd into the repo so relative config paths in hy3dpaint resolve.
    os.chdir(H21_DIR)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    emit_progress(1, "starting", detail="Preparing...")
    log(f"steps={args.steps} guidance={args.guidance_scale} octree={args.octree_resolution} "
        f"faces={args.target_face_count} texture={args.do_texture} fmt={args.export_format}")

    # Apply torchvision compat fix from upstream so basicsr/realesrgan import.
    try:
        from torchvision_fix import apply_fix
        apply_fix()
    except Exception as e:
        log(f"torchvision_fix skipped: {e}")

    import torch
    from PIL import Image
    if not torch.cuda.is_available():
        emit_result(status="error", error="CUDA not available")
        return 1

    image = Image.open(args.image)
    if image.mode != "RGBA":
        image = image.convert("RGBA")

    if args.remove_bg:
        try:
            from hy3dshape.rembg import BackgroundRemover
            emit_progress(2, "starting", detail="Processing image...")
            image = BackgroundRemover()(image)
        except Exception as e:
            log(f"rembg skipped: {e}")

    hook = TqdmProgressHook()
    hook.install()

    emit_progress(3, "loading", detail="Loading Hunyuan3D-2.1 shape model...")
    log("loading hy3dshape pipeline (Hunyuan3D-2.1)")
    t0 = time.time()
    from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline
    shape_pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained("tencent/Hunyuan3D-2.1")
    log(f"shape pipeline loaded in {time.time() - t0:.1f}s")
    emit_progress(5, "loading", detail="Model ready, starting generation...")

    generator = torch.Generator(device="cuda").manual_seed(args.seed) if args.seed > 0 else None

    emit_progress(5, "analyzing", step=0, total=args.steps, detail="Analyzing image...")
    t1 = time.time()
    mesh = shape_pipe(
        image=image,
        num_inference_steps=args.steps,
        guidance_scale=args.guidance_scale,
        generator=generator,
        octree_resolution=args.octree_resolution,
        num_chunks=args.num_chunks,
    )[0]
    shape_time = time.time() - t1
    log(f"shape generated ({len(mesh.vertices)} verts, {len(mesh.faces)} faces) in {shape_time:.1f}s")
    emit_progress(80 if args.do_texture else 90, "refining", detail="Refining 3D model...")

    if args.target_face_count > 0 and len(mesh.faces) > args.target_face_count:
        try:
            from hy3dshape.postprocessors import FaceReducer
            emit_progress(82 if args.do_texture else 92, "refining", detail="Optimizing mesh...")
            mesh = FaceReducer()(mesh, args.target_face_count)
            log(f"face-reduced to {len(mesh.faces)} faces")
        except Exception as e:
            log(f"face reduction skipped: {e}")

    if not args.do_texture:
        emit_progress(95, "exporting", detail="Exporting 3D file...")
        mesh.export(str(out_path))
        hook.uninstall()
        total = time.time() - t0
        log(f"exported {out_path}")
        emit_progress(100, "done", detail="Generation complete!")
        emit_result(output_path=str(out_path), vertices=len(mesh.vertices),
                    faces=len(mesh.faces), file_size=os.path.getsize(out_path),
                    generation_time=round(shape_time, 1), total_time=round(total, 1))
        return 0

    # ─── Paint (PBR) ─────────────────────────────────────────────────────────
    emit_progress(82, "texturing", detail="Loading PBR paint pipeline...")
    log("loading PBR paint pipeline")

    tmp_dir = out_path.parent
    shape_obj = tmp_dir / "shape.obj"
    mesh.export(str(shape_obj))

    # CRITICAL: free the shape pipeline from VRAM before loading the paint
    # pipeline. The mesh is already on CPU (exported above), so the shape DiT is
    # no longer needed. If we don't do this, shape + paint models are both
    # resident (~24 GB on a 3090) and CUDA VRAM exhausts — on Windows the WDDM
    # driver then silently spills to system RAM over PCIe, and the paint step
    # crawls (an hour instead of minutes) at ~99% GPU util but no real progress.
    try:
        del shape_pipe
    except NameError:
        pass
    import gc
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.synchronize()
    log(f"shape pipe freed; VRAM now {torch.cuda.memory_allocated()/1e9:.1f} GB allocated"
        if torch.cuda.is_available() else "shape pipe freed")

    ensure_realesrgan_ckpt()
    install_trimesh_obj_to_glb_patch()

    from textureGenPipeline import Hunyuan3DPaintPipeline, Hunyuan3DPaintConfig
    conf = Hunyuan3DPaintConfig(args.paint_max_views, args.paint_resolution)
    conf.realesrgan_ckpt_path = "hy3dpaint/ckpt/RealESRGAN_x4plus.pth"
    conf.multiview_cfg_path = "hy3dpaint/cfgs/hunyuan-paint-pbr.yaml"
    conf.custom_pipeline = "hy3dpaint/hunyuanpaintpbr"
    # Defaults are render=2048, texture=4096 — too aggressive for an early
    # validation run on a 24 GB card with the shape pipe still resident.
    # Halve both; can re-tune later via env once the path is proven.
    conf.render_size = int(os.environ.get("PAINT_RENDER_SIZE", "1024"))
    conf.texture_size = int(os.environ.get("PAINT_TEXTURE_SIZE", "2048"))
    paint_pipe = Hunyuan3DPaintPipeline(conf)

    emit_progress(85, "texturing", detail="Generating PBR materials...")
    t2 = time.time()
    textured_obj = tmp_dir / "textured.obj"
    paint_pipe(
        mesh_path=str(shape_obj),
        image_path=args.image,
        output_mesh_path=str(textured_obj),
    )
    paint_time = time.time() - t2
    log(f"PBR paint done in {paint_time:.1f}s")
    emit_progress(95, "exporting", detail="Exporting 3D file...")

    paint_glb = tmp_dir / "textured.glb"
    if paint_glb.exists():
        paint_glb.replace(out_path)
    else:
        import trimesh
        scene = trimesh.load(str(textured_obj), force="scene", process=False)
        scene.export(str(out_path))

    finalize_pbr_maps(out_path, tmp_dir)

    hook.uninstall()
    total = time.time() - t0
    log(f"exported {out_path}")
    emit_progress(100, "done", detail="Generation complete!")
    emit_result(output_path=str(out_path), vertices=len(mesh.vertices),
                faces=len(mesh.faces), file_size=os.path.getsize(out_path),
                generation_time=round(shape_time, 1), texture_time=round(paint_time, 1),
                total_time=round(total, 1))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit_result(status="error", error=f"{type(e).__name__}: {e}")
        sys.exit(1)
