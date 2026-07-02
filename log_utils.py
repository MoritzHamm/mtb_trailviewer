"""
Shared logging helpers for the tile-generation scripts.

- log(msg)      : timestamped, permanent line (always ends with a newline)
- Progress(...) : an in-place, \\r-refreshed progress line with an ETA,
                   so long tile loops don't flood the log with one line
                   per checkpoint. Call .done() to end the line before
                   the next log() call.
"""

import sys
import time

__all__ = ["log", "Progress"]

_progress_active = False


def _timestamp() -> str:
    return time.strftime("%H:%M:%S")


def _fmt_duration(seconds: float) -> str:
    if seconds == float("inf") or seconds != seconds:  # inf or NaN
        return "?"
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m{s:02d}s"
    if m:
        return f"{m}m{s:02d}s"
    return f"{s}s"


def log(msg: str = "") -> None:
    """Print a timestamped line. Ends any open progress line first."""
    global _progress_active
    if _progress_active:
        sys.stdout.write("\n")
        _progress_active = False
    sys.stdout.write(f"[{_timestamp()}] {msg}\n" if msg else "\n")
    sys.stdout.flush()


class Progress:
    """Overwrites a single line in place, with elapsed time + ETA."""

    def __init__(self, total: int):
        self.total = total
        self.start = time.monotonic()
        self._last_len = 0

    def update(self, done: int, suffix: str = "") -> None:
        global _progress_active
        elapsed = time.monotonic() - self.start
        rate = done / elapsed if elapsed > 0 else 0
        eta = _fmt_duration((self.total - done) / rate) if rate > 0 else "?"
        pct = 100 * done / self.total if self.total else 100
        line = (f"[{_timestamp()}] {done}/{self.total} ({pct:.0f}%)"
                f"{'  ' + suffix if suffix else ''}"
                f"  elapsed {_fmt_duration(elapsed)}  ETA {eta}")
        pad = max(self._last_len - len(line), 0)
        sys.stdout.write("\r" + line + " " * pad)
        sys.stdout.flush()
        self._last_len = len(line)
        _progress_active = True

    def done(self) -> None:
        global _progress_active
        if _progress_active:
            sys.stdout.write("\n")
            sys.stdout.flush()
            _progress_active = False
