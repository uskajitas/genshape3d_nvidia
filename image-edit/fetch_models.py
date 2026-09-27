"""Download exactly what the server needs: the base pipeline without its 41 GB
bf16 transformer, plus the Nunchaku int4 transformer that replaces it."""
from huggingface_hub import snapshot_download, hf_hub_download

BASE = "Qwen/Qwen-Image-Edit-2509"
NUNCHAKU_REPO = "nunchaku-ai/nunchaku-qwen-image-edit-2509"
NUNCHAKU_FILE = "lightning-251115/svdq-int4_r128-qwen-image-edit-2509-lightning-8steps-251115.safetensors"

if __name__ == "__main__":
    p = snapshot_download(
        BASE,
        ignore_patterns=["transformer/*.safetensors", "transformer/*.index.json"],
        max_workers=4,
    )
    print("base:", p, flush=True)
    q = hf_hub_download(NUNCHAKU_REPO, NUNCHAKU_FILE)
    print("transformer:", q, flush=True)
