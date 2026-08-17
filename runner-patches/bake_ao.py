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


def rasterize_uv(mesh: trimesh.Trimesh, res: int):
    """Return per-texel world position, normal, and a valid mask (res x res)."""
    uv = np.asarray(mesh.visual.uv, dtype=np.float64)
    faces = mesh.faces
    verts = mesh.vertices
    vnorm = mesh.vertex_normals

    pos = np.zeros((res, res, 3), dtype=np.float64)
    nrm = np.zeros((res, res, 3), dtype=np.float64)
    valid = np.zeros((res, res), dtype=bool)

    # Image space: x = u * res, y = (1 - v) * res  (glTF top-left origin).
    px = uv[:, 0] * (res - 1)
    py = (1.0 - uv[:, 1]) * (res - 1)

    for f in faces:
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
        valid[yy, xx] = True

    return pos, nrm, valid


def cosine_hemisphere(n_samples: int) -> np.ndarray:
    """Fixed low-discrepancy cosine-weighted directions in +Z hemisphere."""
    i = np.arange(n_samples) + 0.5
    phi = i * (np.pi * (3.0 - np.sqrt(5.0)))          # golden angle
    r2 = i / n_samples
    st = np.sqrt(r2)
    return np.stack([st * np.cos(phi), st * np.sin(phi), np.sqrt(1.0 - r2)], axis=1)


def bake_ao(mesh: trimesh.Trimesh, res: int, samples: int, max_dist_frac: float):
    t0 = time.time()
    pos, nrm, valid = rasterize_uv(mesh, res)
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


def _load_gray(path: str | None, res: int) -> np.ndarray | None:
    if not path:
        return None
    try:
        img = Image.open(path).convert("L").resize((res, res), Image.LANCZOS)
        return np.asarray(img, dtype=np.uint8)
    except Exception as e:
        log(f"could not load map {path}: {e}")
        return None


def attach_orm_to_glb(
    glb_path: str, out_path: str, ao: np.ndarray,
    metallic_path: str | None = None, roughness_path: str | None = None,
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

    orm = np.stack([r, g, b], axis=2)
    buf = io.BytesIO()
    Image.fromarray(orm, mode="RGB").save(buf, format="PNG")
    png = buf.getvalue()

    glb = GLTF2().load(glb_path)
    blob = glb.binary_blob()
    # 4-byte alignment for the appended chunk
    pad = (-len(blob)) % 4
    offset = len(blob) + pad
    glb.set_binary_blob(blob + b"\x00" * pad + png)
    glb.buffers[0].byteLength = offset + len(png)

    glb.bufferViews.append(BufferView(buffer=0, byteOffset=offset, byteLength=len(png)))
    glb.images.append(GltfImage(bufferView=len(glb.bufferViews) - 1, mimeType="image/png", name="orm"))
    glb.textures.append(Texture(source=len(glb.images) - 1, name="orm"))
    tex_index = len(glb.textures) - 1
    for mat in glb.materials:
        mat.occlusionTexture = OcclusionTextureInfo(index=tex_index, strength=1.0)
        if has_mr and mat.pbrMetallicRoughness is not None:
            from pygltflib import TextureInfo
            mat.pbrMetallicRoughness.metallicRoughnessTexture = TextureInfo(index=tex_index, texCoord=0)
            # The texture now carries the values — factors become multipliers.
            mat.pbrMetallicRoughness.metallicFactor = 1.0
            mat.pbrMetallicRoughness.roughnessFactor = 1.0
    glb.save(out_path)
    log(f"ORM attached (AO{' + metallic/roughness' if has_mr else ' only'})")


def finalize(
    glb_in: str, glb_out: str,
    metallic_path: str | None = None, roughness_path: str | None = None,
    res: int = 1024, samples: int = 24, max_dist_frac: float = 0.3,
) -> None:
    """Bake AO and pack ORM into the GLB. Raises on failure — callers decide
    whether that's fatal (the worker treats it as non-fatal)."""
    t0 = time.time()
    mesh = pick_mesh(glb_in)
    log(f"mesh: {len(mesh.faces)} faces, {len(mesh.vertices)} verts")
    ao = bake_ao(mesh, res, samples, max_dist_frac)
    attach_orm_to_glb(glb_in, glb_out, ao, metallic_path, roughness_path)
    log(f"finalize done in {time.time()-t0:.1f}s -> {glb_out}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--metallic", default=None)
    ap.add_argument("--roughness", default=None)
    ap.add_argument("--res", type=int, default=1024)
    ap.add_argument("--samples", type=int, default=24)
    ap.add_argument("--max-dist-frac", type=float, default=0.3)
    args = ap.parse_args()
    finalize(args.glb, args.out, args.metallic, args.roughness,
             args.res, args.samples, args.max_dist_frac)
    return 0


if __name__ == "__main__":
    sys.exit(main())
