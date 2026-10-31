# Who is alive

- An omp process is alive when its endpoint `/tmp/omp-<uid>/peers/<pid>.sock` accepts a connection. An omp that crashed or was killed with `kill -9` leaves the file behind but refuses connections, so it is not listed; reboot empties the directory.
- Each live process is then asked for its main sessions. `alive, session list unavailable` means the process accepted the connection but did not list its sessions within 2 s; it is still alive.
- `idle` / `busy` is whether that session's main turn was running when it was listed.
- A session id changes on `/new` and on resume. List again instead of reusing an id from earlier in the conversation.
- Nothing is pushed: arrivals and exits show up the next time you list.
- `Other omp processes without omp-peers` come from omp's own project presence records whose pid is still running. They are candidates: a record can outlive its process and a pid can be reused. They cannot be asked or messaged.
