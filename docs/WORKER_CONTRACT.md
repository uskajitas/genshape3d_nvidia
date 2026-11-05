# The RTX 3090 worker contract

Every agent reads this before changing the worker, the picture services or the worker window.
If code and this page disagree, the code is wrong.

## One source of truth

The database is the only truth about work on the 3090.

- Every piece of work has one row: 3D models, paints, repairs, parts, pictures and edits.
- A row has one status: waiting, running, done, failed or cancelled.
- Nothing else decides anything. No counter in memory, no list in memory, no lease held by a
  service. If the worker restarts, it loses nothing, because it held nothing.
- The worker window, the tray, the apps and the queue all read the same rows. None of them keeps
  its own copy.

## A process obeys its row

A running row names its process. Each check, the worker makes the machine match the database:

- Row is running, process is gone: the row becomes failed, with the reason.
- Row is not running, process is alive: the process and all its children are killed.

The database is never corrected to match memory. The machine is corrected to match the database.

## The card

- One row runs at a time. The card is busy only if a running row says so.
- A running 3D job is never disturbed.
- Nothing is turned away. Work waits as a row, in order. A waiting picture goes when the running
  job ends, before the next 3D job.

## Every job ends

- Every row ends as done, failed or cancelled, and failed always has a reason in plain words.
- No job runs past 30 minutes. The longest real job in 90 days took 17.
- Cancel means the process is dead, not just that the row changed.
- A job never downloads a model. Missing weights fail in seconds, saying what is missing.

## Readiness

At start the worker checks every model for its runner and its weights, and writes the answer to
the database. A model that is not ready is not offered.

## Done means tested

Nothing is finished until these pass on the real 3090:

1. Send a job, it finishes.
2. Cancel mid-run, the process is dead and the next job starts.
3. Send two at once, they run one after the other.
4. Send a picture during a 3D job, it waits, then runs.
5. Ask for a model with missing weights, it fails in seconds with the reason.
6. Cut the database, the window says so in red, and work resumes when it returns.
7. Restart the worker mid-job, the row ends as failed with the reason and nothing is stuck.
8. After every test above, the window matches the database exactly.
