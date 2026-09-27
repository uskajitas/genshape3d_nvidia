"""
bake_ao.py — bake an ambient-occlusion map for a textured GLB and attach it
as the glTF material's occlusionTexture.

Pure geometry: rasterize the mesh's UV layout to a texel grid (position +
normal per texel), fire cosine-weighted hemisphere rays with open3d's
embree RaycastingScene, and write 1 - occluded_fraction as a grayscale PNG
appended to the GLB via pygltflib (new image/texture; existing buffer views
untouched). No AI model involved, so it runs in seconds on CPU.

UV convention: trimesh flips glTF V to bottom-left on load, so image row is
y = (1 - v) * H — the PNG comes out in glTF texture space directly.

Usage:
  python bake_ao.py --glb in.glb --out out.glb [--res 1024] [--samples 24]
"""

from __future__ import annotations

import argparse
import io
import struct
import sys
import time

import numpy as np
import trimesh
import open3d as o3d
from PIL import Image
from pygltflib import GLTF2, Image as GltfImage, Texture, BufferView, OcclusionTextureInfo


def log(msg: str) -> None:
    print(f"[bake_ao] {msg}", flush=True)


def pick_mesh(path: str) -> trimesh.Trimesh:
    loaded = trimesh.load(path, force="scene", process=False)
    meshes = [g for g in loaded.geometry.values()
              if isinstance(g, trimesh.Trimesh)
              and g.visual is not None
              and getattr(g.visual, "uv", None) is not None
              and len(g.visual.uv) == len(g.vertices)]
    if not meshes:
        raise RuntimeError("no UV-mapped mesh found in GLB")
    return max(meshes, key=lambda m: len(m.faces))


def load_any_mesh(path: str) -> trimesh.Trimesh:
    """Load the largest mesh regardless of UVs (normal-bake sources are raw
    shape meshes without a UV layout)."""
    loaded = trimesh.load(path, force="scene", process=False)
    meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
    if not meshes:
        raise RuntimeError("no mesh found in source")
    return max(meshes, key=lambda m: len(m.faces))


def rasterize_uv(mesh: trimesh.Trimesh, res: int):
    """Return per-texel world position, normal, and a valid mask (res x res)."""
    uv = np.asarray(mesh.visual.uv, dtype=np.float64)
    faces = mesh.faces
    verts = mesh.vertices
    vnorm = mesh.vertex_normals

    pos = np.zeros((res, res, 3), dtype=np.float64)
    nrm = np.zeros((res, res, 3), dtype=np.float64)
    fid = np.full((res, res), -1, dtype=np.int64)
    valid = np.zeros((res, res), dtype=bool)

    # Image space: x = u * res, y = (1 - v) * res  (glTF top-left origin).
    px = uv[:, 0] * (res - 1)
    py = (1.0 - uv[:, 1]) * (res - 1)

    for f_index, f in enumerate(faces):
        xs, ys = px[f], py[f]
        x0, x1 = int(np.floor(xs.min())), int(np.ceil(xs.max()))
        y0, y1 = int(np.floor(ys.min())), int(np.ceil(ys.max()))
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, res - 1), min(y1, res - 1)
        if x1 < x0 or y1 < y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        # Barycentric coordinates in UV space
        v0 = np.array([xs[1] - xs[0], ys[1] - ys[0]])
        v1 = np.array([xs[2] - xs[0], ys[2] - ys[0]])
        d00, d01, d11 = v0 @ v0, v0 @ v1, v1 @ v1
        denom = d00 * d11 - d01 * d01
        if abs(denom) < 1e-12:
            continue
        v2x = gx - xs[0]
        v2y = gy - ys[0]
        d20 = v2x * v0[0] + v2y * v0[1]
        d21 = v2x * v1[0] + v2y * v1[1]
        b1 = (d11 * d20 - d01 * d21) / denom
        b2 = (d00 * d21 - d01 * d20) / denom
        b0 = 1.0 - b1 - b2
        eps = -1e-4
        inside = (b0 >= eps) & (b1 >= eps) & (b2 >= eps)
        if not inside.any():
            continue
        yy, xx = gy[inside], gx[inside]
        w0, w1, w2 = b0[inside][:, None], b1[inside][:, None], b2[inside][:, None]
        pos[yy, xx] = w0 * verts[f[0]] + w1 * verts[f[1]] + w2 * verts[f[2]]
        n = w0 * vnorm[f[0]] + w1 * vnorm[f[1]] + w2 * vnorm[f[2]]
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        nrm[yy, xx] = n
        fid[yy, xx] = f_index
        valid[yy, xx] = True

    return pos, nrm, valid, fid


def cosine_hemisphere(n_samples: int) -> np.ndarray:
    """Fixed low-discrepancy cosine-weighted directions in +Z hemisphere."""
    i = np.arange(n_samples) + 0.5
    phi = i * (np.pi * (3.0 - np.sqrt(5.0)))          # golden angle
    r2 = i / n_samples
    st = np.sqrt(r2)
    return np.stack([st * np.cos(phi), st * np.sin(phi), np.sqrt(1.0 - r2)], axis=1)


def bake_ao(mesh: trimesh.Trimesh, res: int, samples: int, max_dist_frac: float):
    t0 = time.time()
    pos, nrm, valid, _fid = rasterize_uv(mesh, res)
    n_texels = int(valid.sum())
    log(f"rasterized UV: {n_texels} texels covered ({time.time()-t0:.1f}s)")

    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(
        o3d.core.Tensor(np.asarray(mesh.vertices, dtype=np.float32)),
        o3d.core.Tensor(np.asarray(mesh.faces, dtype=np.uint32)),
    )

    diag = float(np.linalg.norm(mesh.bounds[1] - mesh.bounds[0]))
    max_dist = diag * max_dist_frac
    origin_eps = diag * 1e-3

    P = pos[valid]
    N = nrm[valid]
    local_dirs = cosine_hemisphere(samples)

    # Orthonormal basis per texel (branchless Frisvad-ish)
    up = np.where(np.abs(N[:, 2:3]) < 0.99, np.array([0.0, 0.0, 1.0]), np.array([1.0, 0.0, 0.0]))
    t1v = np.cross(up, N)
    t1v /= np.maximum(np.linalg.norm(t1v, axis=1, keepdims=True), 1e-12)
    t2v = np.cross(N, t1v)

    hits = np.zeros(len(P), dtype=np.float32)
    CHUNK = max(1, 2_000_000 // samples)  # texels per batch
    for s in range(0, len(P), CHUNK):
        e = min(s + CHUNK, len(P))
        k = e - s
        # world dirs: (k, samples, 3)
        d = (local_dirs[None, :, 0:1] * t1v[s:e, None, :]
             + local_dirs[None, :, 1:2] * t2v[s:e, None, :]
             + local_dirs[None, :, 2:3] * N[s:e, None, :])
        o = np.repeat(P[s:e], samples, axis=0) + np.repeat(N[s:e], samples, axis=0) * origin_eps
        rays = np.concatenate([o.astype(np.float32), d.reshape(-1, 3).astype(np.float32)], axis=1)
        ans = scene.cast_rays(o3d.core.Tensor(rays))
        t_hit = ans["t_hit"].numpy().reshape(k, samples)
        hits[s:e] = (t_hit < max_dist).mean(axis=1)

    ao_vals = 1.0 - hits
    ao = np.ones((res, res), dtype=np.float32)
    ao[valid] = ao_vals
    log(f"raycast done: {len(P) * samples} rays ({time.time()-t0:.1f}s total)")

    # Dilate valid texels outward so bilinear sampling at UV island edges
    # doesn't blend with the white background (visible seams otherwise).
    v = valid.copy()
    for _ in range(6):
        inv = ~v
        acc = np.zeros((res, res), dtype=np.float32)
        cnt = np.zeros((res, res), dtype=np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                src_v = np.roll(np.roll(v, dy, axis=0), dx, axis=1)
                src_a = np.roll(np.roll(ao, dy, axis=0), dx, axis=1)
                m = inv & src_v
                acc[m] += src_a[m]
                cnt[m] += 1.0
        newly = inv & (cnt > 0)
        ao[newly] = acc[newly] / cnt[newly]
        v = v | newly

    return np.clip(ao, 0.0, 1.0)


def face_tangents(mesh: trimesh.Trimesh) -> np.ndarray:
    """Per-face tangent vectors from UV gradients (standard TBN construction)."""
    uv = np.asarray(mesh.visual.uv, dtype=np.float64)
    v = np.asarray(mesh.vertices)
    f = mesh.faces
    p0, p1, p2 = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    u0, u1, u2 = uv[f[:, 0]], uv[f[:, 1]], uv[f[:, 2]]
    e1, e2 = p1 - p0, p2 - p0
    d1, d2 = u1 - u0, u2 - u0
    det = d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]
    det = np.where(np.abs(det) < 1e-12, 1e-12, det)
    r = (1.0 / det)[:, None]
    t = (e1 * d2[:, 1][:, None] - e2 * d1[:, 1][:, None]) * r
    n = np.linalg.norm(t, axis=1, keepdims=True)
    return t / np.maximum(n, 1e-12)


def bake_normal_map(
    low_mesh: trimesh.Trimesh, high_mesh: trimesh.Trimesh,
    pos: np.ndarray, nrm: np.ndarray, valid: np.ndarray, fid: np.ndarray,
) -> np.ndarray:
    """Transfer the high-poly mesh's surface normals onto the low mesh's UV
    layout as a tangent-space normal map. For every covered texel: closest
    point on the high mesh -> barycentric-interpolated high normal ->
    express in the texel's TBN frame. Texels too far from the high surface
    (UV seams, mismatched regions) fall back to flat (0.5, 0.5, 1)."""
    import open3d as o3d
    res = pos.shape[0]

    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(
        o3d.core.Tensor(np.asarray(high_mesh.vertices, dtype=np.float32)),
        o3d.core.Tensor(np.asarray(high_mesh.faces, dtype=np.uint32)),
    )
    hv_norm = np.asarray(high_mesh.vertex_normals)
    hf = high_mesh.faces

    P = pos[valid].astype(np.float32)
    N = nrm[valid]
    F = fid[valid]
    ans = scene.compute_closest_points(o3d.core.Tensor(P))
    prim = ans["primitive_ids"].numpy().astype(np.int64)
    puv = ans["primitive_uvs"].numpy().astype(np.float64)
    closest = ans["points"].numpy().astype(np.float64)

    # Interpolate high-mesh vertex normals with the barycentric coordinates.
    tri = hf[prim]
    w0 = (1.0 - puv[:, 0] - puv[:, 1])[:, None]
    w1 = puv[:, 0][:, None]
    w2 = puv[:, 1][:, None]
    hn = w0 * hv_norm[tri[:, 0]] + w1 * hv_norm[tri[:, 1]] + w2 * hv_norm[tri[:, 2]]
    hn /= np.maximum(np.linalg.norm(hn, axis=1, keepdims=True), 1e-12)

    # Reject transfers across too large a gap (different parts of the mesh).
    diag = float(np.linalg.norm(low_mesh.bounds[1] - low_mesh.bounds[0]))
    too_far = np.linalg.norm(closest - P.astype(np.float64), axis=1) > diag * 0.025
    # Also reject opposing normals (front face matched to back face).
    flipped = np.einsum("ij,ij->i", hn, N) < 0.0
    bad = too_far | flipped
    hn[bad] = N[bad]

    # Tangent frame per texel from the low mesh's face tangents.
    tangents = face_tangents(low_mesh)
    T = tangents[F]
    T = T - N * np.einsum("ij,ij->i", T, N)[:, None]
    T /= np.maximum(np.linalg.norm(T, axis=1, keepdims=True), 1e-12)
    B = np.cross(N, T)

    ts = np.stack([
        np.einsum("ij,ij->i", hn, T),
        np.einsum("ij,ij->i", hn, B),
        np.einsum("ij,ij->i", hn, N),
    ], axis=1)
    ts /= np.maximum(np.linalg.norm(ts, axis=1, keepdims=True), 1e-12)

    img = np.zeros((res, res, 3), dtype=np.float32)
    img[..., 0] = 0.5
    img[..., 1] = 0.5
    img[..., 2] = 1.0
    img[valid] = ts * 0.5 + 0.5

    # Edge dilation (same reason as AO): bleed valid texels outward so
    # bilinear sampling at UV island borders doesn't hit flat/blank texels.
    v = valid.copy()
    for _ in range(4):
        inv = ~v
        acc = np.zeros((res, res, 3), dtype=np.float32)
        cnt = np.zeros((res, res), dtype=np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                src_v = np.roll(np.roll(v, dy, axis=0), dx, axis=1)
                src_i = np.roll(np.roll(img, dy, axis=0), dx, axis=1)
                m = inv & src_v
                acc[m] += src_i[m]
                cnt[m] += 1.0
        newly = inv & (cnt > 0)
        img[newly] = acc[newly] / cnt[newly][:, None]
        v = v | newly

    return np.clip(img, 0.0, 1.0)


def _load_gray(path: str | None, res: int) -> np.ndarray | None:
    if not path:
        return None
    try:
        img = Image.open(path).convert("L").resize((res, res), Image.LANCZOS)
        return np.asarray(img, dtype=np.uint8)
    except Exception as e:
        log(f"could not load map {path}: {e}")
        return None


def _append_png(glb, blob_holder, img: Image.Image, name: str) -> int:
    """Append a PNG image to the GLB binary blob; returns its texture index."""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    png = buf.getvalue()
    blob = blob_holder[0]
    pad = (-len(blob)) % 4
    offset = len(blob) + pad
    blob_holder[0] = blob + b"\x00" * pad + png
    glb.bufferViews.append(BufferView(buffer=0, byteOffset=offset, byteLength=len(png)))
    glb.images.append(GltfImage(bufferView=len(glb.bufferViews) - 1, mimeType="image/png", name=name))
    glb.textures.append(Texture(source=len(glb.images) - 1, name=name))
    return len(glb.textures) - 1


def attach_orm_to_glb(
    glb_path: str, out_path: str, ao: np.ndarray,
    metallic_path: str | None = None, roughness_path: str | None = None,
    normal_img: np.ndarray | None = None,
) -> None:
    """Pack ORM (R=AO, G=roughness, B=metallic) into ONE texture appended to
    the GLB, referenced as both occlusionTexture and (when M/R maps exist)
    metallicRoughnessTexture — the glTF-recommended packing. The paint
    pipeline generates metallic/roughness maps but the OBJ→GLB conversion
    drops them, leaving metallicFactor=1.0 (everything fully metallic);
    this restores them. Existing buffer views are untouched."""
    res = ao.shape[0]
    r = (ao * 255).astype(np.uint8)
    g = _load_gray(roughness_path, res)
    b = _load_gray(metallic_path, res)
    has_mr = g is not None and b is not None
    if g is None:
        g = np.full((res, res), 255, dtype=np.uint8)
    if b is None:
        b = np.zeros((res, res), dtype=np.uint8)

    glb = GLTF2().load(glb_path)
    blob_holder = [glb.binary_blob()]

    orm = np.stack([r, g, b], axis=2)
    tex_index = _append_png(glb, blob_holder, Image.fromarray(orm, mode="RGB"), "orm")

    normal_index = None
    if normal_img is not None:
        normal_index = _append_png(
            glb, blob_holder,
            Image.fromarray((normal_img * 255).astype(np.uint8), mode="RGB"), "normal")

    glb.set_binary_blob(blob_holder[0])
    glb.buffers[0].byteLength = len(blob_holder[0])

    from pygltflib import TextureInfo, NormalMaterialTexture
    for mat in glb.materials:
        mat.occlusionTexture = OcclusionTextureInfo(index=tex_index, strength=1.0)
        if has_mr and mat.pbrMetallicRoughness is not None:
            mat.pbrMetallicRoughness.metallicRoughnessTexture = TextureInfo(index=tex_index, texCoord=0)
            # The texture now carries the values — factors become multipliers.
            mat.pbrMetallicRoughness.metallicFactor = 1.0
            mat.pbrMetallicRoughness.roughnessFactor = 1.0
        if normal_index is not None:
            mat.normalTexture = NormalMaterialTexture(index=normal_index, scale=1.0)
    glb.save(out_path)
    log(f"ORM attached (AO{' + metallic/roughness' if has_mr else ' only'}{' + normal' if normal_index is not None else ''})")


def finalize(
    glb_in: str, glb_out: str,
    metallic_path: str | None = None, roughness_path: str | None = None,
    res: int = 1024, samples: int = 24, max_dist_frac: float = 0.3,
    source_mesh_path: str | None = None,
) -> None:
    """Bake AO (and, when a higher-poly source is given, a tangent-space
    normal map) and pack everything into the GLB. Raises on failure —
    callers decide whether that's fatal (the worker treats it as non-fatal)."""
    t0 = time.time()
    mesh = pick_mesh(glb_in)
    log(f"mesh: {len(mesh.faces)} faces, {len(mesh.vertices)} verts")

    pos, nrm, valid, fid = rasterize_uv(mesh, res)
    n_texels = int(valid.sum())
    log(f"rasterized UV: {n_texels} texels covered")

    normal_img = None
    if source_mesh_path:
        try:
            high = load_any_mesh(source_mesh_path)
            if len(high.faces) > len(mesh.faces) * 1.02:
                normal_img = bake_normal_map(mesh, high, pos, nrm, valid, fid)
                log(f"normal map baked from {len(high.faces)}-face source")
            else:
                log(f"source has no extra detail ({len(high.faces)} vs {len(mesh.faces)} faces) — skipping normal bake")
        except Exception as e:
            log(f"normal bake skipped: {e}")

    ao = bake_ao(mesh, res, samples, max_dist_frac)
    attach_orm_to_glb(glb_in, glb_out, ao, metallic_path, roughness_path, normal_img)
    log(f"finalize done in {time.time()-t0:.1f}s -> {glb_out}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--metallic", default=None)
    ap.add_argument("--roughness", default=None)
    ap.add_argument("--source-mesh", default=None,
                    help="higher-poly source GLB to bake a normal map from")
    ap.add_argument("--res", type=int, default=1024)
    ap.add_argument("--samples", type=int, default=24)
    ap.add_argument("--max-dist-frac", type=float, default=0.3)
    args = ap.parse_args()
    finalize(args.glb, args.out, args.metallic, args.roughness,
             args.res, args.samples, args.max_dist_frac,
             source_mesh_path=args.source_mesh)
    return 0


if __name__ == "__main__":
    sys.exit(main())
