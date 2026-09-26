"""Local image editor for the fleet: Qwen-Image-Edit-2509, int4 (Nunchaku SVDQuant).

One picture in, one picture out, same size, only what the prompt asks changed.
Free replacement for the paid cloud editor ugen2d used for its 2D rigs.

The model is loaded while the server starts, in a background thread, so the port
answers at once and the first /edit finds the pipeline already in memory. A
request never downloads anything: the weights are resolved once at startup and
every load after that is local_files_only. A download inside the first request is
what made every fleet job die at the caller's 300 s timeout.
"""

from __future__ import annotations

import base64
import binascii
import gc
import inspect
import io
import json
import math
import os
import re
import threading
import time
import traceback
import urllib.error
import urllib.request
from typing import Optional

import torch
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from PIL import Image
from pydantic import BaseModel

# --- settings -----------------------------------------------------------------

HOST = os.environ.get("IMAGE_EDIT_HOST", "127.0.0.1")
PORT = int(os.environ.get("IMAGE_EDIT_PORT", "8410"))

MODEL_NAME = "Qwen-Image-Edit-2509 (Nunchaku SVDQuant int4, rank 128, Lightning 8-step)"
BASE_REPO = "Qwen/Qwen-Image-Edit-2509"
NUNCHAKU_REPO = "nunchaku-ai/nunchaku-qwen-image-edit-2509"
NUNCHAKU_FILE = os.environ.get(
    "IMAGE_EDIT_TRANSFORMER",
    "lightning-251115/svdq-int4_r128-qwen-image-edit-2509-lightning-8steps-251115.safetensors",
)

DEFAULT_STEPS = int(os.environ.get("IMAGE_EDIT_STEPS", "8"))
JPEG_QUALITY = 92
# The cold load is minutes of reading 29 GB off the disk, so the pipeline is kept
# across a long idle stretch instead of being rebuilt for every straggling job.
# Keeping it costs almost no VRAM: fast mode parks the weights in host RAM and
# walks one module at a time across the bus.
IDLE_UNLOAD_SEC = float(os.environ.get("IMAGE_EDIT_IDLE_UNLOAD_MIN", "60")) * 60
PRELOAD = os.environ.get("IMAGE_EDIT_PRELOAD", "1") not in ("0", "false", "no")
# Everything resident at once needs about this much free; below it we stream the
# weights off the CPU instead, which is slower but always fits.
FAST_MODE_FREE_GB = float(os.environ.get("IMAGE_EDIT_FAST_MODE_FREE_GB", "18.5"))
LEAN_MODE_FREE_GB = float(os.environ.get("IMAGE_EDIT_LEAN_MODE_FREE_GB", "7.0"))
# Ollama keeps a 27B model pinned in VRAM on this box. Ask it to let go when
# there is not enough room; it reloads by itself on its next chat job.
OLLAMA_URL = os.environ.get("IMAGE_EDIT_OLLAMA", "http://127.0.0.1:11434")
YIELD_OLLAMA = os.environ.get("IMAGE_EDIT_YIELD_OLLAMA", "1") not in ("0", "false", "no")

# Qwen-Image-Lightning's own scheduler; the repo default is for the 40-step model.
LIGHTNING_SCHEDULER = {
    "base_image_seq_len": 256,
    "base_shift": math.log(3),
    "invert_sigmas": False,
    "max_image_seq_len": 8192,
    "max_shift": math.log(3),
    "num_train_timesteps": 1000,
    "shift": 1.0,
    "shift_terminal": None,
    "stochastic_sampling": False,
    "time_shift_type": "exponential",
    "use_beta_sigmas": False,
    "use_dynamic_shifting": True,
    "use_exponential_sigmas": False,
    "use_karras_sigmas": False,
}


@asynccontextmanager
async def lifespan(_app: "FastAPI"):
    """Bring the model up beside the server, not inside the first request."""
    threading.Thread(target=idle_watch, daemon=True).start()
    log(f"image-edit listening on http://{HOST}:{PORT} - {MODEL_NAME}")
    if PRELOAD:
        threading.Thread(target=preload, name="preload", daemon=True).start()
    yield


app = FastAPI(title="image-edit", lifespan=lifespan)
_log_lock = threading.Lock()

# Under pm2 this runs as pythonw.exe so that it can never be given a console
# window. A GUI-subsystem interpreter has no stdout of its own, so the log goes
# to a file we open ourselves; printing as well is harmless and lets pm2 mirror
# it into logs/image-edit.out.log when stdout happens to be a real pipe.
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
LOG_FILE = os.environ.get("IMAGE_EDIT_LOG", os.path.join(LOG_DIR, "image-edit.log"))


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}"
    with _log_lock:
        try:
            os.makedirs(LOG_DIR, exist_ok=True)
            with open(LOG_FILE, "a", encoding="utf-8") as fh:
                print(line, file=fh)
        except OSError:
            pass
        try:
            print(line, flush=True)
        except (OSError, ValueError, AttributeError):
            pass  # pythonw.exe with no stdout attached


# --- nunchaku 1.2.1 against diffusers 0.40 ------------------------------------


def bridge_to_diffusers(transformer) -> None:
    """Teach nunchaku's transformer the calling convention diffusers 0.40 uses.

    Nunchaku 1.2.1 is written against diffusers 0.36 (what its CI pins), and two
    things moved in between, both around the text length that RoPE needs:

    * `QwenEmbedRope.forward` was `(video_fhw, max_txt_seq_len, device)` and is
      now `(video_fhw, device, max_txt_seq_len)`. Nunchaku passes the length
      positionally *and* device by keyword, so the call dies outright with
      `QwenEmbedRope.forward() got multiple values for argument 'device'`.
    * the pipeline no longer passes `txt_seq_lens` to the transformer at all;
      0.40 derives the length from the mask inside its own forward. Nunchaku's
      forward never learned that and hands RoPE a `None`.

    Both are bridged here. Pinning diffusers back to 0.36 would be the other
    way out, but it would drag transformers back below 5 with it, and the text
    encoder is loaded by transformers.
    """
    from diffusers.models.transformers.transformer_qwenimage import (
        compute_text_seq_len_from_mask,
    )

    rope = getattr(transformer, "pos_embed", None)
    if rope is not None:
        order = list(inspect.signature(type(rope).forward).parameters)
        if "device" in order and "max_txt_seq_len" in order:
            if order.index("device") < order.index("max_txt_seq_len"):
                unbound = type(rope).forward

                def rope_forward(video_fhw, max_txt_seq_len=None, device=None, **kw):
                    # nunchaku's second positional argument is a list of lengths;
                    # 0.40 wants the single number RoPE is sized for.
                    if isinstance(max_txt_seq_len, (list, tuple)):
                        max_txt_seq_len = max(max_txt_seq_len) if max_txt_seq_len else None
                    return unbound(
                        rope, video_fhw, device=device, max_txt_seq_len=max_txt_seq_len, **kw
                    )

                rope.forward = rope_forward

    inner = transformer.forward

    def forward(*args, **kwargs):
        if kwargs.get("txt_seq_lens") is None and kwargs.get("encoder_hidden_states") is not None:
            # Exactly how 0.40's own transformer sizes RoPE, so the bridge cannot
            # drift from it: the full encoder sequence length, mask or no mask.
            seq_len, _, _ = compute_text_seq_len_from_mask(
                kwargs["encoder_hidden_states"], kwargs.get("encoder_hidden_states_mask")
            )
            kwargs["txt_seq_lens"] = [int(seq_len)]
        return inner(*args, **kwargs)

    transformer.forward = forward


# --- the model ----------------------------------------------------------------


class Editor:
    """Holds the pipeline, and nothing else while it is not being used."""

    def __init__(self) -> None:
        self.lock = threading.Lock()   # one edit at a time; the rest queue
        self.pipe = None
        self.mode = None
        self.last_used = 0.0
        # The weights are fetched once, at startup, and never from inside a
        # request. Until this is set, /edit refuses instead of waiting.
        self.weights = threading.Event()
        self.weights_lock = threading.Lock()
        self.weights_error: Optional[str] = None
        self.transformer_path: Optional[str] = None
        self.loading = False

    # -- the weights on disk --

    def ensure_weights(self) -> None:
        """Resolve both repos to local files, downloading whatever is missing.

        Only ever called off the request path: a download is minutes to hours,
        and the fleet's HTTP client gives up after 300 s.
        """
        if self.weights.is_set():
            return
        with self.weights_lock:
            if self.weights.is_set():
                return
            from huggingface_hub import hf_hub_download, snapshot_download

            base_kw = {
                "ignore_patterns": ["transformer/*.safetensors", "transformer/*.index.json"]
            }
            t0 = time.time()
            try:
                self.transformer_path = hf_hub_download(
                    NUNCHAKU_REPO, NUNCHAKU_FILE, local_files_only=True
                )
                snapshot_download(BASE_REPO, local_files_only=True, **base_kw)
                log("weights already on disk")
            except Exception:  # noqa: BLE001 - any cache miss means: go and fetch
                log("weights incomplete; fetching (not on a request path)")
                try:
                    snapshot_download(BASE_REPO, max_workers=4, **base_kw)
                    self.transformer_path = hf_hub_download(NUNCHAKU_REPO, NUNCHAKU_FILE)
                except Exception as e:  # noqa: BLE001
                    self.weights_error = f"{type(e).__name__}: {e}"
                    log(f"weights could not be fetched: {self.weights_error}")
                    raise
                log(f"weights fetched in {time.time() - t0:.0f}s")
            self.weights_error = None
            self.weights.set()

    # -- VRAM housekeeping --

    @staticmethod
    def free_gb() -> float:
        free, _total = torch.cuda.mem_get_info()
        return free / 1e9

    @staticmethod
    def used_gb() -> float:
        free, total = torch.cuda.mem_get_info()
        return (total - free) / 1e9

    @staticmethod
    def ask_ollama_to_unload() -> bool:
        """Drop Ollama's pinned models. It reloads them on its next request."""
        try:
            with urllib.request.urlopen(f"{OLLAMA_URL}/api/ps", timeout=5) as r:
                loaded = json.loads(r.read()).get("models", [])
        except (urllib.error.URLError, OSError, ValueError):
            return False
        freed = False
        for m in loaded:
            name = m.get("model") or m.get("name")
            if not name:
                continue
            req = urllib.request.Request(
                f"{OLLAMA_URL}/api/generate",
                data=json.dumps({"model": name, "keep_alive": 0}).encode(),
                headers={"content-type": "application/json"},
            )
            try:
                urllib.request.urlopen(req, timeout=120).read()
                log(f"asked ollama to unload {name} ({m.get('size_vram', 0) / 1e9:.1f} GB)")
                freed = True
            except (urllib.error.URLError, OSError):
                log(f"could not ask ollama to unload {name}")
        if freed:
            time.sleep(3)
        return freed

    # -- load / unload --

    def _build(self, lean: bool):
        from diffusers import FlowMatchEulerDiscreteScheduler, QwenImageEditPlusPipeline
        from nunchaku.models.transformers.transformer_qwenimage import (
            NunchakuQwenImageTransformer2DModel,
        )

        # The path was resolved at startup, and the base repo is read with
        # local_files_only: a load can never turn into a download, neither at
        # startup nor on the request that follows an idle unload.
        # The native int4 transformer must use Nunchaku's block offloader even
        # in fast mode. Moving the whole native model with accelerate works for
        # one edit, then the next call retains its prior CUDA allocations until
        # VRAM is exhausted and the process access-violates. Accelerate still
        # offloads the text encoder and VAE as whole modules in fast mode.
        transformer = NunchakuQwenImageTransformer2DModel.from_pretrained(
            self.transformer_path, torch_dtype=torch.bfloat16, offload=False
        )
        # The wheel's default pins every CPU block. On this 32 GB host that
        # exhausted CUDA's host allocation during preload, despite free VRAM.
        transformer.set_offload(True, use_pin_memory=False)
        bridge_to_diffusers(transformer)
        scheduler = FlowMatchEulerDiscreteScheduler.from_config(LIGHTNING_SCHEDULER)
        pipe = QwenImageEditPlusPipeline.from_pretrained(
            BASE_REPO,
            transformer=transformer,
            scheduler=scheduler,
            torch_dtype=torch.bfloat16,
            local_files_only=True,
        )
        pipe.set_progress_bar_config(disable=True)
        if lean:
            # Nunchaku streams the transformer's blocks itself; the text encoder
            # (7B, the biggest piece) goes layer by layer through accelerate.
            from accelerate import cpu_offload

            cpu_offload(pipe.text_encoder, execution_device=torch.device("cuda"))
            pipe.vae.to("cuda")
        else:
            # One whole module on the GPU at a time: peak is the text encoder.
            pipe.enable_model_cpu_offload()
        return pipe

    def ensure_loaded(self) -> None:
        if self.pipe is not None:
            return
        if not self.weights.is_set():
            raise RuntimeError(
                "model weights are not on disk yet"
                + (f" ({self.weights_error})" if self.weights_error else " (being fetched)")
            )
        free = self.free_gb()
        if free < FAST_MODE_FREE_GB and YIELD_OLLAMA and self.ask_ollama_to_unload():
            free = self.free_gb()
        lean = free < FAST_MODE_FREE_GB
        if lean and free < LEAN_MODE_FREE_GB:
            log(f"only {free:.1f} GB of VRAM free; loading lean anyway")
        t0 = time.time()
        self.loading = True
        log(f"loading {MODEL_NAME} ({'lean' if lean else 'fast'} mode, {free:.1f} GB free)")
        try:
            try:
                self.pipe = self._build(lean)
                self.mode = "lean" if lean else "fast"
            except torch.cuda.OutOfMemoryError:
                if lean:
                    raise
                log("out of memory in fast mode; falling back to lean")
                self.pipe = None
                gc.collect()
                torch.cuda.empty_cache()
                self.pipe = self._build(True)
                self.mode = "lean"
        finally:
            self.loading = False
        log(
            f"loaded in {time.time() - t0:.0f}s ({self.mode} mode); "
            f"{self.used_gb():.1f} GB of VRAM in use"
        )

    def unload(self, why: str) -> None:
        if self.pipe is None:
            return
        self.pipe = None
        self.mode = None
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()
        log(f"unloaded ({why}); {self.free_gb():.1f} GB free")

    # -- the edit itself --

    def edit(self, image: Image.Image, prompt: str, seed: Optional[int], steps: Optional[int]):
        w, h = image.size
        gw, gh = generation_size(w, h)
        self.ensure_loaded()
        self.last_used = time.time()
        generator = torch.Generator(device="cpu").manual_seed(int(seed) if seed is not None else 0)
        out = self.pipe(
            image=[image],
            prompt=prompt,
            negative_prompt=" ",
            height=gh,
            width=gw,
            num_inference_steps=int(steps or DEFAULT_STEPS),
            true_cfg_scale=1.0,
            num_images_per_prompt=1,
            generator=generator,
        ).images[0]
        self.last_used = time.time()
        if out.size != (w, h):
            out = out.resize((w, h), Image.LANCZOS)
        return out


editor = Editor()


def preload() -> None:
    """Fetch what is missing, then load, while the server already answers."""
    try:
        editor.ensure_weights()
    except Exception:  # noqa: BLE001 - already logged, and /edit says why
        return
    try:
        with editor.lock:
            editor.ensure_loaded()
        # Start the idle clock now, so a server nobody calls still lets go
        # eventually instead of holding the weights for ever.
        editor.last_used = time.time()
    except Exception as e:  # noqa: BLE001
        log(f"preload failed: {e!r}\n{traceback.format_exc()}")


def generation_size(w: int, h: int) -> "tuple[int, int]":
    """The size to generate at: the input's aspect, ~1 megapixel, multiple of 32.

    Qwen was trained around a megapixel; asking it for the caller's exact odd
    size costs quality, so we generate at a size it likes and scale back after.
    """
    scale = math.sqrt(1024 * 1024 / max(1, w * h))
    gw = max(256, int(round(w * scale / 32)) * 32)
    gh = max(256, int(round(h * scale / 32)) * 32)
    return gw, gh


# --- HTTP ---------------------------------------------------------------------

DATA_URL = re.compile(r"^data:(?P<mime>[\w/+.-]+)?;base64,", re.I)


def decode_image(value: str) -> Image.Image:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("image must be a data URL or base64 string")
    raw = DATA_URL.sub("", value.strip())
    try:
        blob = base64.b64decode(raw, validate=False)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f"image is not valid base64: {e}") from e
    try:
        return Image.open(io.BytesIO(blob)).convert("RGB")
    except OSError as e:
        raise ValueError(f"image could not be read: {e}") from e


def encode_jpeg(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=JPEG_QUALITY, subsampling=0)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


class EditRequest(BaseModel):
    image: str
    prompt: str
    seed: Optional[int] = None
    steps: Optional[int] = None


@app.get("/health")
def health():
    """Answers at once, whatever the model happens to be doing."""
    return {
        "ok": True,
        "model": MODEL_NAME,
        "loaded": editor.pipe is not None,
        "loading": editor.loading,
        "weights": editor.weights.is_set(),
        "mode": editor.mode,
    }


@app.post("/edit")
def edit(req: EditRequest):
    t0 = time.time()
    try:
        image = decode_image(req.image)
        prompt = (req.prompt or "").strip()
        if not prompt:
            raise ValueError("prompt is empty")
        if not editor.weights.wait(timeout=30):
            # Startup resolves cached weights in the background. Give a request
            # arriving at the same instant a chance to join the cold load.
            return JSONResponse(
                status_code=503,
                content={"error": "model weights are still being fetched; retry later"},
            )
        with editor.lock:
            out = editor.edit(image, prompt, req.seed, req.steps)
        ms = int((time.time() - t0) * 1000)
        log(f"edit {image.size[0]}x{image.size[1]} in {ms} ms ({editor.mode}): {prompt[:70]}")
        return {"image": encode_jpeg(out), "ms": ms, "model": MODEL_NAME}
    except Exception as e:  # every failure is an HTTP 500 with a readable reason
        log(f"edit failed after {int((time.time() - t0) * 1000)} ms: {e!r}\n{traceback.format_exc()}")
        return JSONResponse(status_code=500, content={"error": f"{type(e).__name__}: {e}"})


def idle_watch() -> None:
    while True:
        time.sleep(30)
        if editor.pipe is None or editor.last_used == 0:
            continue
        if time.time() - editor.last_used < IDLE_UNLOAD_SEC:
            continue
        if editor.lock.acquire(blocking=False):
            try:
                if time.time() - editor.last_used >= IDLE_UNLOAD_SEC:
                    editor.unload(f"idle {IDLE_UNLOAD_SEC / 60:.0f} min")
            finally:
                editor.lock.release()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
