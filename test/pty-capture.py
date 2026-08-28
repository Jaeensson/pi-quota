#!/usr/bin/env python3
"""Spawn pi in a real pty, let the TUI render, capture output."""
import os, pty, select, fcntl, termios, struct, time, signal, sys

cwd = "/home/rasmus/pi-zai-quota"
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.environ["TERM"] = "xterm-256color"
    os.execvp("pi", ["pi", "-e", "./zai-quota.ts"])

# Set pty window size: 40 rows x 120 cols
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

out = b""
end = time.time() + 15
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.5)
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        out += data

os.kill(pid, signal.SIGKILL)
os.waitpid(pid, 0)
with open("/tmp/pi-pty.log", "wb") as f:
    f.write(out)
print(f"captured {len(out)} bytes")
