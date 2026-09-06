# Instructions for any agent working in `genshape3d_nvidia`

See `../CLAUDE.md` for the machine-wide rules. The one below is not optional.

## COMMIT AND PUSH. ALWAYS. THIS IS RULE ZERO.

**Commit and push after every working change. Never work longer than
15 minutes without pushing.**

This is not tidiness. On 2026-08-21 an agent worked five hours without
committing, the auto-deploy watcher ran `git reset --hard origin/main`,
and all five hours were destroyed. It then happened a SECOND time, sixty
seconds after a commit — because the commit was never pushed.

**A commit that is not pushed does not exist.** The auto-deploy watcher
that caused this is RETIRED (2026-09-04) — it no longer resets anything,
but that doesn't make unpushed work safe. Anything only on disk, and
anything only committed locally, is not backed up anywhere else.

Every single time something works:

```bash
git add -A && git commit -m "what changed" && git push origin main
```

- After each fix that compiles and passes tests. Not at the end.
- Before answering the user. Before any pause. Before any build.
- Before running anything that pulls, resets, deploys or restarts.
- If you are about to say `Finished`, you have already pushed.

Never `git reset --hard`, `git checkout -- .` or `git clean -fd` on work
you did not personally write and push. If a sync refuses because of local
changes, `git stash` them — a stash can be recovered, a reset cannot.

The work is not saved when it runs. It is saved when it is on the remote.
