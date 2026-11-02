"""Presentation-only CivitAI sign-in hints; never an access guarantee.

The hint must be recomputed on every render from the current local token
configuration.  Never persist authentication state on a model or assume that
a browser login means the local downloader has an authenticated API token.
"""


def version_signin_hint(source, version, token_configured=False):
    """Return 'required', 'possible', or '' for a CivitAI version.

    Only the explicitly published requireAuth flag can confirm a requirement
    or absence of one.  Paid, gated, and Early Access states remain distinct.
    """
    if source not in {'civitai', 'civitaired'} or token_configured:
        return ''
    version = version if isinstance(version, dict) else {}
    access = str(version.get('access_status') or '').lower()
    if access in {'paid_access', 'early_access', 'gated', 'unconfirmed'} or version.get('paid_access'):
        return ''
    if version.get('require_auth') is True:
        return 'required'
    if version.get('require_auth') is False:
        return ''
    return 'possible'


def current_model_signin_hint(source, card_data, token_configured=False, access_status=''):
    """Hint for a feed card's current version; conservative on old metadata."""
    if source not in {'civitai', 'civitaired'} or token_configured:
        return ''
    if str(access_status or '').lower() != 'downloadable':
        return ''
    card = card_data if isinstance(card_data, dict) else {}
    versions = card.get('versions') or []
    current_id = str(card.get('version_id') or '').strip()
    version = next((v for v in versions if isinstance(v, dict) and str(v.get('id') or '') == current_id), None) if current_id else None
    if version is None:
        version = next((v for v in versions if isinstance(v, dict)), {})
    return version_signin_hint(source, version, token_configured)
