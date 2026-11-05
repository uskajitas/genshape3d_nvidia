# The RTX 3090 worker contract

Every agent reads this before changing the worker, the picture services or the worker window.
If code and this page disagree, the code is wrong.

## One source of truth

`ugpu` owns the card, the queue and the ledger on the 3090 (`ugpu/docs/CONTRACT.md`). Everything on
the card is a job there. The worker is one customer: it runs 3D work and asks `ugpu` for its turn,
and keeps no line or lease of its own. Only when `ugpu` is not running does it check the card memory
itself. Where this page says the worker owns the ledger, read `ugpu`.

- Every piece of work on the card has one entry: 3D models, paints, repairs, parts, pictures and
  edits.
- An entry has one status: waiting, running, done, failed or cancelled.
- The ledger is on disk, so a worker restart loses nothing.
- Only the worker writes it. The worker window and the queue read it. No service keeps its own
  count, list or lease.
- It needs no network. If the i7 or the LAN goes down, the window stays right and the running job
  carries on.

## The i7 database is the post office

The database on the i7 is where work arrives and where results are published. It decides nothing
about this machine.

- A job row in the database is a request. The worker copies it into the ledger and takes it from
  there.
- The worker writes status back to the database so the apps can show it. That copy only ever goes
  one way, from the ledger to the database.
- A cancel in the database is a request. The ledger decides what happened.
- If the database cannot be reached, finished work waits in the ledger and is delivered when it
  returns. The window says so in red.

## A process obeys its entry

A running entry names its process. Each check, the worker makes the machine match the ledger:

- Entry is running, process is gone: the entry becomes failed, with the reason.
- Entry is not running, process is alive: the process and all its children are killed.

## The card

- One entry runs at a time. The card is busy only if a running entry says so.
- A running 3D job is never disturbed.
- Nothing is turned away. Work waits in the ledger, in order. A waiting picture goes when the
  running job ends, before the next 3D job.

## Every job ends

- Every entry ends as done, failed or cancelled, and failed always has a reason in plain words.
- No job runs past 30 minutes. The longest real job in 90 days took 17.
- Cancel means the process is dead, not just that a status changed.
- A job never downloads a model. Missing weights fail in seconds, saying what is missing.

## Readiness

At start the worker checks every model for its runner and its weights, and publishes the answer.
A model that is not ready is not offered.

## Done means tested

Nothing is finished until these pass on the real 3090:

1. Send a job, it finishes.
2. Cancel mid-run, the process is dead and the next job starts.
3. Send two at once, they run one after the other.
4. Send a picture during a 3D job, it waits, then runs.
5. Ask for a model with missing weights, it fails in seconds with the reason.
6. Cut the i7 mid-job: the job finishes, the window stays right, and the result is delivered when
   the i7 returns.
7. Restart the worker mid-job, the entry ends as failed with the reason and nothing is stuck.
8. After every test above, the window matches the ledger exactly.
