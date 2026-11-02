"""Conservative, read-only identification of extensionless downloaded files."""
import json
import struct
from pathlib import Path

_MAX_HEADER = 100 * 1024 * 1024


def detect_extension(path):
    """Return a known extension or None; never load executable model contents."""
    path = Path(path)
    try:
        size = path.stat().st_size
        with path.open('rb') as stream:
            prefix = stream.read(8)
            if len(prefix) == 8:
                length = struct.unpack('<Q', prefix)[0]
                if 2 <= length <= _MAX_HEADER and length <= size - 8:
                    try:
                        header = json.loads(stream.read(length).decode('utf-8'))
                    except (ValueError, UnicodeError):
                        header = None
                    if isinstance(header, dict):
                        tensors = [(k, v) for k, v in header.items() if k != '__metadata__']
                        valid = tensors and all(
                            isinstance(v, dict) and isinstance(v.get('dtype'), str)
                            and isinstance(v.get('shape'), list)
                            and all(type(n) is int and n >= 0 for n in v['shape'])
                            and isinstance(v.get('data_offsets'), list)
                            and len(v['data_offsets']) == 2
                            and all(type(n) is int for n in v['data_offsets'])
                            and 0 <= v['data_offsets'][0] <= v['data_offsets'][1] <= size - 8 - length
                            for _, v in tensors
                        )
                        if valid:
                            offsets = sorted(v['data_offsets'] for _, v in tensors)
                            valid = offsets[0][0] == 0 and offsets[-1][1] == size - 8 - length and all(
                                left[1] == right[0] for left, right in zip(offsets, offsets[1:])
                            )
                        if valid:
                            return '.safetensors'
        # ZIP is also a container for formats such as PyTorch checkpoints;
        # its signature alone does not establish the correct extension.
        if size <= 8 * 1024 * 1024:
            with path.open('r', encoding='utf-8-sig') as stream:
                obj = json.load(stream)
            if isinstance(obj, (dict, list)):
                return '.json'
    except (OSError, ValueError, UnicodeError, TypeError, struct.error):
        pass
    return None


def needs_extension(filename):
    """A numeric version suffix is not a file extension (e.g. 'v1.0')."""
    suffix = Path(str(filename)).suffix
    return not suffix or suffix[1:].isdigit()
