"""
refine.py — mesh repair + retopology for generated GLBs.

Generated meshes routinely carry defects that break downstream tools
(face-region selection, zoning, engines): duplicate/degenerate faces,
disconnected floater shells, holes, inconsistent winding, and far more
triangles than needed. This runner produces a CLEAN derivative mesh:

  weld            merge duplicate/near-duplicate vertices
  degenerate      drop zero-area and duplicate faces
  floaters        remove small disconnected components (< keep_frac of faces)
  holes           fill simple holes (trimesh)
  normals         fix winding + normals consistently
  decimate        quadric decimation to --target-faces (0 = keep count)
  smooth          optional light Taubin smoothing (--smooth iterations)

Texture/UVs are intentionally dropped: repair + decimation invalidate the
original UV layout anyway. The refined mesh is the geometry base for
zoning and a fresh Material pass. The source GLB is never modified.

Usage:
  python refine.py --input in.glb --output out.glb [--target-faces 40000]
                   [--keep-frac 0.02] [--smooth 0] [--no-fill-holes]

Emits PROGRESS/RESULT JSON lines compatible with the worker protocol.
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import numpy as np
import trimesh


def log(msg: str) -> None:
    print(f"[refine] {msg}", flush=True)


def progress(pct: int, phase: str, detail: str = "") -> None:
    # Same line protocol as run.py — the worker parses these prefixes.
    print("PROGRESS:" + json.dumps({"pct": pct, "phase": phase, "detail": detail}), flush=True)


def emit_result(**data) -> None:
    print("RESULT:" + json.dumps({"status": "ok", **data}), flush=True)


def load_biggest_mesh(path: str) -> trimesh.Trimesh:
    loaded = trimesh.load(path, force="scene", process=False)
    meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
    if not meshes:
        raise RuntimeError("no mesh found in input")
    if len(meshes) == 1:
        return meshes[0]
    # Multiple geometries: concatenate — floater removal will sort them out.
    return trimesh.util.concatenate(meshes)


def remove_floaters(mesh: trimesh.Trimesh, keep_frac: float) -> tuple[trimesh.Trimesh, int]:
    comps = mesh.split(only_watertight=False)
    if len(comps) <= 1:
        return mesh, 0
    biggest = max(len(c.faces) for c in comps)
    keep = [c for c in comps if len(c.faces) >= max(1, int(biggest * keep_frac))]
    removed = len(comps) - len(keep)
    return trimesh.util.concatenate(keep) if len(keep) > 1 else keep[0], removed


def decimate(mesh: trimesh.Trimesh, target_faces: int) -> trimesh.Trimesh:
    import open3d as o3d
    o3 = o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(np.asarray(mesh.vertices)),
        o3d.utility.Vector3iVector(np.asarray(mesh.faces)),
    )
    o3 = o3.simplify_quadric_decimation(target_number_of_triangles=int(target_faces))
    o3.remove_degenerate_triangles()
    o3.remove_unreferenced_vertices()
    return trimesh.Trimesh(
        vertices=np.asarray(o3.vertices), faces=np.asarray(o3.triangles), process=False,
    )


def taubin_smooth(mesh: trimesh.Trimesh, iterations: int) -> trimesh.Trimesh:
    import open3d as o3d
    o3 = o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(np.asarray(mesh.vertices)),
        o3d.utility.Vector3iVector(np.asarray(mesh.faces)),
    )
    o3 = o3.filter_smooth_taubin(number_of_iterations=int(iterations))
    return trimesh.Trimesh(
        vertices=np.asarray(o3.vertices), faces=np.asarray(mesh.faces), process=False,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--target-faces", type=int, default=0, help="0 = no decimation")
    ap.add_argument("--keep-frac", type=float, default=0.02,
                    help="components smaller than this fraction of the biggest are floaters")
    ap.add_argument("--smooth", type=int, default=0, help="Taubin smoothing iterations")
    ap.add_argument("--no-fill-holes", action="store_true")
    args = ap.parse_args()

    t0 = time.time()
    stats: dict = {}

    progress(5, "loading", "Loading mesh...")
    mesh = load_biggest_mesh(args.input)
    stats["faces_in"] = int(len(mesh.faces))
    stats["vertices_in"] = int(len(mesh.vertices))
    log(f"input: {stats['faces_in']} faces, {stats['vertices_in']} verts")

    progress(15, "repair", "Welding vertices...")
    mesh.merge_vertices()

    progress(25, "repair", "Removing degenerate faces...")
    before = len(mesh.faces)
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.update_faces(mesh.unique_faces())
    mesh.remove_unreferenced_vertices()
    stats["degenerate_removed"] = int(before - len(mesh.faces))

    progress(35, "repair", "Removing floating fragments...")
    mesh, floaters = remove_floaters(mesh, args.keep_frac)
    stats["floaters_removed"] = int(floaters)

    if not args.no_fill_holes:
        progress(50, "repair", "Filling holes...")
        try:
            trimesh.repair.fill_holes(mesh)
        except Exception as e:
            log(f"fill_holes skipped: {e}")

    progress(60, "repair", "Fixing normals and winding...")
    try:
        trimesh.repair.fix_normals(mesh)
        trimesh.repair.fix_winding(mesh)
        trimesh.repair.fix_inversion(mesh)
    except Exception as e:
        log(f"normal repair partial: {e}")

    if args.target_faces > 0 and len(mesh.faces) > args.target_faces:
        progress(75, "retopo", f"Decimating to {args.target_faces} faces...")
        mesh = decimate(mesh, args.target_faces)

    if args.smooth > 0:
        progress(85, "retopo", "Smoothing...")
        mesh = taubin_smooth(mesh, args.smooth)
        mesh.merge_vertices()

    stats["faces_out"] = int(len(mesh.faces))
    stats["vertices_out"] = int(len(mesh.vertices))
    stats["watertight"] = bool(mesh.is_watertight)

    progress(92, "exporting", "Exporting GLB...")
    mesh.visual = trimesh.visual.ColorVisuals(mesh)  # plain clay, no stale UV/material
    mesh.export(args.output)

    stats["time"] = round(time.time() - t0, 1)
    log(f"refined: {stats['faces_in']}->{stats['faces_out']} faces, "
        f"{stats['floaters_removed']} floaters and {stats['degenerate_removed']} degenerates removed, "
        f"watertight={stats['watertight']}, {stats['time']}s")
    progress(100, "done", "Refine complete")
    emit_result(output_path=args.output, **stats)
    return 0


if __name__ == "__main__":
    sys.exit(main())
