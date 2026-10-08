#include <CoreFoundation/CoreFoundation.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>

// Only a random task-owned preference domain/object is created by this fixture.
int main(int argc, char **argv) {
  if (argc != 4) return 2;
  CFStringRef domain = CFStringCreateWithCString(NULL, argv[2], kCFStringEncodingUTF8);
  const CFStringRef key = CFSTR("controlledFixture");
  if (!strcmp(argv[1], "seed")) {
    CFPreferencesSetAppValue(key, CFSTR("synthetic-value"), domain);
    int ok = CFPreferencesAppSynchronize(domain);
    int fd = shm_open(argv[3], O_CREAT | O_EXCL | O_RDWR, 0600);
    if (fd >= 0) { ftruncate(fd, 4096); close(fd); }
    CFRelease(domain); return ok && fd >= 0 ? 0 : 3;
  }
  if (!strcmp(argv[1], "cleanup")) {
    CFPreferencesSetAppValue(key, NULL, domain);
    int ok = CFPreferencesAppSynchronize(domain);
    shm_unlink(argv[3]); CFRelease(domain); return ok ? 0 : 4;
  }
  CFPropertyListRef value = CFPreferencesCopyAppValue(key, domain);
  if (!strcmp(argv[1], "read")) {
    int ok = value && CFEqual(value, CFSTR("synthetic-value"));
    if (value) CFRelease(value); CFRelease(domain); return ok ? 0 : 5;
  }
  int deniedRead = value == NULL;
  if (value) CFRelease(value);
  CFPreferencesSetAppValue(key, CFSTR("forbidden-change"), domain);
  int deniedWrite = !CFPreferencesAppSynchronize(domain);
  int unlisted = shm_open(argv[3], O_RDONLY, 0);
  int deniedObject = unlisted < 0; if (unlisted >= 0) close(unlisted);
  char counter[128]; snprintf(counter, sizeof(counter), "apple.cfprefs.%uv1", getuid());
  int readFd = shm_open(counter, O_RDONLY, 0);
  int allowedCacheRead = readFd >= 0; if (readFd >= 0) close(readFd);
  int writeFd = shm_open(counter, O_RDWR, 0);
  int deniedCacheWrite = writeFd < 0; if (writeFd >= 0) close(writeFd);
  printf("{\"preferenceReadDenied\":%d,\"preferenceWriteDenied\":%d,\"unlistedShmDenied\":%d,\"cacheReadAllowed\":%d,\"cacheWriteDenied\":%d}\n",
    deniedRead, deniedWrite, deniedObject, allowedCacheRead, deniedCacheWrite);
  CFRelease(domain);
  return deniedRead && deniedWrite && deniedObject && allowedCacheRead && deniedCacheWrite ? 0 : 6;
}
