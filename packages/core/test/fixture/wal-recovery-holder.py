# Puts a WAL database's -shm file in the state another process leaves it in while it runs WAL recovery
# (walIndexRecover in SQLite): the DMS byte (128) held shared, the first 32 KiB region present with an
# uninitialised (zero) wal-index header, and the WAL write lock (120) plus the checkpoint and recover locks
# (121-122) held exclusively. A connection that opens the database meanwhile gets SQLITE_BUSY_RECOVERY.
#
#     python3 -I test/fixture/wal-recovery-holder.py <database>-shm <hold ms>
#
# Prints HELD once the locks are held. After <hold ms> it prints RELEASING with the wall-clock time in
# milliseconds, then drops the recovery locks. It exits when its stdin closes.
import fcntl
import os
import sys
import time

shm, hold = sys.argv[1], int(sys.argv[2])
fd = os.open(shm, os.O_RDWR | os.O_CREAT, 0o600)
fcntl.lockf(fd, fcntl.LOCK_SH | fcntl.LOCK_NB, 1, 128)
os.ftruncate(fd, 32768)
fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 3, 120)
print("HELD", flush=True)
time.sleep(hold / 1000)
print(f"RELEASING {time.time_ns() // 1_000_000}", flush=True)
fcntl.lockf(fd, fcntl.LOCK_UN, 3, 120)
sys.stdin.read()
