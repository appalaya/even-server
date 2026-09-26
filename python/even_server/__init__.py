"""Even sync server, Python reference implementation of PROTOCOL.md v1.

The server stores client-encrypted envelopes per group and hands them back in
order. It has no code path that can receive or derive the encryption key.
"""

import sys

if sys.version_info < (3, 14):  # checked before any 3.14-only syntax is compiled
    raise SystemExit("even-server requires Python 3.14 or newer; this is " + sys.version.split()[0])

__version__ = "1.0.0"
