# deploying garden

The site is a C program that serves itself. Deployment is one shell script and
one small daemon, and after the first setup a `git push` is the only thing
that ever changes what is running. No ssh, no rsync, no manual `make`.

    push -> github webhook -> hookd -> deploy.sh -> fetch, build, restart

Nothing in this repository knows the hostname it will be served under, the
user it will run as, or where it will be checked out. All three live in
`/etc/garden/garden.conf`, and the unit files and vhost are templates that
`bootstrap.sh` fills in.

## what runs

| unit | what | port |
|---|---|---|
| `garden` | the site. GET only, single threaded, loopback | 8000 |
| `garden-hook` | the deploy webhook and the gallery api, loopback | 8001 |
| `nginx` | the only thing listening publicly | 80 |

nginx sends `/deploy` and `/api/` to `hookd` and everything else to `garden`.
Both back ends bind `127.0.0.1`, so nginx is the only way in.

`hookd` is a separate process rather than a branch inside `garden.c` for two
reasons: `garden` speaks GET and has no notion of a request body, and this is
the program that restarts `garden` — a server cannot restart itself and still
answer the request that asked it to.

## first time

Requires a Debian-ish box with `git`, `make`, a C compiler, `nginx`, `curl`
and `luajit` (or `lua5.1`), and a user with sudo.

1. **Clone.** A public repo clones over https, so the box needs no key and no
   credentials of any kind — it only ever reads.

       mkdir -p ~/repos && cd ~/repos
       git clone https://github.com/<you>/garden.git
       cd garden

2. **Bootstrap.** Generates the secret, writes the config, builds, installs
   both units and the vhost, and health-checks the result.

       SERVER_NAMES="example.com www.example.com" ./deploy/bootstrap.sh

   `SERVER_NAMES` is the hostnames nginx should answer to. It is remembered,
   so later runs can leave it out. Re-running is safe: the secret is never
   regenerated, because doing so silently would break an existing webhook and
   the failure would look like a network fault.

3. **Add the webhook**, on github, under *settings → hooks → new*:

   | field | value |
   |---|---|
   | payload url | `http://<your host>/deploy` |
   | content type | `application/json` |
   | secret | `sudo grep DEPLOY_SECRET /etc/garden/garden.conf` |
   | events | just the push event |

That is the whole of it. `bootstrap.sh` is the last thing that needs ssh.

## after that

    git push            # this is the deploy

Check what is actually serving:

    curl http://<your host>/api/status
    {"sha":"…","built_at":"…","unit_active":"active"}

`sha` is written only after the build **and** the health check have both
passed, so it can never claim a commit that is not the one answering. That is
what makes a deploy assertable rather than assumed: push, then poll until the
sha matches what you pushed.

Deploy by hand, still without ssh:

    HOST=http://example.com DEPLOY_SECRET=… ./deploy/trigger.sh
    HOST=http://example.com ./deploy/trigger.sh status

## what a deploy does

    fetch -> reset --hard -> make clean && make -> restart -> health check

- **`reset --hard`, not `pull`.** Whatever the branch says is what serves.
  Local edits on the box are not a thing that exists.
- **`clean` is not optional.** A hard reset rewrites every source mtime to now
  while the old objects keep theirs. That is enough for `make` to get the
  comparison wrong occasionally, and the failure is a deploy that reports
  success while serving the old code.
- **Health means answering**, not "systemd started it". The socket is bound
  before lua is loaded, so a broken `render.lua` still binds.
- **Rollback.** If the build or the health check fails, the previous commit is
  restored, rebuilt and restarted. A failed deploy leaves the site up on the
  old commit and `/api/status` still reporting it.
- **One at a time**, under a lockfile. Two pushes a second apart would
  otherwise interleave one reset with the other's build.
- If `src/hookd.c` changed, `hookd` is restarted by systemd *after* the script
  exits — it cannot restart itself while it is the thing running the deploy.

Logs: `/var/lib/garden/deploy.log`, and `journalctl -u garden-hook`.

## security

- `/deploy` takes github's `X-Hub-Signature-256` (HMAC-SHA256 over the raw
  body) or an `Authorization: Bearer` token. Both compare in constant time. A
  request carrying neither is refused — there is no third branch.
- `hookd` carries its own SHA-256, so it links neither lua nor libcrypto.
  `make check` runs it against the FIPS 180-4 and RFC 4231 vectors.
- The gallery is **publicly writable**. Submissions are rebuilt field by field
  against a whitelist rather than filtered: unknown keys are dropped, numbers
  are clamped to the range the control offers, enums must match exactly. Body
  capped at 2K, five posts per minute per IP, two hundred entries total, and
  no file uploads at all. There is no moderation — names are the one string
  strangers control, and they are rendered with `textContent`.
- `garden.conf` is `640`, owned `root:<service user>`. It lives outside the
  repo because `deploy.sh` runs a hard reset, and a secret in the working tree
  would be destroyed by it — or committed.

## files

    deploy.sh                    the deploy itself
    src/hookd.c                  webhook + gallery api
    deploy/bootstrap.sh          one-time setup, renders the templates
    deploy/trigger.sh            deploy or query status by hand
    deploy/garden.service        unit template
    deploy/garden-hook.service   unit template
    deploy/nginx-garden.conf     vhost template

State, none of it in the repo:

    /etc/garden/garden.conf      secret, ports, paths, hostnames
    /var/lib/garden/deployed.sha the commit that is serving
    /var/lib/garden/gallery.tsv  shared backgrounds
    /var/lib/garden/deploy.log

## a caveat about generated media

`.gitignore` excludes `site/media/*.webm`, `*.mp4`, `*.opus` and `*.mp3` as
generated. They are therefore **not** restored by a fresh clone, and a clone
onto a box that had them will be missing them. `git reset --hard` leaves
ignored files alone, so a deploy will not remove them — but re-cloning from
scratch will. Copy them aside first. The encoding commands are in
`blocks/colophon.note`.
