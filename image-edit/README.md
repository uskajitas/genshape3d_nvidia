# image-edit — a local picture editor for the fleet

One picture in, one picture out, the same size, with only what the prompt asks
for changed. It runs on the 3090 box (`rtx3090`, `DESKTOP-R88GUO8`) and the
fleet reaches it as the **`image.edit`** job type. It replaces the paid cloud
editor ugen2d was using for its 2D rig poses, and costs nothing per call.

Working copy on the machine: `C:\projects\image-edit`. This folder is that copy,
kept in the repo so the service can be rebuilt from scratch.

## The model

`Qwen-Image-Edit-2509`, with its 20B bf16 transformer replaced by the Nunchaku
**SVDQuant int4** one, rank 128, in the **Lightning 8-step** flavour:

```
nunchaku-ai/nunchaku-qwen-image-edit-2509
  lightning-251115/svdq-int4_r128-qwen-image-edit-2509-lightning-8steps-251115.safetensors
```

Everything else (VAE, the 7B Qwen2.5-VL text encoder, processor, scheduler
config) comes from `Qwen/Qwen-Image-Edit-2509`. `fetch_models.py` downloads
exactly that and skips the 41 GB bf16 transformer nobody loads.

Eight steps and `true_cfg_scale=1.0` are not a shortcut: the Lightning LoRA is
already baked into the int4 checkpoint, so more steps or a CFG above 1 make the
result worse, not better. The scheduler in `server.py` is Qwen-Image-Lightning's
own — the config shipped in the repo is tuned for the 40-step model and gives
mush at 8.

## The HTTP interface

`127.0.0.1:8410`, localhost only. The kit's `services.json` entry points its
`run` at `/edit` and its `probe` at `/health`.

`GET /health` — answers immediately, whether or not the model is in memory:

```json
{ "ok": true, "model": "...", "loaded": false }
```

`POST /edit`:

```json
{ "image": "data:image/jpeg;base64,...", "prompt": "...", "seed": 0, "steps": 8 }
```

```json
{ "image": "data:image/jpeg;base64,...", "ms": 14312, "model": "..." }
```

The answer is JPEG quality 92 (4:4:4, no chroma subsampling — faces suffer from
it) and **exactly the width and height that came in**. Internally the edit is
generated at the input's aspect ratio scaled to about one megapixel on a
multiple of 32, because that is the shape Qwen was trained on; asking it for an
odd size directly costs visible quality. The result is scaled back with LANCZOS
before it is encoded, so the caller never sees that.

Failures come back as HTTP 500 with `{"error": "TypeName: message"}`.

## Sharing the GPU

The 3090 also holds the 3D pipelines and Ollama's 27B, so the editor tries to be
a good neighbour:

- **Lazy.** Nothing is loaded until the first `/edit`. `/health` stays instant.
- **Dropped when idle.** A watcher thread unloads the pipeline after
  `IMAGE_EDIT_IDLE_UNLOAD_MIN` (10) idle minutes and empties the CUDA cache.
- **One at a time.** A lock around the edit; concurrent calls queue.
- **Two load modes.** With ≥ 18.5 GB free it loads *fast*
  (`enable_model_cpu_offload`, one module on the GPU at a time). Below that it
  loads *lean*: Nunchaku streams the transformer's blocks itself and the 7B text
  encoder goes through `accelerate.cpu_offload` layer by layer. Slower, always
  fits. An out-of-memory in fast mode falls back to lean by itself.
- **It asks Ollama to let go** (`keep_alive: 0`) when VRAM is short. Ollama
  reloads on its next chat job. Set `IMAGE_EDIT_YIELD_OLLAMA=0` to stop that.

## No window, ever

This is a hard requirement, and it is the one thing here that is easy to get
wrong.

`venv\Scripts\python.exe` is a **console** program (PE subsystem 3). The pm2
daemon has no console of its own, so Windows hands every console child a brand
new console — and with Windows Terminal as the default terminal app that is a
window on the owner's screen, titled `C:\projects\image-edit\venv\Scripts\python.exe`.
Closing it does not just hide it: the Intel Fortran runtime inside numpy/MKL
traps the console CLOSE event and aborts the process
(`forrtl: error (200): program aborting due to window-CLOSE event`), pm2's
`autorestart` brings it back five seconds later, and the window pops up again.
That loop is what was appearing on the desktop.

The fix is to never be given a console in the first place:

- `ecosystem.config.js` runs **`venv\Scripts\pythonw.exe`** — the GUI-subsystem
  (2) twin of the same interpreter. The venv launcher passes the baton to the
  base `pythonw.exe`, also GUI, so neither process gets a console.
- `windowsHide: true` on the pm2 app, so any console-subsystem child stays
  hidden too.
- `pm2-resurrect.vbs` in the Startup folder runs `pm2 resurrect` through
  `WScript.Shell.Run ..., 0, False` — window style 0, hidden.

Anything added here must keep that property. In particular: never launch a
`.py`, `.env`, `.txt` or `.ps1` by its file association (`start x.py`,
`cmd /c x.env`) — Windows opens those in whatever editor is registered, which is
a window, not a process.

Because `pythonw.exe` has no stdout of its own, `server.py` writes its own log
to `logs/image-edit.log` and only *also* prints, so pm2 can mirror it into
`logs/image-edit.out.log` when its pipes are attached.

## Supervision

pm2, the same as `stream-hub` and `ugenvid-worker` on this box:

```
pm2 start ecosystem.config.js
pm2 save                       # writes ~/.pm2/dump.pm2
```

`pm2-resurrect.vbs` in
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` replays that dump at
login, hidden. `autorestart` with a 5 s delay covers crashes.

Logs, all under `C:\projects\image-edit\logs`:

| file | what |
|---|---|
| `image-edit.log` | the server's own log (authoritative) |
| `image-edit.out.log` / `.err.log` | pm2's copy of stdout / stderr |
| `fetch.log`, `fetch2.log` | model downloads |

## Installing from nothing

Python 3.11, Windows, an sm_86 card (the 3090) for Nunchaku's INT4 kernels.

```
py -3.11 -m venv venv
venv\Scripts\python -m pip install torch==2.8.0 torchvision==0.23.0 ^
    --index-url https://download.pytorch.org/whl/cu128
venv\Scripts\python -m pip install -r requirements.txt
venv\Scripts\python fetch_models.py          # ~23 GB base + ~12 GB transformer
pm2 start ecosystem.config.js && pm2 save
```

The Nunchaku wheel is pinned by URL in `requirements.txt`: it is not on PyPI
(the `nunchaku` name there is an unrelated package) and the build has to match
python 3.11 + torch 2.8 + cu12.8 exactly.

Downloads resume — `fetch_models.py` is safe to re-run and picks up the
`.incomplete` blobs in the HF cache where it left off.

## Environment

| variable | default | |
|---|---|---|
| `IMAGE_EDIT_HOST` / `IMAGE_EDIT_PORT` | `127.0.0.1` / `8410` | |
| `IMAGE_EDIT_IDLE_UNLOAD_MIN` | `10` | idle minutes before the model is dropped |
| `IMAGE_EDIT_STEPS` | `8` | Lightning's number; leave it |
| `IMAGE_EDIT_FAST_MODE_FREE_GB` | `18.5` | free VRAM needed for fast mode |
| `IMAGE_EDIT_YIELD_OLLAMA` | `1` | ask Ollama to unload when VRAM is short |
| `IMAGE_EDIT_TRANSFORMER` | the 8-step int4 file | to try another quant |
| `IMAGE_EDIT_LOG` | `logs/image-edit.log` | |

## Calling it

Through the fleet, which is the point:

```js
submit_job({ type: 'image.edit', input: { image: 'data:image/jpeg;base64,…', prompt: '…' } })
```

Write prompts that say what must **not** change — Qwen-Image-Edit will happily
redraw a whole face if you only tell it about the mouth:

> Edit this picture. Change ONLY the mouth and jaw: mouth wide open, jaw
> dropped, as when saying AH. Keep the eyes, brows, nose, hair and everything
> else exactly as they are. The head must not move, grow or shrink.
