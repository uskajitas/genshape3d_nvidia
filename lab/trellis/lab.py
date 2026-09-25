"""
TRELLIS lab — one picture, many settings, every result measured.

Runs TRELLIS.2 in-process with the same weights and patched config as the
production runner (genshape-worker-3090/runners/trellis2/run.py), but keeps
what the runner throws away: the raw mesh straight out of the model, before
any clean-up. Each variant is exported and measured, so the question "are the
holes made by the model or by the clean-up?" has a number for an answer.

Run with the TRELLIS venv:
  C:\\projects\\genshape-worker-3090\\runners\\trellis2\\.venv\\Scripts\\python.exe lab.py
      --image block.jpg --out out\\block --experiment export [--seed 0]

Experiments:
  export   one generation, exported five ways (raw, current runner, official
           app, official example, no-remesh branch)
  samplers the same picture through several per-stage sampler settings,
           each exported the current runner's way
Writes <out>/<variant>.glb and <out>/results.json.
"""
import argparse, json, os, sys, time
from pathlib import Path

os.environ["OPENCV_IO_ENABLE_OPENEXR"] = "1"
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
os.environ.setdefault("ATTN_BACKEND", "xformers")
os.environ.setdefault("SPARSE_ATTN_BACKEND", "xformers")
os.environ.setdefault("SPARSE_CONV_BACKEND", "flex_gemm")
TRELLIS2_DIR = Path(os.environ.get("TRELLIS2_DIR", r"C:\projects\ai\trellis2\TRELLIS.2"))
sys.path.insert(0, str(TRELLIS2_DIR))

import numpy as np
import trimesh


def measure(v, f) -> dict:
    """holes, bodies, closed — on geometry only, texture seams welded"""
    m = trimesh.Trimesh(np.asarray(v, dtype=np.float64), np.asarray(f, dtype=np.int64), process=False)
    m.merge_vertices(digits_vertex=6)
    e = m.edges_sorted
    if len(e) == 0:
        return {"faces": 0, "holes": 0, "open_edges": 0, "bodies": 0, "closed": False}
    u, cnt = np.unique(e, axis=0, return_counts=True)
    oe = u[cnt == 1]
    holes = 0
    if len(oe):
        # boundary loops = connected groups of open edges
        parent = {}
        def find(x):
            while parent.get(x, x) != x:
                parent[x] = parent.get(parent[x], parent[x]); x = parent[x]
            return x
        for a, b in oe:
            ra, rb = find(int(a)), find(int(b))
            if ra != rb: parent[ra] = rb
        holes = len({find(int(x)) for x in np.unique(oe)})
    bodies = trimesh.graph.connected_components(m.face_adjacency, nodes=np.arange(len(m.faces)))
    sizes = sorted((len(c) for c in bodies), reverse=True)
    return {
        "faces": int(len(m.faces)), "holes": int(holes), "open_edges": int(len(oe)),
        "non_manifold_edges": int((cnt > 2).sum()), "bodies": len(sizes),
        "biggest_body_share": round(sizes[0] / max(1, len(m.faces)), 4) if sizes else 0,
        "closed": bool(len(oe) == 0),
    }


def load_pipeline():
    import torch
    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    weights = Path(os.environ.get("TRELLIS2_WEIGHTS", r"C:\ai\trellis2-4b"))
    cfg = json.loads((weights / "pipeline.json").read_text())
    cfg["args"]["image_cond_model"]["args"]["model_name"] = os.environ.get("TRELLIS2_DINOV3", "visualbruno/dinov3-vitl16-pretrain-lvd1689m")
    cfg["args"]["rembg_model"]["args"]["model_name"] = "ZhengPeng7/BiRefNet"
    (weights / "pipeline.genshape.json").write_text(json.dumps(cfg, indent=1))
    p = Trellis2ImageTo3DPipeline.from_pretrained(str(weights), config_file="pipeline.genshape.json")
    p.rembg_model.model.float()
    p.cuda()
    return p


def generate(pipeline, image, seed, pipeline_type, ss=None, shape=None, tex=None):
    import torch
    with torch.no_grad():
        return pipeline.run(image, seed=seed, pipeline_type=pipeline_type,
                            sparse_structure_sampler_params=ss or {},
                            shape_slat_sampler_params=shape or {},
                            tex_slat_sampler_params=tex or {})[0]


def export(mesh, out: Path, name: str, **kw) -> dict:
    """the runner's export path, with its knobs exposed"""
    import o_voxel
    t = time.time()
    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs, coords=mesh.coords,
        attr_layout=mesh.layout, voxel_size=mesh.voxel_size, aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        verbose=False, **kw)
    glb.export(str(out / f"{name}.glb"))
    r = measure(glb.vertices, glb.faces); r["seconds"] = round(time.time() - t, 1); r["settings"] = kw
    return r


def raw(mesh, out: Path, name: str) -> dict:
    v = mesh.vertices.detach().cpu().numpy(); f = mesh.faces.detach().cpu().numpy()
    trimesh.Trimesh(v, f, process=False).export(str(out / f"{name}.glb"))
    return measure(v, f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--experiment", default="export", choices=["export", "samplers"])
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--pipeline", default="512")
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    from PIL import Image
    image = Image.open(a.image).convert("RGB")
    t0 = time.time(); pipeline = load_pipeline(); print(f"[lab] loaded in {time.time()-t0:.0f}s", flush=True)
    results = {"image": a.image, "seed": a.seed, "pipeline": a.pipeline, "experiment": a.experiment, "variants": {}}

    def save():
        (out / "results.json").write_text(json.dumps(results, indent=1))

    if a.experiment == "export":
        t = time.time(); mesh = generate(pipeline, image, a.seed, a.pipeline)
        results["generate_seconds"] = round(time.time() - t, 1); print(f"[lab] generated in {results['generate_seconds']}s", flush=True)
        V = results["variants"]
        V["raw"] = raw(mesh, out, "raw"); save(); print("[lab] raw", V["raw"], flush=True)
        mesh.simplify(16777216)
        V["raw_simplified"] = raw(mesh, out, "raw_simplified"); save(); print("[lab] raw_simplified", V["raw_simplified"], flush=True)
        for name, kw in [
            ("runner_now",       dict(decimation_target=120000, texture_size=2048, remesh=True, remesh_band=1, remesh_project=0)),
            ("official_app",     dict(decimation_target=500000, texture_size=2048, remesh=True, remesh_band=1, remesh_project=0)),
            ("official_example", dict(decimation_target=1000000, texture_size=2048, remesh=True, remesh_band=1, remesh_project=0)),
            ("no_remesh",        dict(decimation_target=500000, texture_size=2048, remesh=False)),
        ]:
            try: V[name] = export(mesh, out, name, **kw)
            except Exception as e: V[name] = {"error": str(e)}
            save(); print(f"[lab] {name}", V[name], flush=True)

    if a.experiment == "samplers":
        runner_export = dict(decimation_target=500000, texture_size=2048, remesh=True, remesh_band=1, remesh_project=0)
        official = dict(ss=dict(steps=12, guidance_strength=7.5, guidance_rescale=0.7),
                        shape=dict(steps=12, guidance_strength=7.5, guidance_rescale=0.5),
                        tex=dict(steps=12, guidance_strength=1.0, guidance_rescale=0.0))
        for name, sp in [
            ("official", official),
            ("ss_steps_25", {**official, "ss": dict(steps=25, guidance_strength=7.5, guidance_rescale=0.7)}),
            ("ss_guidance_10", {**official, "ss": dict(steps=12, guidance_strength=10.0, guidance_rescale=0.7)}),
            ("shape_steps_25", {**official, "shape": dict(steps=25, guidance_strength=7.5, guidance_rescale=0.5)}),
            ("same_for_all_7", dict(ss=dict(steps=12, guidance_strength=7.0), shape=dict(steps=12, guidance_strength=7.0), tex=dict(steps=12, guidance_strength=7.0))),
        ]:
            t = time.time(); mesh = generate(pipeline, image, a.seed, a.pipeline, **sp); g = round(time.time() - t, 1)
            r_raw = raw(mesh, out, f"{name}_raw"); mesh.simplify(16777216)
            try: r = export(mesh, out, name, **runner_export)
            except Exception as e: r = {"error": str(e)}
            results["variants"][name] = {"generate_seconds": g, "samplers": sp, "raw": r_raw, "exported": r}
            save(); print(f"[lab] {name}", results["variants"][name], flush=True)

    results["total_seconds"] = round(time.time() - t0, 1); save(); print("[lab] done", flush=True)


if __name__ == "__main__":
    main()
