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
    # Label components on the face-adjacency graph and drop small ones with a
    # single boolean mask. Never split() into submeshes: trellis meshes can
    # carry THOUSANDS of tiny fragments, and split()+concatenate() on one of
    # those exhausted all system RAM and froze the whole machine.
    comps = trimesh.graph.connected_components(
        mesh.face_adjacency, nodes=np.arange(len(mesh.faces)),
    )
    if len(comps) <= 1:
        return mesh, 0
    biggest = max(len(c) for c in comps)
    min_faces = max(1, int(biggest * keep_frac))
    keep_mask = np.zeros(len(mesh.faces), dtype=bool)
    removed = 0
    for c in comps:
        if len(c) >= min_faces:
            keep_mask[c] = True
        else:
            removed += 1
    if removed == 0:
        return mesh, 0
    mesh.update_faces(keep_mask)
    mesh.remove_unreferenced_vertices()
    return mesh, removed


def rebuild_surface(mesh: trimesh.Trimesh, target_faces: int) -> trimesh.Trimesh:
    """TRUE retopology: throw the original topology away and reconstruct the
    surface from scratch. Samples the mesh as an oriented point cloud, runs
    Poisson reconstruction (guaranteed watertight, uniform tessellation),
    trims low-support blobs, and decimates to the target. Use when the
    topology itself is broken beyond repair — self-intersections, non-manifold
    tangles, shredded regions where selection can't walk."""
    import open3d as o3d

    n_points = max(120_000, min(400_000, len(mesh.faces) * 6))
    o3 = o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(np.asarray(mesh.vertices)),
        o3d.utility.Vector3iVector(np.asarray(mesh.faces)),
    )
    o3.compute_vertex_normals()
    pcd = o3.sample_points_uniformly(number_of_points=n_points, use_triangle_normal=True)

    rec, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pcd, depth=9)
    # Poisson closes the field with big low-support membranes — cut the
    # weakest 2% of vertices to remove them.
    d = np.asarray(densities)
    rec.remove_vertices_by_mask(d < np.quantile(d, 0.02))
    rec.remove_degenerate_triangles()
    rec.remove_unreferenced_vertices()

    # Clamp to the original bounds (+2%) in case any membrane survived.
    bb = mesh.bounds
    pad = (bb[1] - bb[0]) * 0.02
    box = o3d.geometry.AxisAlignedBoundingBox(bb[0] - pad, bb[1] + pad)
    rec = rec.crop(box)

    if target_faces > 0 and len(rec.triangles) > target_faces:
        rec = rec.simplify_quadric_decimation(target_number_of_triangles=int(target_faces))
        rec.remove_degenerate_triangles()
        rec.remove_unreferenced_vertices()

    return trimesh.Trimesh(
        vertices=np.asarray(rec.vertices), faces=np.asarray(rec.triangles), process=False,
    )


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




def unwrap_and_bake(mesh: trimesh.Trimesh, bake_source: trimesh.Trimesh | None,
                    out_path: str, stats: dict) -> None:
    """Give the refined mesh a fresh UV layout (xatlas) and bake maps into it:
    a tangent-space normal map from the pre-decimation source (so the lower
    face count keeps the original's surface detail) and AO. Falls back to a
    plain clay export if anything in the chain fails."""
    import sys as _sys, os as _os
    _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
    try:
        import xatlas
        progress(88, "uv", "Unwrapping UVs (xatlas)...")
        vmapping, indices, uvs = xatlas.parametrize(
            np.asarray(mesh.vertices, dtype=np.float32),
            np.asarray(mesh.faces, dtype=np.uint32),
        )
        unwrapped = trimesh.Trimesh(
            vertices=np.asarray(mesh.vertices)[vmapping],
            faces=indices.astype(np.int64),
            process=False,
        )
        unwrapped.visual = trimesh.visual.TextureVisuals(
            uv=uvs,
            material=trimesh.visual.material.PBRMaterial(
                baseColorFactor=[0.78, 0.78, 0.8, 1.0], metallicFactor=0.0, roughnessFactor=0.85,
            ),
        )
        unwrapped.export(out_path)
        stats["uv_unwrapped"] = True

        from bake_ao import rasterize_uv, bake_normal_map, bake_ao, attach_orm_to_glb
        res = 1024
        pos, nrm, valid, fid = rasterize_uv(unwrapped, res)
        normal_img = None
        if bake_source is not None and len(bake_source.faces) > len(unwrapped.faces) * 1.02:
            progress(92, "bake", "Baking normal map from high-poly source...")
            normal_img = bake_normal_map(unwrapped, bake_source, pos, nrm, valid, fid)
            stats["normal_baked_from_faces"] = int(len(bake_source.faces))
        progress(95, "bake", "Baking ambient occlusion...")
        ao = bake_ao(unwrapped, res, 24, 0.3)
        attach_orm_to_glb(out_path, out_path, ao, None, None, normal_img)
        stats["ao_baked"] = True
    except Exception as e:
        log(f"unwrap/bake failed (exporting plain mesh): {e}")
        mesh.visual = trimesh.visual.ColorVisuals(mesh)
        mesh.export(out_path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--target-faces", type=int, default=0, help="0 = no decimation")
    ap.add_argument("--keep-frac", type=float, default=0.02,
                    help="components smaller than this fraction of the biggest are floaters")
    ap.add_argument("--smooth", type=int, default=0, help="Taubin smoothing iterations")
    ap.add_argument("--no-fill-holes", action="store_true")
    ap.add_argument("--rebuild", action="store_true",
                    help="TRUE retopology: Poisson surface reconstruction from scratch")
    ap.add_argument("--no-bake", action="store_true",
                    help="skip UV unwrap + normal/AO bake on the refined mesh")
    args = ap.parse_args()

    t0 = time.time()
    stats: dict = {}

    progress(5, "loading", "Loading mesh...")
    mesh = load_biggest_mesh(args.input)
    stats["faces_in"] = int(len(mesh.faces))
    stats["vertices_in"] = int(len(mesh.vertices))
    log(f"input: {stats['faces_in']} faces, {stats['vertices_in']} verts")

    if args.rebuild:
        # Rebuild path: floaters out first (they'd pollute the point cloud),
        # then reconstruct the surface from scratch.
        progress(20, "retopo", "Removing floating fragments...")
        mesh, floaters = remove_floaters(mesh, args.keep_frac)
        stats["floaters_removed"] = int(floaters)
        stats["degenerate_removed"] = 0
        bake_source = mesh.copy()  # pre-rebuild detail for the normal bake
        progress(35, "retopo", "Rebuilding surface (Poisson)...")
        mesh = rebuild_surface(mesh, args.target_faces or 40000)
        # Trimming Poisson's low-support membranes can reopen the surface —
        # close what's closable and orient consistently.
        progress(75, "retopo", "Closing and orienting...")
        try:
            mesh.merge_vertices()
            trimesh.repair.fill_holes(mesh)
            trimesh.repair.fix_normals(mesh)
        except Exception as e:
            log(f"post-rebuild cleanup partial: {e}")
        if args.smooth > 0:
            progress(85, "retopo", "Smoothing...")
            mesh = taubin_smooth(mesh, args.smooth)
            mesh.merge_vertices()
        stats["rebuilt"] = True
        stats["faces_out"] = int(len(mesh.faces))
        stats["vertices_out"] = int(len(mesh.vertices))
        stats["watertight"] = bool(mesh.is_watertight)
        if args.no_bake:
            progress(92, "exporting", "Exporting GLB...")
            mesh.visual = trimesh.visual.ColorVisuals(mesh)
            mesh.export(args.output)
        else:
            unwrap_and_bake(mesh, bake_source, args.output, stats)
        stats["time"] = round(time.time() - t0, 1)
        log(f"rebuilt: {stats['faces_in']}->{stats['faces_out']} faces, "
            f"watertight={stats['watertight']}, {stats['time']}s")
        progress(100, "done", "Rebuild complete")
        emit_result(output_path=args.output, **stats)
        return 0

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

    bake_source = mesh.copy()  # pre-decimation detail for the normal bake
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

    if args.no_bake:
        progress(92, "exporting", "Exporting GLB...")
        mesh.visual = trimesh.visual.ColorVisuals(mesh)  # plain clay
        mesh.export(args.output)
    else:
        unwrap_and_bake(mesh, bake_source, args.output, stats)

    stats["time"] = round(time.time() - t0, 1)
    log(f"refined: {stats['faces_in']}->{stats['faces_out']} faces, "
        f"{stats['floaters_removed']} floaters and {stats['degenerate_removed']} degenerates removed, "
        f"watertight={stats['watertight']}, {stats['time']}s")
    progress(100, "done", "Refine complete")
    emit_result(output_path=args.output, **stats)
    return 0


if __name__ == "__main__":
    sys.exit(main())
