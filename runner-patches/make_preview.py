"""
make_preview.py <in.glb> <out.glb>

Shrinks a GLB's textures for streaming: every PNG image that is NOT a
normal map is re-encoded as JPEG q87 (normal maps stay PNG — JPEG's
block artifacts wreck tangent-space normals). Geometry is untouched;
run gltfpack -cc afterwards for mesh compression.

Typical effect on a painted Hunyuan/TRELLIS GLB: 14MB -> ~3MB.
"""

import io
import sys

from PIL import Image
from pygltflib import GLTF2


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    glb = GLTF2().load_binary(src)
    blob = bytearray(glb.binary_blob())

    normal_images = set()
    for mat in glb.materials or []:
        nt = getattr(mat, "normalTexture", None)
        if nt is not None and nt.index is not None:
            tex = glb.textures[nt.index]
            if tex.source is not None:
                normal_images.add(tex.source)

    new_blob = bytearray()
    # Rebuild the blob: copy every bufferView, re-encoding image ones.
    # Track new offsets per bufferView.
    views = glb.bufferViews or []
    img_by_view = {}
    for i, img in enumerate(glb.images or []):
        if img.bufferView is not None:
            img_by_view[img.bufferView] = i

    for vi, view in enumerate(views):
        start = view.byteOffset or 0
        data = bytes(blob[start:start + view.byteLength])
        ii = img_by_view.get(vi)
        if ii is not None and ii not in normal_images:
            img = glb.images[ii]
            if (img.mimeType or "") == "image/png":
                try:
                    pil = Image.open(io.BytesIO(data))
                    if pil.mode in ("RGBA", "LA", "P"):
                        pil = pil.convert("RGB")
                    out = io.BytesIO()
                    pil.save(out, "JPEG", quality=87)
                    j = out.getvalue()
                    if len(j) < len(data):
                        data = j
                        img.mimeType = "image/jpeg"
                except Exception as e:
                    print(f"[preview] image {ii} left as-is: {e}", flush=True)
        # 4-byte alignment
        while len(new_blob) % 4:
            new_blob += b"\x00"
        view.byteOffset = len(new_blob)
        view.byteLength = len(data)
        new_blob += data

    glb.buffers[0].byteLength = len(new_blob)
    glb.set_binary_blob(bytes(new_blob))
    glb.save_binary(dst)
    print(f"[preview] {src} -> {dst}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
