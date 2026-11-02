"""File-level evidence shared by the download chooser and local installer.

Never use file size, card titles or descriptions to identify a component.
"""
from pathlib import PurePosixPath


def file_purpose(record):
    record = record or {}
    value = str(record.get('file_type') or record.get('type') or record.get('kind') or '').strip().casefold().replace('_', ' ')
    categories = (
        (('lora', 'lycoris', 'locon', 'lokr'), 'LoRA', 'loras'),
        (('vae',), 'VAE', 'vae'),
        (('text encoder', 'textencoder', 'clip'), 'Text encoder', 'text_encoders'),
        (('diffusion model', 'unet'), 'Diffusion model', 'diffusion_models'),
        (('checkpoint',), 'Checkpoint', 'checkpoints'),
        (('controlnet',), 'ControlNet', 'controlnet'),
        (('textual inversion', 'embedding'), 'Embedding', 'embeddings'),
        (('upscaler', 'upscale'), 'Upscaler', 'upscale_models'),
    )
    for values, label, category in categories:
        if value in values:
            return label, category
    path = str(record.get('repository_path') or (record.get('path') if not record.get('version_id') and not record.get('version') else '') or record.get('name') or '').replace('\\', '/')
    # Only actual directory segments identify repository components. A basename
    # such as model.safetensors or a repository's marketing name is insufficient.
    segments = PurePosixPath(path.casefold()).parts[:-1]
    for segment in reversed(segments):
        if segment in {'vae', 'vaes'}:
            return 'VAE', 'vae'
        if segment in {'text_encoder', 'text_encoder_2', 'text_encoder_3', 'text_encoders', 'clip', 'clip_l', 'clip_g', 't5'}:
            return 'Text encoder', 'text_encoders'
        if segment in {'unet', 'transformer', 'diffusion_model', 'diffusion_models'}:
            return 'Diffusion model', 'diffusion_models'
        if segment in {'lora', 'loras'}:
            return 'LoRA', 'loras'
    return '', ''


def annotate_file_details(record, source=''):
    """Decorate a render copy; keep original source fields and identity intact."""
    name = str(record.get('original_filename') or record.get('name') or record.get('filename') or record.get('path') or 'Model file')
    record['_download_name'] = name
    path = str(record.get('repository_path') or record.get('path') or '')
    record['_download_path'] = path if source in {'huggingface', 'modelscope'} and path != name else ''
    record['_download_purpose'] = file_purpose(record)[0]
    primary = record.get('source_primary')
    record['_download_relationship'] = 'Primary download' if primary is True else ('Additional file' if primary is False else '')
    record['_download_file_id'] = str(record.get('model_file_id') or record.get('id') or record.get('file_id') or '')
    metadata = record.get('metadata') if isinstance(record.get('metadata'), dict) else {}
    precision = [str(record.get('fp') or metadata.get('fp') or ''), str(record.get('quantization') or metadata.get('quantization') or '')]
    record['_download_precision'] = ' · '.join(dict.fromkeys(value for value in precision if value))
    record['_download_format'] = str(record.get('format') or metadata.get('format') or '')
    return record
