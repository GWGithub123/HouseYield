#!/usr/bin/env python3
"""Stage 0 semantic masks for master_v1.

Produces per-frame binary masks for reflective / transmissive surfaces
(mirror, window, glass door) using an open-vocabulary Grounded-SAM-2 style
segmenter. Every downstream stage (Metric3D plane flattening, learned-match
filtering, gaussian seeding / depth supervision) routes on these masks, but the
stage is intentionally best-effort: when no segmenter endpoint is configured or
a frame fails, it writes an empty manifest and the rest of the pipeline behaves
exactly as it did before this stage existed.

Outputs:

  masks/
    mirror/<frame>.png        # uint8 0/255 binary mask
    window/<frame>.png
    glass/<frame>.png
    manifest.json             # per-frame mask paths + coverage + detections
    summary.json              # stage contract summary
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

MASK_CLASSES = ('mirror', 'window', 'glass')
DEFAULT_PROMPT = os.environ.get(
    'MASTER_PIPELINE_SEMANTIC_MASK_PROMPT',
    'mirror. window. glass door. glass wall.',
)
DEFAULT_BOX_THRESHOLD = float(os.environ.get('MASTER_PIPELINE_SEMANTIC_MASK_BOX_THRESHOLD', '0.30'))
DEFAULT_TEXT_THRESHOLD = float(os.environ.get('MASTER_PIPELINE_SEMANTIC_MASK_TEXT_THRESHOLD', '0.25'))
DEFAULT_TIMEOUT_SECONDS = float(os.environ.get('MASTER_PIPELINE_SEMANTIC_MASK_TIMEOUT_SECONDS', '30'))
DEFAULT_LOCAL_SEGMENTER_URL = os.environ.get(
    'MASTER_PIPELINE_SEMANTIC_MASK_LOCAL_URL',
    'http://127.0.0.1:8010/segment-open-vocab',
)
DEFAULT_LOCAL_HEALTH_TIMEOUT_SECONDS = float(
    os.environ.get('MASTER_PIPELINE_SEMANTIC_MASK_HEALTH_TIMEOUT_SECONDS', '120'),
)
DEFAULT_FAIL_ON_ALL_FRAME_FAILURES = (
    os.environ.get('MASTER_PIPELINE_SEMANTIC_MASK_FAIL_ON_ALL_FRAME_FAILURES', '1').strip().lower()
    not in {'0', 'false', 'no', 'off'}
)

# A label -> canonical class mapping so open-vocab synonyms collapse into the
# three mask buckets the rest of the pipeline understands.
LABEL_TO_CLASS = {
    'mirror': 'mirror',
    'window': 'window',
    'glass door': 'glass',
    'glass wall': 'glass',
    'glass': 'glass',
    'sliding glass door': 'glass',
    'french door': 'glass',
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def list_images(images_dir: Path) -> list[Path]:
    images: list[Path] = []
    for pattern in ('*.jpg', '*.jpeg', '*.png', '*.JPG', '*.JPEG', '*.PNG'):
        images.extend(images_dir.glob(pattern))
    return sorted(images)


def resolve_segmenter_url() -> str:
    configured_url = (
        os.environ.get('MASTER_PIPELINE_SEMANTIC_MASK_URL')
        or os.environ.get('GROUNDED_SAM2_URL')
        or os.environ.get('SAM2_SEGMENTER_URL')
        or ''
    ).strip()
    if configured_url:
        return configured_url
    return resolve_local_segmenter_url()


def resolve_local_segmenter_url() -> str:
    import urllib.request

    local_url = str(DEFAULT_LOCAL_SEGMENTER_URL or '').strip()
    if not local_url:
        return ''
    local_base_url = local_url.rsplit('/', 1)[0]
    health_url = f'{local_base_url}/healthz'
    timeout_seconds = max(
        2.0,
        min(DEFAULT_TIMEOUT_SECONDS, DEFAULT_LOCAL_HEALTH_TIMEOUT_SECONDS),
    )
    try:
        with urllib.request.urlopen(health_url, timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode('utf-8'))
    except Exception:
        return ''

    if payload.get('openVocabSegmenterConfigured'):
        return local_url
    return ''


def canonical_class(label: str | None) -> str | None:
    if not label:
        return None
    normalized = str(label).strip().lower()
    if normalized in LABEL_TO_CLASS:
        return LABEL_TO_CLASS[normalized]
    for key, mapped in LABEL_TO_CLASS.items():
        if key in normalized:
            return mapped
    return None


def decode_mask_png(value: str, width: int, height: int):
    """Decode a base64 PNG/numpy mask payload into a uint8 0/255 array."""
    import io

    import numpy as np
    from PIL import Image

    raw = base64.b64decode(value)
    with Image.open(io.BytesIO(raw)) as mask_image:
        mask = np.asarray(mask_image.convert('L'))
    if mask.shape[:2] != (height, width):
        with Image.fromarray(mask).resize((width, height), Image.NEAREST) as resized:
            mask = np.asarray(resized)
    return (mask > 127).astype(np.uint8) * 255


def call_segmenter(url: str, image_bytes: bytes, *, prompt: str):
    """POST a frame to the Grounded-SAM-2 endpoint and return parsed JSON."""
    import urllib.request

    api_key = (
        os.environ.get('MASTER_PIPELINE_SEMANTIC_MASK_API_KEY')
        or os.environ.get('GROUNDED_SAM2_API_KEY')
        or os.environ.get('SAM2_SEGMENTER_API_KEY')
        or ''
    )
    payload = json.dumps({
        'image': base64.b64encode(image_bytes).decode('ascii'),
        'prompt': prompt,
        'classes': list(MASK_CLASSES),
        'boxThreshold': DEFAULT_BOX_THRESHOLD,
        'textThreshold': DEFAULT_TEXT_THRESHOLD,
        'returnMasks': True,
    }).encode('utf-8')

    request = urllib.request.Request(url, data=payload, method='POST')
    request.add_header('Content-Type', 'application/json')
    if api_key:
        request.add_header('Authorization', f'Bearer {api_key}')

    with urllib.request.urlopen(request, timeout=DEFAULT_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode('utf-8'))


def union_masks(accumulator, mask):
    import numpy as np

    if accumulator is None:
        return mask.copy()
    return np.maximum(accumulator, mask)


def process_frame(*, image_path: Path, url: str, prompt: str, masks_root: Path) -> dict:
    import numpy as np
    from PIL import Image

    with Image.open(image_path) as frame_image:
        width, height = frame_image.size

    image_bytes = image_path.read_bytes()
    response = call_segmenter(url, image_bytes, prompt=prompt)

    detections_raw = (
        response.get('detections')
        or response.get('predictions')
        or response.get('instances')
        or []
    )

    class_masks: dict[str, object] = {name: None for name in MASK_CLASSES}
    detections: list[dict] = []

    for detection in detections_raw:
        label = detection.get('class') or detection.get('label') or detection.get('name')
        mapped = canonical_class(label)
        if mapped is None:
            continue
        score = float(detection.get('score') or detection.get('confidence') or 0.0)
        mask_payload = detection.get('mask') or detection.get('maskPng') or detection.get('segmentation')
        if not isinstance(mask_payload, str):
            continue
        try:
            mask = decode_mask_png(mask_payload, width, height)
        except Exception:
            continue
        class_masks[mapped] = union_masks(class_masks[mapped], mask)
        detections.append({
            'class': mapped,
            'rawLabel': label,
            'score': score,
            'box': detection.get('box') or detection.get('bbox'),
        })

    mask_paths: dict[str, str | None] = {}
    coverage: dict[str, float] = {}
    total_pixels = float(max(1, width * height))
    for name in MASK_CLASSES:
        mask = class_masks[name]
        if mask is None or int((mask > 0).sum()) == 0:
            mask_paths[name] = None
            coverage[name] = 0.0
            continue
        class_dir = ensure_dir(masks_root / name)
        rel_path = f'{name}/{image_path.stem}.png'
        Image.fromarray(mask).save(masks_root / rel_path)
        mask_paths[name] = rel_path
        coverage[name] = round(float((mask > 0).sum()) / total_pixels, 6)

    return {
        'frame': image_path.name,
        'width': width,
        'height': height,
        'masks': mask_paths,
        'coverage': coverage,
        'detections': detections,
    }


def run(args: argparse.Namespace) -> dict:
    images_dir = Path(args.images_dir)
    output_dir = ensure_dir(Path(args.output_dir))
    masks_root = ensure_dir(output_dir)
    prompt = args.prompt or DEFAULT_PROMPT

    images = list_images(images_dir)
    url = resolve_segmenter_url()

    base_summary = {
        'stage': 'semantic_masks',
        'version': 'semantic-masks-v1',
        'createdAt': now_iso(),
        'classes': list(MASK_CLASSES),
        'prompt': prompt,
        'frameCount': len(images),
    }

    manifest = {
        **base_summary,
        'status': 'ok',
        'reason': None,
        'frames': [],
    }

    if args.dry_run or not url or not images:
        reason = (
            'dry_run' if args.dry_run
            else 'segmenter_url_unset' if not url
            else 'no_input_frames'
        )
        manifest['status'] = 'skipped'
        manifest['reason'] = reason
        write_json(masks_root / 'manifest.json', manifest)
        summary = {**base_summary, 'status': 'skipped', 'reason': reason, 'maskedFrameCount': 0}
        write_json(output_dir / 'summary.json', summary)
        return summary

    masked_frame_count = 0
    failure_count = 0
    for image_path in images:
        try:
            frame_record = process_frame(
                image_path=image_path,
                url=url,
                prompt=prompt,
                masks_root=masks_root,
            )
        except Exception as error:
            failure_count += 1
            frame_record = {
                'frame': image_path.name,
                'masks': {name: None for name in MASK_CLASSES},
                'coverage': {name: 0.0 for name in MASK_CLASSES},
                'detections': [],
                'error': str(error),
            }
        if any(frame_record['masks'].get(name) for name in MASK_CLASSES):
            masked_frame_count += 1
        manifest['frames'].append(frame_record)

    if images and failure_count == len(images):
        manifest['status'] = 'failed'
        manifest['reason'] = 'all_frames_failed'
    elif masked_frame_count == 0:
        manifest['status'] = 'no_detections'

    write_json(masks_root / 'manifest.json', manifest)
    summary = {
        **base_summary,
        'status': manifest['status'],
        'reason': manifest['reason'],
        'maskedFrameCount': masked_frame_count,
        'failureCount': failure_count,
    }
    write_json(output_dir / 'summary.json', summary)
    if (
        args.fail_on_all_frame_failures
        and images
        and failure_count == len(images)
    ):
        first_error = next(
            (
                str(record.get('error'))
                for record in manifest.get('frames', [])
                if record.get('error')
            ),
            'unknown_error',
        )
        raise RuntimeError(
            f"semantic_mask_all_frames_failed: {failure_count}/{len(images)} frames failed; "
            f"first_error={first_error}"
        )
    return summary


# ---------------------------------------------------------------------------
# Downstream loader helpers (imported by metric3d / matching / gaussian stages)
# ---------------------------------------------------------------------------

def load_manifest(masks_dir: Path) -> dict | None:
    manifest_path = Path(masks_dir) / 'manifest.json'
    if not manifest_path.exists():
        return None
    try:
        return json.loads(manifest_path.read_text(encoding='utf-8'))
    except Exception:
        return None


def manifest_frame_lookup(manifest: dict | None) -> dict[str, dict]:
    if not manifest:
        return {}
    return {record.get('frame'): record for record in manifest.get('frames', []) if record.get('frame')}


def load_frame_masks(masks_dir: Path, frame_name: str, manifest: dict | None = None):
    """Return {class: uint8 0/255 ndarray} for one frame, or {} when absent."""
    import numpy as np
    from PIL import Image

    masks_dir = Path(masks_dir)
    if manifest is None:
        manifest = load_manifest(masks_dir)
    record = manifest_frame_lookup(manifest).get(frame_name)
    if not record:
        return {}

    masks: dict[str, object] = {}
    for name, rel_path in (record.get('masks') or {}).items():
        if not rel_path:
            continue
        mask_path = masks_dir / rel_path
        if not mask_path.exists():
            continue
        with Image.open(mask_path) as mask_image:
            masks[name] = (np.asarray(mask_image.convert('L')) > 127).astype(np.uint8)
    return masks


def main() -> None:
    parser = argparse.ArgumentParser(description='master_v1 semantic masks (Stage 0)')
    parser.add_argument('--job-id', required=False, default='')
    parser.add_argument('--images-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--prompt', default=DEFAULT_PROMPT)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument(
        '--fail-on-all-frame-failures',
        action=argparse.BooleanOptionalAction,
        default=DEFAULT_FAIL_ON_ALL_FRAME_FAILURES,
        help='Fail the stage when every frame raises a segmenter error. Disable with --no-fail-on-all-frame-failures.',
    )
    args = parser.parse_args()

    summary = run(args)
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
