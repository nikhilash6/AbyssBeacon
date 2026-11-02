"""Match installed records to source file rows without probing local disks."""
def match_installed_file(source, file, rows, fingerprint, sha256='', version_id=''):
    source_name = str(source.get('source') or '').lower()
    model_key = str(source.get('model_key') or '')
    file_id = str(file.get('model_file_id') or file.get('id') or file.get('file_id') or '')
    version_id = str(file.get('version_id') or file.get('model_version_id') or version_id or '')
    sha256 = str(sha256 or '').lower()
    for row in rows:
        if str(row.get('source') or '').lower() != source_name:
            continue
        if model_key and str(row.get('model_key') or '') != model_key:
            continue
        stored_version = str(row.get('version_id') or '')
        if version_id and stored_version and version_id != stored_version:
            continue
        verified = str(row.get('verified_sha256') or '').lower()
        if sha256 and verified and sha256 != verified:
            continue
        stored = str(row.get('file_fingerprint') or '')
        if fingerprint and stored == fingerprint:
            return row
        # Imports predate the metadata fingerprint convention. Their source file
        # identity and verified content hash remain valid; no migration needed.
        if not (row.get('imported_at') or (verified and stored.lower() == verified)
                or (sha256 and stored.lower() == sha256)):
            continue
        stored_id = str(row.get('source_file_id') or '')
        if file_id and stored_id and file_id != stored_id:
            continue
        if file_id and stored_id == file_id:
            return row
        if sha256 and (sha256 == verified or sha256 == stored.lower()):
            return row
    return None
