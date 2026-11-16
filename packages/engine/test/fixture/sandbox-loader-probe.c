#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <unistd.h>

/* Disposable CI control only: proves a native preload constructor executes before a namespace wrapper starts. */
__attribute__((constructor)) static void probe(void) {
  const char *target = getenv("VECTOR_PROBE_TARGET_PID");
  const char *marker = getenv("VECTOR_PROBE_LOADER_MARKER");
  if (marker) {
    int file = open(marker, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (file >= 0) {
      const char message[] = "synthetic loader constructor";
      (void)write(file, message, sizeof(message) - 1);
      close(file);
    }
  }
  if (target) {
    char *end = NULL;
    long pid = strtol(target, &end, 10);
    if (end && !*end && pid > 1) (void)kill((pid_t)pid, SIGUSR1);
  }
}
