"""nook furniture pipeline: `nook-add` (see contract/CONTRACT.md §3)."""


class NookError(Exception):
    """A failure the user can act on. The message is printed as one line on stderr."""
