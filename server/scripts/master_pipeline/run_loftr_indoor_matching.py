#!/usr/bin/env python3
"""Run learned matching priors for master_v1.

This stage supports four local backends behind the same downstream contract:

- HLOC DISK + LightGlue as the primary sparse frontend with EfficientLoFTR pair
    rescue for low-texture interiors (the default production hybrid)
- EfficientLoFTR (loftr_indoor) pairwise matching for low-texture interiors
- RoMa v2 pairwise dense matching with geometric verification
- Fast3r pairwise matching implemented from Fast3r multiview point maps

All backends emit the same COLMAP-importable feature and match stores so the
current global SfM stage can stay unchanged.
"""

from __future__ import annotations

import argparse
import bisect
import json
import os
import itertools
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HLOC_AVAILABLE = False
HLOC_LIGHTGLUE_MATCHER_KEY = None
HLOC_SUPERPOINT_FEATURE_KEY = None
HLOC_DISK_FEATURE_KEY = None
try:
    import h5py
    from hloc import extract_features, match_features

    HLOC_AVAILABLE = True
except ImportError:
    h5py = None
    extract_features = None
    match_features = None


def resolve_hloc_feature_key() -> str | None:
    confs = getattr(extract_features, 'confs', {}) if extract_features is not None else {}
    preferred_keys = ('superpoint_max', 'superpoint_aachen', 'superpoint')
    for key in preferred_keys:
        if key in confs:
            return key
    for key in confs:
        if 'superpoint' in key:
            return key
    return None


def resolve_hloc_lightglue_matcher_key() -> str | None:
    confs = getattr(match_features, 'confs', {}) if match_features is not None else {}
    preferred_keys = ('superpoint+lightglue', 'lightglue')
    for key in preferred_keys:
        if key in confs:
            return key
    for key in confs:
        if 'lightglue' in key and 'superpoint' in key:
            return key
    for key in confs:
        if 'lightglue' in key:
            return key
    return None


def resolve_hloc_disk_feature_key() -> str | None:
    confs = getattr(extract_features, 'confs', {}) if extract_features is not None else {}
    preferred_keys = ('disk', 'disk-max', 'disk_depth', 'disk_sparse')
    for key in preferred_keys:
        if key in confs:
            return key
    for key in confs:
        if 'disk' in key.lower():
            return key
    return None


def resolve_hloc_disk_lightglue_matcher_key() -> str | None:
    confs = getattr(match_features, 'confs', {}) if match_features is not None else {}
    preferred_keys = ('disk+lightglue',)
    for key in preferred_keys:
        if key in confs:
            return key
    for key in confs:
        normalized = key.lower()
        if 'lightglue' in normalized and 'disk' in normalized:
            return key
    for key in confs:
        if 'lightglue' in key.lower():
            return key
    return None


def resolve_hloc_aliked_feature_key() -> str | None:
    confs = getattr(extract_features, 'confs', {}) if extract_features is not None else {}
    preferred_keys = ('aliked-n16rot', 'aliked-n16', 'aliked-n32', 'aliked')
    for key in preferred_keys:
        if key in confs:
            return key
    for key in confs:
        if 'aliked' in key:
            return key
    return None


def resolve_hloc_aliked_lightglue_matcher_key() -> str | None:
    confs = getattr(match_features, 'confs', {}) if match_features is not None else {}
    preferred_keys = ('aliked+lightglue',)
    for key in preferred_keys:
        if key in confs:
            return key
    for key in confs:
        if 'lightglue' in key and 'aliked' in key:
            return key
    # ALIKED descriptors are compatible with the generic LightGlue matcher config.
    for key in confs:
        if 'lightglue' in key:
            return key
    return None


HLOC_SUPERPOINT_FEATURE_KEY = resolve_hloc_feature_key()
HLOC_LIGHTGLUE_MATCHER_KEY = resolve_hloc_lightglue_matcher_key()
HLOC_LIGHTGLUE_AVAILABLE = bool(HLOC_AVAILABLE and h5py is not None and HLOC_SUPERPOINT_FEATURE_KEY and HLOC_LIGHTGLUE_MATCHER_KEY)

HLOC_DISK_FEATURE_KEY = resolve_hloc_disk_feature_key()
HLOC_DISK_LIGHTGLUE_MATCHER_KEY = resolve_hloc_disk_lightglue_matcher_key()
HLOC_DISK_AVAILABLE = bool(HLOC_AVAILABLE and h5py is not None and HLOC_DISK_FEATURE_KEY and HLOC_DISK_LIGHTGLUE_MATCHER_KEY)

HLOC_ALIKED_FEATURE_KEY = resolve_hloc_aliked_feature_key()
HLOC_ALIKED_LIGHTGLUE_MATCHER_KEY = resolve_hloc_aliked_lightglue_matcher_key()
HLOC_ALIKED_AVAILABLE = bool(HLOC_AVAILABLE and h5py is not None and HLOC_ALIKED_FEATURE_KEY and HLOC_ALIKED_LIGHTGLUE_MATCHER_KEY)


def read_env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return bool(default)
    return value.strip().lower() not in {'0', 'false', 'no', 'off'}


def read_env_float(name: str, default: float, minimum: float | None = None) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError:
        value = float(default)
    if minimum is not None:
        value = max(value, float(minimum))
    return value


def read_env_int(name: str, default: int, minimum: int | None = None) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = int(default)
    if minimum is not None:
        value = max(value, int(minimum))
    return value


FAST3R_PRESET_ALIASES = {
    'fast3r',
    'fast3r_indoor',
}
ROMA_V2_PRESET_ALIASES = {
    'roma_v2',
    'roma_v2_pairwise',
    'romav2',
    'romav2_pairwise',
}
ROMA_V2_ALL_PRESET_ALIASES = set(ROMA_V2_PRESET_ALIASES)
HLOC_DISK_LIGHTGLUE_LOFTR_PRESET_ALIASES = {
    'disk_lightglue_loftr',
    'hloc_disk_lightglue_loftr',
    'hybrid_disk_lightglue_loftr',
    'hybrid_disk_loftr',
}
HLOC_SUPERPOINT_LIGHTGLUE_LOFTR_PRESET_ALIASES = {
    'hloc_lightglue_loftr',
    'hloc_superpoint_lightglue_loftr',
    'superpoint_lightglue_loftr',
    'hybrid_hloc_loftr',
    'aliked_superpoint_lightglue_loftr',
    'aliked_superpoint_loftr',
}
HLOC_ALIKED_LIGHTGLUE_LOFTR_PRESET_ALIASES = {
    'aliked_lightglue_loftr',
    'hybrid_aliked_loftr',
}
HLOC_LIGHTGLUE_LOFTR_PRESET_ALIASES = (
    HLOC_DISK_LIGHTGLUE_LOFTR_PRESET_ALIASES
    | HLOC_SUPERPOINT_LIGHTGLUE_LOFTR_PRESET_ALIASES
    | HLOC_ALIKED_LIGHTGLUE_LOFTR_PRESET_ALIASES
)
HLOC_CANONICAL_PRESETS = {
    'disk': 'disk_lightglue_loftr',
    'superpoint': 'superpoint_lightglue_loftr',
    'aliked': 'aliked_lightglue_loftr',
}
DEFAULT_FAST3R_MODEL_NAME = os.environ.get(
    'MASTER_PIPELINE_FAST3R_MODEL_NAME',
    'jedyang97/Fast3R_ViT_Large_512',
)
DEFAULT_HLOC_MAX_KEYPOINTS = read_env_int('MASTER_PIPELINE_HLOC_MAX_KEYPOINTS', 8192, 1024)
DEFAULT_HLOC_MAX_MATCHES = read_env_int('MASTER_PIPELINE_HLOC_MAX_MATCHES', 8192, 64)
DEFAULT_HLOC_MIN_MATCHES = read_env_int('MASTER_PIPELINE_HLOC_MIN_MATCHES', 64, 16)
HLOC_TEXTURE_ROUTER_ENABLED = read_env_bool('MASTER_PIPELINE_HLOC_TEXTURE_ROUTER', True)
DEFAULT_HLOC_ROUTER_MIN_KEYPOINTS = read_env_int('MASTER_PIPELINE_HLOC_ROUTER_MIN_KEYPOINTS', 384, 0)
DEFAULT_HLOC_ROUTER_LAPLACIAN_VARIANCE = read_env_float('MASTER_PIPELINE_HLOC_ROUTER_LAPLACIAN_VARIANCE', 45.0, 0.0)

# Hybrid detector fusion toggles. The HLOC primary stage can run SuperPoint and/or
# DISK feature+LightGlue matching; weak pairs are then handed to
# EfficientLoFTR (loftr_indoor) for low-texture rescue.
HLOC_HYBRID_USE_DISK = read_env_bool('MASTER_PIPELINE_HYBRID_USE_DISK', True)
HLOC_HYBRID_USE_SUPERPOINT = read_env_bool('MASTER_PIPELINE_HYBRID_USE_SUPERPOINT', True)
HLOC_HYBRID_USE_ALIKED = read_env_bool('MASTER_PIPELINE_HYBRID_USE_ALIKED', True)
DEFAULT_ROMA_V2_SETTING = os.environ.get('MASTER_PIPELINE_ROMA_V2_SETTING', 'precise').strip() or 'precise'
DEFAULT_ROMA_V2_SAMPLED_MATCHES = read_env_int('MASTER_PIPELINE_ROMA_V2_SAMPLED_MATCHES', 12000, 512)
DEFAULT_ROMA_V2_MAX_MATCHES = read_env_int('MASTER_PIPELINE_ROMA_V2_MAX_MATCHES', 8192, 64)
DEFAULT_ROMA_V2_MIN_MATCHES = read_env_int('MASTER_PIPELINE_ROMA_V2_MIN_MATCHES', 64, 16)
ROMA_EXHAUSTIVE_IMAGE_LIMIT = read_env_int('MASTER_PIPELINE_ROMA_EXHAUSTIVE_IMAGE_LIMIT', 10, 2)
ROMA_MEDIUM_IMAGE_LIMIT = read_env_int('MASTER_PIPELINE_ROMA_MEDIUM_IMAGE_LIMIT', 48, ROMA_EXHAUSTIVE_IMAGE_LIMIT + 1)
ROMA_LARGE_IMAGE_LIMIT = read_env_int('MASTER_PIPELINE_ROMA_LARGE_IMAGE_LIMIT', 160, ROMA_MEDIUM_IMAGE_LIMIT + 1)
ROMA_MEDIUM_ANCHOR_COUNT = read_env_int('MASTER_PIPELINE_ROMA_MEDIUM_ANCHOR_COUNT', 6, 2)
ROMA_LARGE_ANCHOR_COUNT = read_env_int('MASTER_PIPELINE_ROMA_LARGE_ANCHOR_COUNT', 10, 3)
ROMA_XL_ANCHOR_COUNT = read_env_int('MASTER_PIPELINE_ROMA_XL_ANCHOR_COUNT', 16, 4)
REFLECTIVE_BATHROOM_DENSE_PAIRS = read_env_bool('MASTER_PIPELINE_MATCHING_REFLECTIVE_BATHROOM_DENSE_PAIRS', False)
DEFAULT_MATCHING_REFLECTIVE_MASK_CLASSES = tuple(
    token.strip().lower()
    for token in os.environ.get('MASTER_PIPELINE_MATCHING_REFLECTIVE_MASK_CLASSES', 'mirror,window').split(',')
    if token.strip()
) or ('mirror', 'window')
DEFAULT_MATCHING_REFLECTIVE_MASK_MAX_COVERAGE = read_env_float(
    'MASTER_PIPELINE_MATCHING_REFLECTIVE_MASK_MAX_COVERAGE',
    0.40,
    0.0,
)
DEFAULT_ROMA_V2_RANSAC_REPROJECTION_THRESHOLD = read_env_float(
    'MASTER_PIPELINE_ROMA_V2_RANSAC_REPROJECTION_THRESHOLD',
    1.0,
    0.05,
)
DEFAULT_ROMA_V2_RANSAC_CONFIDENCE = read_env_float('MASTER_PIPELINE_ROMA_V2_RANSAC_CONFIDENCE', 0.999999, 0.5)
DEFAULT_ROMA_V2_RANSAC_MAX_ITERS = read_env_int('MASTER_PIPELINE_ROMA_V2_RANSAC_MAX_ITERS', 10000, 100)


def resolve_roma_v2_descriptor_name(_preset: str) -> str:
    return 'dinov3_vitl16'


def resolve_roma_v2_variant_label(_preset: str) -> str:
    return 'default'


def canonicalize_hloc_preset(preset: str) -> str:
    normalized = preset.strip().lower()
    if normalized in HLOC_DISK_LIGHTGLUE_LOFTR_PRESET_ALIASES:
        return HLOC_CANONICAL_PRESETS['disk']
    if normalized in HLOC_ALIKED_LIGHTGLUE_LOFTR_PRESET_ALIASES:
        return HLOC_CANONICAL_PRESETS['aliked']
    if normalized in HLOC_SUPERPOINT_LIGHTGLUE_LOFTR_PRESET_ALIASES:
        return HLOC_CANONICAL_PRESETS['superpoint']
    return normalized


def resolve_hloc_primary_variant_name(preset: str) -> str:
    canonical = canonicalize_hloc_preset(preset)
    if canonical == HLOC_CANONICAL_PRESETS['disk']:
        return 'disk'
    if canonical == HLOC_CANONICAL_PRESETS['aliked']:
        return 'aliked'
    return 'superpoint'


def active_hloc_variants(preset: str) -> list[dict]:
    """Return the enabled HLOC detector variants for the hybrid primary stage,
    each as {name, featureKey, matcherKey, source}. Empty when none are available."""
    variants: list[dict] = []
    primary_variant = resolve_hloc_primary_variant_name(preset)

    if primary_variant == 'disk' and HLOC_HYBRID_USE_DISK and HLOC_DISK_AVAILABLE:
        variants.append({
            'name': 'disk',
            'featureKey': HLOC_DISK_FEATURE_KEY,
            'matcherKey': HLOC_DISK_LIGHTGLUE_MATCHER_KEY,
            'source': 'disk_lightglue_primary',
        })
    elif primary_variant == 'superpoint' and HLOC_HYBRID_USE_SUPERPOINT and HLOC_LIGHTGLUE_AVAILABLE:
        variants.append({
            'name': 'superpoint',
            'featureKey': HLOC_SUPERPOINT_FEATURE_KEY,
            'matcherKey': HLOC_LIGHTGLUE_MATCHER_KEY,
            'source': 'superpoint_lightglue_primary',
        })
    elif primary_variant == 'aliked' and HLOC_HYBRID_USE_ALIKED and HLOC_ALIKED_AVAILABLE:
        variants.append({
            'name': 'aliked',
            'featureKey': HLOC_ALIKED_FEATURE_KEY,
            'matcherKey': HLOC_ALIKED_LIGHTGLUE_MATCHER_KEY,
            'source': 'aliked_lightglue_primary',
        })
    return variants


HLOC_HYBRID_AVAILABLE = bool(HLOC_DISK_AVAILABLE or HLOC_LIGHTGLUE_AVAILABLE or HLOC_ALIKED_AVAILABLE)


def expected_hloc_primary_source(preset: str) -> str:
    primary_variant = resolve_hloc_primary_variant_name(preset)
    if primary_variant == 'disk':
        return 'disk_lightglue_primary'
    if primary_variant == 'aliked':
        return 'aliked_lightglue_primary'
    return 'superpoint_lightglue_primary'


def build_hloc_acceptance_policy(primary_frontend: str, router_enabled: bool) -> str:
    if router_enabled:
        return f'masked_clean_keypoint_router_then_{primary_frontend}_primary_then_loftr_rescue_for_weak_or_missing_pairs'
    return f'{primary_frontend}_primary_then_loftr_rescue_for_weak_or_missing_pairs'


def build_hloc_summary_fields(preset: str, hybrid_stats: dict) -> dict:
    primary_variant = resolve_hloc_primary_variant_name(preset)
    router_enabled = bool(hybrid_stats['textureRouterEnabled'])
    common_fields = {
        'hlocAvailable': bool(hybrid_stats['hlocAvailable']),
        'textureRouterEnabled': router_enabled,
        'textureRouterSignal': 'masked_clean_keypoint_count',
        'textureRouterPairCount': int(hybrid_stats['textureRouterPairCount']),
        'hlocPrimaryPairCount': int(hybrid_stats['hlocPrimaryPairCount']),
        'loftrRescuePairCount': int(hybrid_stats['loftrRescuePairCount']),
        'hybridFailureCount': int(hybrid_stats['hybridFailureCount']),
        'dryRunSimulatedPairCount': int(hybrid_stats['dryRunSimulatedPairCount']),
        'hlocMaxKeypoints': int(DEFAULT_HLOC_MAX_KEYPOINTS),
        'hlocMaxMatches': int(DEFAULT_HLOC_MAX_MATCHES),
        'hlocMinMatchSupport': int(DEFAULT_HLOC_MIN_MATCHES),
    }
    if router_enabled:
        common_fields['textureRouterMinKeypoints'] = int(DEFAULT_HLOC_ROUTER_MIN_KEYPOINTS)

    if primary_variant == 'disk':
        common_fields.update({
            'method': 'disk_lightglue_with_loftr_pair_rescue',
            'implementation': 'hybrid_disk_lightglue_loftr',
            'blankWallBias': 'disk_lightglue_primary_with_detector_free_rescue',
            'primaryFrontend': 'disk_lightglue',
            'rescueFrontend': 'loftr_indoor',
            'acceptancePolicy': build_hloc_acceptance_policy('disk_lightglue', router_enabled),
        })
        return common_fields

    if primary_variant == 'aliked':
        common_fields.update({
            'method': 'aliked_lightglue_with_loftr_pair_rescue',
            'implementation': 'hybrid_aliked_lightglue_loftr',
            'blankWallBias': 'aliked_lightglue_primary_with_detector_free_rescue',
            'primaryFrontend': 'aliked_lightglue',
            'rescueFrontend': 'loftr_indoor',
            'acceptancePolicy': build_hloc_acceptance_policy('aliked_lightglue', router_enabled),
        })
        return common_fields

    common_fields.update({
        'method': 'hloc_superpoint_lightglue_with_loftr_pair_rescue',
        'implementation': 'hybrid_hloc_lightglue_loftr',
        'blankWallBias': 'superpoint_lightglue_primary_with_detector_free_rescue',
        'primaryFrontend': 'superpoint_lightglue',
        'rescueFrontend': 'loftr_indoor',
        'acceptancePolicy': build_hloc_acceptance_policy('superpoint_lightglue', router_enabled),
    })
    return common_fields

DEFAULT_FAST3R_CONTEXT_WINDOW_SIZE = read_env_int('MASTER_PIPELINE_FAST3R_CONTEXT_WINDOW_SIZE', 4, 4)
DEFAULT_FAST3R_MAX_MATCHES = read_env_int('MASTER_PIPELINE_FAST3R_MAX_MATCHES', 16384, 32)
DEFAULT_FAST3R_MAX_MATCHES_CEILING = read_env_int('MASTER_PIPELINE_FAST3R_MAX_MATCHES_CEILING', 32768, DEFAULT_FAST3R_MAX_MATCHES)
DEFAULT_FAST3R_MATCH_CAP_STEP = read_env_int('MASTER_PIPELINE_FAST3R_MATCH_CAP_STEP', 4096, 1024)
DEFAULT_FAST3R_MATCH_CAP_WINDOW_BONUS = read_env_int('MASTER_PIPELINE_FAST3R_MATCH_CAP_WINDOW_BONUS', 2048, 0)
DEFAULT_FAST3R_MIN_DIRECT_MATCHES = read_env_int('MASTER_PIPELINE_FAST3R_MIN_DIRECT_MATCHES', 32, 8)
DEFAULT_FAST3R_MIN_TRACK_RESCUE_MATCHES = read_env_int('MASTER_PIPELINE_FAST3R_MIN_TRACK_RESCUE_MATCHES', 16, 4)
DEFAULT_FAST3R_WINDOW_TRACK_MIN_SUPPORT = read_env_int('MASTER_PIPELINE_FAST3R_WINDOW_TRACK_MIN_SUPPORT', 3, 3)
FAST3R_MULTIVIEW_TRACK_CONSOLIDATION_ENABLED = read_env_bool('MASTER_PIPELINE_FAST3R_MULTIVIEW_TRACK_CONSOLIDATION', True)
FAST3R_TRACK_CONSOLIDATION_PASSES = read_env_int('MASTER_PIPELINE_FAST3R_TRACK_CONSOLIDATION_PASSES', 2, 1)
FAST3R_TRACK_CONSOLIDATION_MAX_TRACK_SUPPORT = read_env_int('MASTER_PIPELINE_FAST3R_TRACK_CONSOLIDATION_MAX_TRACK_SUPPORT', 3, 2)
FAST3R_TRACK_CONSOLIDATION_MIN_SOURCE_PAIRS = read_env_int('MASTER_PIPELINE_FAST3R_TRACK_CONSOLIDATION_MIN_SOURCE_PAIRS', 2, 1)
FAST3R_TRACK_CONSOLIDATION_MIN_MULTIVIEW_SOURCE_PAIRS = read_env_int('MASTER_PIPELINE_FAST3R_TRACK_CONSOLIDATION_MIN_MULTIVIEW_SOURCE_PAIRS', 2, 1)
FAST3R_TRACK_CONSOLIDATION_MIN_LOCAL_HEAD_SOURCE_PAIRS = read_env_int('MASTER_PIPELINE_FAST3R_TRACK_CONSOLIDATION_MIN_LOCAL_HEAD_SOURCE_PAIRS', 1, 0)
FAST3R_TRACK_CONSOLIDATION_MIN_WINDOW_SUPPORT = read_env_int('MASTER_PIPELINE_FAST3R_TRACK_CONSOLIDATION_MIN_WINDOW_SUPPORT', 4, 2)
FAST3R_TRACK_CONSOLIDATION_MIN_MEAN_PAIR_CONFIDENCE = read_env_float('MASTER_PIPELINE_FAST3R_TRACK_CONSOLIDATION_MIN_MEAN_PAIR_CONFIDENCE', 6.0, 0.0)
FAST3R_TRACK_CONSOLIDATION_MIN_MEAN_SCORE = read_env_float('MASTER_PIPELINE_FAST3R_TRACK_CONSOLIDATION_MIN_MEAN_SCORE', 6.0, 0.0)
FAST3R_TRACK_CONSOLIDATION_MERGE_RADIUS = read_env_float('MASTER_PIPELINE_FAST3R_TRACK_CONSOLIDATION_MERGE_RADIUS', 2.0, 0.25)
FAST3R_TRACK_CONSOLIDATION_REJECT_RADIUS = read_env_float('MASTER_PIPELINE_FAST3R_TRACK_CONSOLIDATION_REJECT_RADIUS', 4.0, FAST3R_TRACK_CONSOLIDATION_MERGE_RADIUS)
FAST3R_TRACK_CONSOLIDATION_MIN_SHARED_IMAGES = read_env_int('MASTER_PIPELINE_FAST3R_TRACK_CONSOLIDATION_MIN_SHARED_IMAGES', 1, 1)
ROMA_MULTIVIEW_TRACK_CONSOLIDATION_ENABLED = read_env_bool('MASTER_PIPELINE_ROMA_MULTIVIEW_TRACK_CONSOLIDATION', True)
ROMA_TRACK_CONSOLIDATION_PASSES = read_env_int('MASTER_PIPELINE_ROMA_TRACK_CONSOLIDATION_PASSES', 3, 1)
ROMA_TRACK_CONSOLIDATION_MAX_TRACK_SUPPORT = read_env_int('MASTER_PIPELINE_ROMA_TRACK_CONSOLIDATION_MAX_TRACK_SUPPORT', 8, 2)
ROMA_TRACK_CONSOLIDATION_MIN_MEAN_SCORE = read_env_float('MASTER_PIPELINE_ROMA_TRACK_CONSOLIDATION_MIN_MEAN_SCORE', 0.10, 0.0)
ROMA_TRACK_CONSOLIDATION_MERGE_RADIUS = read_env_float('MASTER_PIPELINE_ROMA_TRACK_CONSOLIDATION_MERGE_RADIUS', 3.0, 0.25)
ROMA_TRACK_CONSOLIDATION_REJECT_RADIUS = read_env_float('MASTER_PIPELINE_ROMA_TRACK_CONSOLIDATION_REJECT_RADIUS', 6.0, ROMA_TRACK_CONSOLIDATION_MERGE_RADIUS)
ROMA_TRACK_CONSOLIDATION_MIN_SHARED_IMAGES = read_env_int('MASTER_PIPELINE_ROMA_TRACK_CONSOLIDATION_MIN_SHARED_IMAGES', 1, 1)
FAST3R_TRACK_CONSENSUS_MIN_RESERVE = read_env_int('MASTER_PIPELINE_FAST3R_TRACK_CONSENSUS_MIN_RESERVE', 512, 0)
FAST3R_TRACK_CONSENSUS_RESERVE_FRACTION = read_env_float('MASTER_PIPELINE_FAST3R_TRACK_CONSENSUS_RESERVE_FRACTION', 0.25, 0.0)
FAST3R_TRACK_CONSENSUS_CONFIDENCE_BOOST = read_env_float('MASTER_PIPELINE_FAST3R_TRACK_CONSENSUS_CONFIDENCE_BOOST', 1.5, 1.0)
FAST3R_WINDOW_SUPPORT_CONFIDENCE_BOOST = read_env_float('MASTER_PIPELINE_FAST3R_WINDOW_SUPPORT_CONFIDENCE_BOOST', 0.05, 0.0)
FAST3R_FAILED_PAIR_MULTIVIEW_RESCUE_ENABLED = read_env_bool('MASTER_PIPELINE_FAST3R_FAILED_PAIR_MULTIVIEW_RESCUE', False)
FAST3R_FAILED_PAIR_RESCUE_MIN_MATCHES = read_env_int('MASTER_PIPELINE_FAST3R_FAILED_PAIR_RESCUE_MIN_MATCHES', 8, 4)
FAST3R_FAILED_PAIR_TWO_VIEW_RESCUE_ENABLED = read_env_bool('MASTER_PIPELINE_FAST3R_FAILED_PAIR_TWO_VIEW_RESCUE', False)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def list_images(images_dir: Path) -> list[Path]:
    images: list[Path] = []
    for pattern in ('*.jpg', '*.jpeg', '*.png', '*.JPG', '*.JPEG', '*.PNG'):
        images.extend(images_dir.glob(pattern))
    return sorted(images)


def _append_pair(
    pair_map: dict[tuple[int, int], tuple[Path, Path]],
    images: list[Path],
    left_index: int,
    right_index: int,
) -> None:
    image_count = len(images)
    if image_count < 2:
        return
    left = int(left_index)
    right = int(right_index)
    if left == right or left < 0 or right < 0 or left >= image_count or right >= image_count:
        return
    key = (left, right) if left < right else (right, left)
    pair_map.setdefault(key, (images[key[0]], images[key[1]]))


def _add_offset_pairs(
    pair_map: dict[tuple[int, int], tuple[Path, Path]],
    images: list[Path],
    offsets: tuple[int, ...],
) -> None:
    image_count = len(images)
    for offset in offsets:
        normalized_offset = int(offset)
        if normalized_offset <= 0 or normalized_offset >= image_count:
            continue
        for index in range(image_count - normalized_offset):
            _append_pair(pair_map, images, index, index + normalized_offset)


def _build_anchor_indices(image_count: int, target_count: int) -> list[int]:
    if image_count <= 1 or target_count <= 1:
        return []
    if target_count >= image_count:
        return list(range(image_count))
    denominator = max(target_count - 1, 1)
    anchors = {
        int(round(position * (image_count - 1) / denominator))
        for position in range(target_count)
    }
    return sorted(anchors)


def _add_anchor_pairs(
    pair_map: dict[tuple[int, int], tuple[Path, Path]],
    images: list[Path],
    anchor_indices: list[int],
    *,
    local_skip: int,
) -> None:
    if len(anchor_indices) < 2:
        return

    anchor_count = len(anchor_indices)
    for anchor_position, anchor_index in enumerate(anchor_indices):
        for neighbor_offset in (1, 2):
            if neighbor_offset >= anchor_count:
                break
            _append_pair(
                pair_map,
                images,
                anchor_index,
                anchor_indices[(anchor_position + neighbor_offset) % anchor_count],
            )

    half_turn = max(1, anchor_count // 2)
    for index in range(len(images)):
        insertion_index = bisect.bisect_left(anchor_indices, index)
        candidate_anchors = set()
        if insertion_index < anchor_count:
            candidate_anchors.add(anchor_indices[insertion_index])
        if insertion_index > 0:
            candidate_anchors.add(anchor_indices[insertion_index - 1])
        if anchor_count >= 4:
            candidate_anchors.add(anchor_indices[(insertion_index + half_turn) % anchor_count])
        for anchor_index in candidate_anchors:
            if abs(anchor_index - index) <= local_skip:
                continue
            _append_pair(pair_map, images, index, anchor_index)


def select_pairs(images: list[Path]) -> tuple[list[tuple[Path, Path]], str]:
    image_count = len(images)
    if image_count <= 1:
        return [], 'insufficient_images'
    if image_count <= ROMA_EXHAUSTIVE_IMAGE_LIMIT:
        pair_map: dict[tuple[int, int], tuple[Path, Path]] = {}
        for left_index in range(image_count - 1):
            for right_index in range(left_index + 1, image_count):
                _append_pair(pair_map, images, left_index, right_index)
        return list(pair_map.values()), f'exhaustive_all_pairs_le_{ROMA_EXHAUSTIVE_IMAGE_LIMIT}'

    if REFLECTIVE_BATHROOM_DENSE_PAIRS and image_count <= ROMA_MEDIUM_IMAGE_LIMIT:
        offsets = (1, 2, 3, 4, 5, 6, 8, 10, 12)
        anchor_count = min(max(ROMA_MEDIUM_ANCHOR_COUNT, 12), image_count)
        local_skip = 3
        policy = 'reflective_bathroom_dense_medium'
    elif REFLECTIVE_BATHROOM_DENSE_PAIRS and image_count <= ROMA_LARGE_IMAGE_LIMIT:
        offsets = (1, 2, 3, 4, 6, 8, 12, 16, 20)
        anchor_count = min(max(ROMA_LARGE_ANCHOR_COUNT, 14), image_count)
        local_skip = 4
        policy = 'reflective_bathroom_dense_large'
    elif image_count <= ROMA_MEDIUM_IMAGE_LIMIT:
        offsets = (1, 2, 3, 4, 6, 8)
        anchor_count = min(ROMA_MEDIUM_ANCHOR_COUNT, image_count)
        local_skip = 4
        policy = 'adaptive_offsets_1_2_3_4_6_8_plus_medium_anchors'
    elif image_count <= ROMA_LARGE_IMAGE_LIMIT:
        offsets = (1, 2, 3, 4, 6, 8, 12, 16)
        anchor_count = min(ROMA_LARGE_ANCHOR_COUNT, image_count)
        local_skip = 6
        policy = 'adaptive_offsets_1_2_3_4_6_8_12_16_plus_large_anchors'
    else:
        offsets = (1, 2, 3, 6, 12, 24, 48)
        anchor_count = min(ROMA_XL_ANCHOR_COUNT, image_count)
        local_skip = 8
        policy = 'adaptive_offsets_1_2_3_6_12_24_48_plus_xl_anchors'

    pair_map = {}
    _add_offset_pairs(pair_map, images, offsets)
    _add_anchor_pairs(
        pair_map,
        images,
        _build_anchor_indices(image_count, anchor_count),
        local_skip=local_skip,
    )
    return [pair_map[key] for key in sorted(pair_map)], policy


def select_fast3r_pairs(
    images: list[Path],
    requested_window_size: int = DEFAULT_FAST3R_CONTEXT_WINDOW_SIZE,
) -> list[tuple[Path, Path]]:
    pair_map: dict[tuple[int, int], tuple[Path, Path]] = {}
    for window_indices in build_fast3r_window_indices(len(images), requested_window_size):
        for left_index, right_index in itertools.combinations(sorted(window_indices), 2):
            pair_map.setdefault(
                (left_index, right_index),
                (images[left_index], images[right_index]),
            )
    return [pair_map[key] for key in sorted(pair_map)]


def build_pair_id(pair_index: int, image1: Path, image2: Path) -> str:
    return f'pair_{pair_index:04d}__{image1.stem}__{image2.stem}'


def write_pair_preview(image1: Path, image2: Path, preview_path: Path) -> None:
    from PIL import Image

    with Image.open(image1).convert('RGB') as first, Image.open(image2).convert('RGB') as second:
        height = min(first.height, second.height, 360)
        first_resized = first.resize((max(1, round(first.width * height / first.height)), height))
        second_resized = second.resize((max(1, round(second.width * height / second.height)), height))
        canvas = Image.new('RGB', (first_resized.width + second_resized.width, height))
        canvas.paste(first_resized, (0, 0))
        canvas.paste(second_resized, (first_resized.width, 0))
        canvas.save(preview_path, format='JPEG', quality=88)


def init_feature_store(images: list[Path]) -> dict[str, dict]:
    return {
        image.name: {
            'image': image.name,
            'keypoints': [],
            'scores': [],
        }
        for image in images
    }


def point_bucket(point, bucket_size: float) -> tuple[int, int]:
    import math

    safe_bucket_size = max(float(bucket_size), 1e-6)
    return (
        int(math.floor(float(point[0]) / safe_bucket_size)),
        int(math.floor(float(point[1]) / safe_bucket_size)),
    )


def assign_global_keypoints(feature_store: dict[str, dict], image_name: str, keypoints, scores, merge_radius: float = 2.5):
    import numpy as np

    store = feature_store[image_name]
    existing_points = store['keypoints']
    existing_scores = store['scores']
    bucket_size = max(float(merge_radius), 1.0)
    bucket_index = store.setdefault('_bucketIndex', {})
    point_cells = store.setdefault('_pointCells', [])
    point_cache = store.setdefault('_pointCache', [])

    if len(point_cache) < len(existing_points):
        for existing_index in range(len(point_cache), len(existing_points)):
            cached_point = np.asarray(existing_points[existing_index], dtype=np.float32)
            cached_cell = point_bucket(cached_point, bucket_size)
            point_cache.append(cached_point)
            point_cells.append(cached_cell)
            bucket_index.setdefault(cached_cell, []).append(existing_index)

    point_index_map: list[int] = []
    neighbor_offsets = (
        (-1, -1), (-1, 0), (-1, 1),
        (0, -1), (0, 0), (0, 1),
        (1, -1), (1, 0), (1, 1),
    )

    for idx, point in enumerate(keypoints):
        point_arr = np.asarray(point, dtype=np.float32)
        point_cell = point_bucket(point_arr, bucket_size)
        assigned_index = None
        for offset_x, offset_y in neighbor_offsets:
            neighbor_cell = (point_cell[0] + offset_x, point_cell[1] + offset_y)
            for existing_index in bucket_index.get(neighbor_cell, []):
                if np.linalg.norm(point_arr - point_cache[existing_index]) <= merge_radius:
                    assigned_index = existing_index
                    if float(scores[idx]) > float(existing_scores[existing_index]):
                        old_cell = point_cells[existing_index]
                        existing_points[existing_index] = point_arr.tolist()
                        existing_scores[existing_index] = float(scores[idx])
                        point_cache[existing_index] = point_arr
                        if old_cell != point_cell:
                            old_bucket = bucket_index.get(old_cell, [])
                            if existing_index in old_bucket:
                                old_bucket.remove(existing_index)
                                if not old_bucket:
                                    bucket_index.pop(old_cell, None)
                            bucket_index.setdefault(point_cell, []).append(existing_index)
                            point_cells[existing_index] = point_cell
                    break
            if assigned_index is not None:
                break

        if assigned_index is None:
            existing_points.append(point_arr.tolist())
            existing_scores.append(float(scores[idx]))
            point_cache.append(point_arr)
            point_cells.append(point_cell)
            assigned_index = len(existing_points) - 1
            bucket_index.setdefault(point_cell, []).append(assigned_index)

        point_index_map.append(int(assigned_index))

    return point_index_map


def parse_gpu_indices(raw_value: str | None) -> list[str]:
    if not raw_value:
        return []

    indices: list[str] = []
    for token in str(raw_value).split(','):
        token = token.strip()
        if not token:
            continue
        index = int(token)
        if index < 0:
            raise ValueError(f'invalid_gpu_index:{token}')
        indices.append(str(index))
    return indices


def resolve_backend(preset: str) -> str:
    normalized_preset = preset.strip().lower()
    if normalized_preset in FAST3R_PRESET_ALIASES:
        return 'fast3r'
    if normalized_preset in ROMA_V2_ALL_PRESET_ALIASES:
        return 'roma_v2'
    if normalized_preset in HLOC_LIGHTGLUE_LOFTR_PRESET_ALIASES:
        return 'hloc_lightglue_loftr'
    return 'loftr'


def configure_model_cache() -> None:
    cache_root = Path(os.environ.get('MASTER_PIPELINE_MODEL_CACHE_DIR', Path.home() / '.cache' / 'houseyield' / 'master_pipeline'))
    hf_home = cache_root / 'huggingface'
    torch_home = cache_root / 'torch'
    hf_home.mkdir(parents=True, exist_ok=True)
    torch_home.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault('HF_HOME', str(hf_home))
    os.environ.setdefault('TORCH_HOME', str(torch_home))

    try:
        import certifi

        os.environ.setdefault('SSL_CERT_FILE', certifi.where())
        os.environ.setdefault('REQUESTS_CA_BUNDLE', certifi.where())
    except Exception:
        pass


def read_image_size(image_path: Path) -> tuple[int, int]:
    from PIL import Image

    with Image.open(image_path) as image:
        return image.size


def to_numpy(value, dtype=None):
    import numpy as np
    import torch

    if hasattr(value, 'detach'):
        value = value.detach().cpu()
        if value.dtype in {torch.bfloat16, torch.float16}:
            value = value.to(torch.float32)
        value = value.numpy()
    array = np.asarray(value)
    if dtype is not None:
        array = array.astype(dtype)
    return array


def resolve_torch_device(gpu_indices: list[str], require_torch: bool = True):
    try:
        import torch
    except ImportError:
        if require_torch:
            raise
        return 'cpu'

    if torch.cuda.is_available():
        if gpu_indices:
            return torch.device(f'cuda:{gpu_indices[0]}')
        return torch.device('cuda')
    return torch.device('cpu')


def load_grayscale_image(image_path: Path, image_size: int):
    import cv2
    import torch

    image = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise RuntimeError(f'Unable to load image: {image_path}')

    orig_h, orig_w = image.shape[:2]
    scale = min(1.0, float(image_size) / float(max(orig_h, orig_w)))
    if scale < 1.0:
        resized = cv2.resize(image, (max(1, int(round(orig_w * scale))), max(1, int(round(orig_h * scale)))), interpolation=cv2.INTER_AREA)
    else:
        resized = image

    tensor = torch.from_numpy(resized).float().unsqueeze(0).unsqueeze(0) / 255.0
    return tensor, scale


def compute_image_laplacian_variance(image_path: Path, image_size: int) -> float:
    import cv2
    import numpy as np

    image = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise RuntimeError(f'Unable to load image: {image_path}')

    orig_h, orig_w = image.shape[:2]
    scale = min(1.0, float(image_size) / float(max(orig_h, orig_w)))
    if scale < 1.0:
        image = cv2.resize(
            image,
            (max(1, int(round(orig_w * scale))), max(1, int(round(orig_h * scale)))),
            interpolation=cv2.INTER_AREA,
        )

    return float(np.var(cv2.Laplacian(image, cv2.CV_32F)))


def build_dry_run_matches():
    import numpy as np

    count = 256
    x = np.linspace(64.0, 512.0, count, dtype=np.float32)
    y = np.linspace(96.0, 384.0, count, dtype=np.float32)
    keypoints0 = np.stack([x, y], axis=-1)
    keypoints1 = np.stack([x + 3.0, y], axis=-1)
    confidence = np.full((count,), 0.82, dtype=np.float32)
    return keypoints0, keypoints1, confidence


def build_dry_run_pointmaps():
    import numpy as np

    grid_h = 64
    grid_w = 64
    u = np.linspace(-1.2, 1.2, grid_w, dtype=np.float32)
    v = np.linspace(-0.8, 0.8, grid_h, dtype=np.float32)
    uu, vv = np.meshgrid(u, v)
    pointmap0 = np.stack([uu, vv, np.ones_like(uu)], axis=-1).astype(np.float32)
    pointmap1 = np.stack([uu + 0.08, vv, np.ones_like(uu)], axis=-1).astype(np.float32)
    conf0 = np.full((grid_h, grid_w), 0.55, dtype=np.float32)
    conf1 = np.full((grid_h, grid_w), 0.55, dtype=np.float32)
    return pointmap0, pointmap1, conf0, conf1


def configure_fast3r_imports() -> Path:
    fast3r_root = Path(
        os.environ.get('MASTER_PIPELINE_FAST3R_ROOT')
        or '/opt/fast3r'
    )
    if not fast3r_root.exists():
        raise RuntimeError(
            f'fast3r_root_missing:{fast3r_root}. '
            'Set MASTER_PIPELINE_FAST3R_ROOT to the Fast3r checkout on the master_v1 VM.'
        )

    if str(fast3r_root) not in sys.path:
        sys.path.insert(0, str(fast3r_root))

    return fast3r_root


class EfficientLoFTRWrapper:
    """Adapt EfficientLoFTR's batch-dict API to the LoFTR matcher contract.

    The downstream ``process_loftr_pair`` helper calls ``matcher(data)`` with a
    dict containing ``image0``/``image1`` grayscale tensors and expects a dict
    exposing ``keypoints0``, ``keypoints1``, and ``confidence``. EfficientLoFTR
    instead populates the input batch in place with ``mkpts0_f``/``mkpts1_f`` and
    ``mconf``, so we translate between the two here.
    """

    def __init__(self, model):
        self._model = model

    def eval(self):
        self._model.eval()
        return self

    def to(self, device):
        self._model.to(device)
        return self

    def __call__(self, data: dict) -> dict:
        batch = {'image0': data['image0'], 'image1': data['image1']}
        self._model(batch)

        keypoints0 = batch.get('mkpts0_f')
        keypoints1 = batch.get('mkpts1_f')
        confidence = batch.get('mconf')
        if keypoints0 is None or keypoints1 is None:
            raise RuntimeError('EfficientLoFTR did not return fine matches')
        if confidence is None:
            import torch

            confidence = torch.ones(keypoints0.shape[0], device=keypoints0.device)

        return {
            'keypoints0': keypoints0,
            'keypoints1': keypoints1,
            'confidence': confidence,
        }


def _resolve_efficient_loftr_weights(preset: str) -> str | None:
    explicit = os.environ.get('MASTER_PIPELINE_EFFICIENTLOFTR_WEIGHTS')
    if explicit:
        return explicit

    root = resolve_efficient_loftr_root()
    if root is None:
        return None
    weights_dir = root / 'weights'
    # Optimal-quality checkpoints: ScanNet (indoor) generalizes best to
    # low-texture interiors, MegaDepth (outdoor) for textured/exterior frames.
    preferred = (
        ['eloftr_indoor.ckpt', 'eloftr_outdoor.ckpt']
        if preset == 'loftr_indoor'
        else ['eloftr_outdoor.ckpt', 'eloftr_indoor.ckpt']
    )
    for name in preferred:
        candidate = weights_dir / name
        if candidate.exists():
            return str(candidate)
    return None


def iter_efficient_loftr_roots() -> list[Path]:
    candidates = []
    explicit = os.environ.get('MASTER_PIPELINE_EFFICIENTLOFTR_ROOT')
    if explicit:
        candidates.append(Path(explicit).expanduser())
    candidates.append(Path('/opt/EfficientLoFTR'))
    candidates.append(Path.home() / 'EfficientLoFTR')

    unique_candidates = []
    seen = set()
    for candidate in candidates:
        normalized = str(candidate)
        if normalized in seen:
            continue
        seen.add(normalized)
        unique_candidates.append(candidate)
    return unique_candidates


def resolve_efficient_loftr_root() -> Path | None:
    for root in iter_efficient_loftr_roots():
        if root.exists():
            return root
    return None


def format_efficient_loftr_root_candidates() -> str:
    return ','.join(str(root) for root in iter_efficient_loftr_roots())


def load_efficient_loftr_matcher(preset: str, device):
    import copy

    import torch

    configure_model_cache()
    torch.hub.set_dir(os.environ['TORCH_HOME'])

    root = resolve_efficient_loftr_root()
    if root is None:
        raise RuntimeError(f'efficientloftr_root_missing:{format_efficient_loftr_root_candidates()}')
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    from src.loftr import LoFTR as EfficientLoFTR, reparameter  # type: ignore[import-not-found]
    from src.loftr import full_default_cfg, opt_default_cfg  # type: ignore[import-not-found]

    # Optimal weights => full (non-reparameterized) configuration for best
    # geometric accuracy; the "opt" config trades quality for speed.
    config_choice = os.environ.get('MASTER_PIPELINE_EFFICIENTLOFTR_CONFIG', 'full').strip().lower()
    base_cfg = opt_default_cfg if config_choice == 'opt' else full_default_cfg
    config = copy.deepcopy(base_cfg)

    weights_path = _resolve_efficient_loftr_weights(preset)
    if not weights_path:
        raise RuntimeError('efficientloftr_weights_missing')

    matcher = EfficientLoFTR(config=config)
    try:
        state = torch.load(weights_path, map_location='cpu', weights_only=False)
    except TypeError:
        state = torch.load(weights_path, map_location='cpu')
    matcher.load_state_dict(state.get('state_dict', state))
    matcher = reparameter(matcher)
    matcher = matcher.to(device).eval()
    return EfficientLoFTRWrapper(matcher)


def load_loftr_matcher(preset: str, device):
    import torch
    from kornia.feature import LoFTR

    configure_model_cache()
    torch.hub.set_dir(os.environ['TORCH_HOME'])

    if read_env_bool('MASTER_PIPELINE_USE_EFFICIENT_LOFTR', True):
        try:
            return load_efficient_loftr_matcher(preset, device)
        except Exception as error:
            if read_env_bool('MASTER_PIPELINE_EFFICIENT_LOFTR_REQUIRED', False):
                raise
            print(
                f'[learned_matching] EfficientLoFTR unavailable ({error}); '
                'falling back to kornia LoFTR.',
                file=sys.stderr,
            )

    pretrained = 'indoor' if preset == 'loftr_indoor' else 'outdoor'
    return LoFTR(pretrained=pretrained).to(device).eval()


def iter_roma_v2_roots() -> list[Path]:
    candidates = []
    explicit = os.environ.get('MASTER_PIPELINE_ROMA_V2_ROOT')
    if explicit:
        candidates.append(Path(explicit).expanduser())
    candidates.append(Path('/opt/RoMaV2'))
    candidates.append(Path.home() / 'RoMaV2')

    unique_candidates = []
    seen = set()
    for candidate in candidates:
        normalized = str(candidate)
        if normalized in seen:
            continue
        seen.add(normalized)
        unique_candidates.append(candidate)
    return unique_candidates


def resolve_roma_v2_root() -> Path | None:
    for root in iter_roma_v2_roots():
        if (root / 'src' / 'romav2').exists() or (root / 'romav2').exists():
            return root
    return None


def format_roma_v2_root_candidates() -> str:
    return ','.join(str(root) for root in iter_roma_v2_roots())


def configure_roma_v2_imports() -> Path | None:
    root = resolve_roma_v2_root()
    if root is None:
        return None

    for import_root in (root / 'src', root):
        if import_root.exists() and str(import_root) not in sys.path:
            sys.path.insert(0, str(import_root))
    return root


def load_roma_v2_matcher(device, preset: str):
    import torch

    configure_model_cache()
    torch.hub.set_dir(os.environ['TORCH_HOME'])
    if isinstance(device, torch.device) and device.type == 'cuda':
        torch.cuda.set_device(device)
    if hasattr(torch, 'set_float32_matmul_precision'):
        torch.set_float32_matmul_precision('highest')

    root = None
    try:
        from romav2 import RoMaV2
    except ImportError:
        root = configure_roma_v2_imports()
        try:
            from romav2 import RoMaV2
        except ImportError as error:
            if root is None:
                raise RuntimeError(f'roma_v2_unavailable:{format_roma_v2_root_candidates()}') from error
            raise RuntimeError(f'roma_v2_import_failed:{root}') from error

    model = RoMaV2()
    try:
        model.apply_setting(DEFAULT_ROMA_V2_SETTING)
    except Exception as error:
        raise RuntimeError(f'roma_v2_invalid_setting:{DEFAULT_ROMA_V2_SETTING}') from error
    return model.to(device).eval()


def write_explicit_pairs(pair_specs: list[dict], output_path: Path) -> Path:
    with open(output_path, 'w', encoding='utf-8') as handle:
        for pair_spec in pair_specs:
            handle.write(f"{pair_spec['image0'].name} {pair_spec['image1'].name}\n")
    return output_path


def load_router_mask_unions(masks_dir: Path | None, images: list[Path]) -> dict[str, object]:
    import numpy as np

    if masks_dir is None:
        return {}
    try:
        import run_semantic_masks as semantic_masks_loader
    except Exception:
        script_dir = Path(__file__).resolve().parent
        if str(script_dir) not in sys.path:
            sys.path.insert(0, str(script_dir))
        try:
            import run_semantic_masks as semantic_masks_loader  # type: ignore[no-redef]
        except Exception:
            return {}

    manifest = semantic_masks_loader.load_manifest(masks_dir)
    if not manifest or manifest.get('status') not in {'ok', 'no_detections'}:
        return {}

    union_masks: dict[str, object] = {}
    for image in images:
        masks = semantic_masks_loader.load_frame_masks(masks_dir, image.name, manifest)
        union = None
        for mask in masks.values():
            mask_bool = np.asarray(mask) > 0
            union = mask_bool if union is None else (union | mask_bool)
        if union is not None:
            union_masks[image.name] = union
    return union_masks


def count_keypoints_outside_mask(keypoints, union_mask) -> int:
    import numpy as np

    if union_mask is None:
        return int(keypoints.shape[0])
    if keypoints.shape[0] == 0:
        return 0

    height, width = union_mask.shape[:2]
    xs = np.clip(np.round(keypoints[:, 0]).astype(np.int64), 0, width - 1)
    ys = np.clip(np.round(keypoints[:, 1]).astype(np.int64), 0, height - 1)
    inside = union_mask[ys, xs]
    return int((~inside).sum())


def resolve_hloc_pair_group(match_file, image0_name: str, image1_name: str):
    pair_key = f'{image0_name}_{image1_name}' if image0_name < image1_name else f'{image1_name}_{image0_name}'
    if pair_key in match_file:
        return match_file[pair_key]

    nested_pair_key = f'{image0_name}/{image1_name}' if image0_name < image1_name else f'{image1_name}/{image0_name}'
    if nested_pair_key in match_file:
        return match_file[nested_pair_key]

    return None


def collect_hloc_variant_matches(feature_file, match_file, image1: Path, image2: Path):
    """Extract matched keypoint pairs and confidences for a single HLOC detector
    variant (SuperPoint or ALIKED). Returns (keypoints0, keypoints1, confidence)
    or None when the variant produced no usable pair entry."""
    import numpy as np

    feature_group0 = feature_file.get(image1.name)
    feature_group1 = feature_file.get(image2.name)
    if feature_group0 is None or feature_group1 is None:
        return None

    match_group = resolve_hloc_pair_group(match_file, image1.name, image2.name)
    if match_group is None:
        return None

    matches0 = np.asarray(match_group['matches0'][:], dtype=np.int32)
    valid_mask = matches0 >= 0
    match_count = int(valid_mask.sum())
    if match_count == 0:
        return None

    keypoints0_all = np.asarray(feature_group0['keypoints'][:], dtype=np.float32)
    keypoints1_all = np.asarray(feature_group1['keypoints'][:], dtype=np.float32)
    source_indices0 = np.nonzero(valid_mask)[0]
    source_indices1 = matches0[valid_mask]
    keypoints0 = keypoints0_all[source_indices0]
    keypoints1 = keypoints1_all[source_indices1]

    if 'matching_scores0' in match_group:
        confidence = np.asarray(match_group['matching_scores0'][:], dtype=np.float32)[valid_mask]
    else:
        confidence = np.ones(match_count, dtype=np.float32)

    return keypoints0, keypoints1, confidence


def build_hloc_lightglue_edge(
    *,
    variant_files: list[dict],
    image1: Path,
    image2: Path,
    pair_path: Path,
    preview_path: Path,
    pair_id: str,
) -> dict:
    import numpy as np

    collected_kp0: list = []
    collected_kp1: list = []
    collected_conf: list = []
    contributing_sources: list[str] = []

    for variant in variant_files:
        result = collect_hloc_variant_matches(
            variant['featureFile'], variant['matchFile'], image1, image2
        )
        if result is None:
            continue
        kp0, kp1, conf = result
        if kp0.shape[0] == 0:
            continue
        collected_kp0.append(kp0)
        collected_kp1.append(kp1)
        collected_conf.append(conf)
        contributing_sources.append(variant['source'])

    if not collected_kp0:
        raise RuntimeError('No HLOC detector variant produced a pair entry')

    keypoints0 = np.concatenate(collected_kp0, axis=0)
    keypoints1 = np.concatenate(collected_kp1, axis=0)
    confidence = np.concatenate(collected_conf, axis=0)

    match_count = int(confidence.shape[0])
    if match_count < int(DEFAULT_HLOC_MIN_MATCHES):
        raise RuntimeError(
            f'HLOC fused support below threshold ({match_count} < {int(DEFAULT_HLOC_MIN_MATCHES)})'
        )

    order = np.argsort(-confidence)
    keep = order[: min(len(order), int(DEFAULT_HLOC_MAX_MATCHES))]
    keypoints0 = keypoints0[keep]
    keypoints1 = keypoints1[keep]
    confidence = confidence[keep]

    np.savez_compressed(
        pair_path,
        keypoints0=keypoints0,
        keypoints1=keypoints1,
        confidence=confidence,
    )
    write_pair_preview(image1, image2, preview_path)

    match_source = (
        'hloc_lightglue_fused' if len(contributing_sources) > 1 else 'hloc_lightglue'
    )

    return {
        'pairId': pair_id,
        'image0': image1.name,
        'image1': image2.name,
        'pairDataPath': str(pair_path),
        'previewPath': str(preview_path),
        'matchCount': int(confidence.shape[0]),
        'meanConfidence': float(confidence.mean()) if confidence.size else 0.0,
        'matchSource': match_source,
        'variantSources': contributing_sources,
    }


def prepare_hloc_variant_matches(
    *,
    images_dir: Path,
    output_dir: Path,
    feature_key: str,
    variant_name: str,
) -> Path:
    if not HLOC_AVAILABLE or h5py is None:
        raise RuntimeError('HLOC is not available in the active environment')

    hloc_dir = ensure_dir(output_dir / '.hloc' / variant_name)
    features_path = hloc_dir / 'features.h5'

    feature_conf = extract_features.confs[feature_key].copy()
    feature_conf['model'] = dict(feature_conf.get('model', {}))
    feature_conf['model']['max_keypoints'] = int(DEFAULT_HLOC_MAX_KEYPOINTS)
    extract_features.main(feature_conf, images_dir, feature_path=features_path)

    return features_path


def match_hloc_variant_pairs(
    *,
    pair_specs: list[dict],
    output_dir: Path,
    features_path: Path,
    matcher_key: str,
    variant_name: str,
) -> Path:
    if not HLOC_AVAILABLE or h5py is None:
        raise RuntimeError('HLOC is not available in the active environment')

    hloc_dir = ensure_dir(output_dir / '.hloc' / variant_name)
    matches_path = hloc_dir / 'matches.h5'
    pairs_path = hloc_dir / 'pairs.txt'

    if not pair_specs:
        with h5py.File(str(matches_path), 'w'):
            pass
        pairs_path.write_text('', encoding='utf-8')
        return matches_path

    write_explicit_pairs(pair_specs, pairs_path)

    match_conf = match_features.confs[matcher_key].copy()
    match_features.main(match_conf, pairs_path, features_path, matches=matches_path)

    return matches_path


def build_hloc_keypoint_counts(feature_file, images: list[Path], union_masks: dict[str, object] | None = None) -> dict[str, int]:
    import numpy as np

    counts: dict[str, int] = {}
    union_masks = union_masks or {}

    for image in images:
        feature_group = feature_file.get(image.name)
        if feature_group is None or 'keypoints' not in feature_group:
            counts[image.name] = 0
            continue
        keypoints = np.asarray(feature_group['keypoints'][:], dtype=np.float32)
        counts[image.name] = count_keypoints_outside_mask(keypoints, union_masks.get(image.name))

    return counts


def build_hloc_texture_router(
    *,
    images: list[Path],
    pair_specs: list[dict],
    variant_files: list[dict],
) -> dict:
    image_keypoint_counts: dict[str, int] = {}

    if not HLOC_TEXTURE_ROUTER_ENABLED or not variant_files:
        return {
            'enabled': False,
            'routedPairCount': 0,
            'pairDecisions': {},
            'imageKeypointCounts': image_keypoint_counts,
        }

    for image in images:
        image_keypoint_counts[image.name] = max(
            (int(variant['keypointCounts'].get(image.name, 0)) for variant in variant_files),
            default=0,
        )

    pair_decisions: dict[str, dict] = {}
    routed_pair_count = 0
    min_keypoints = int(DEFAULT_HLOC_ROUTER_MIN_KEYPOINTS)

    for pair_spec in pair_specs:
        image1 = pair_spec['image0']
        image2 = pair_spec['image1']
        pair_id = pair_spec['pairId']
        keypoint_support = min(
            image_keypoint_counts.get(image1.name, 0),
            image_keypoint_counts.get(image2.name, 0),
        )
        route_to_loftr = keypoint_support < min_keypoints
        reason = None
        if route_to_loftr:
            reason = (
                'masked_clean_keypoint_router:'
                f' keypoints={keypoint_support}<{min_keypoints}'
            )
            routed_pair_count += 1

        pair_decisions[pair_id] = {
            'routeToLoftr': bool(route_to_loftr),
            'reason': reason,
            'keypointSupport': int(keypoint_support),
        }

    return {
        'enabled': True,
        'routedPairCount': int(routed_pair_count),
        'pairDecisions': pair_decisions,
        'imageKeypointCounts': image_keypoint_counts,
    }


def run_hloc_lightglue_loftr_hybrid(
    *,
    images_dir: Path,
    pair_list: list[tuple[Path, Path]],
    pairs_dir: Path,
    previews_dir: Path,
    output_dir: Path,
    masks_dir: Path | None,
    preset: str,
    image_size: int,
    device,
    dry_run: bool,
    shard_index: int,
    shard_count: int,
) -> tuple[list[dict], list[dict], dict]:
    images = sorted({image for pair in pair_list for image in pair}, key=lambda path: path.name)
    target_pairs = []
    for pair_index, (image1, image2) in enumerate(pair_list):
        if pair_index % max(shard_count, 1) != shard_index:
            continue
        pair_id = build_pair_id(pair_index, image1, image2)
        target_pairs.append({
            'pairId': pair_id,
            'image0': image1,
            'image1': image2,
            'pairPath': pairs_dir / f'{pair_id}.npz',
            'previewPath': previews_dir / f'{pair_id}.jpg',
        })

    if not target_pairs:
        return [], [], {
            'hlocAvailable': bool(HLOC_HYBRID_AVAILABLE),
            'hlocVariants': [variant['source'] for variant in active_hloc_variants(preset)],
            'textureRouterEnabled': bool(HLOC_TEXTURE_ROUTER_ENABLED),
            'textureRouterPairCount': 0,
            'hlocPrimaryPairCount': 0,
            'loftrRescuePairCount': 0,
            'hybridFailureCount': 0,
            'dryRunSimulatedPairCount': 0,
        }

    variant_specs = active_hloc_variants(preset)
    router_union_masks = load_router_mask_unions(masks_dir, images)
    variant_files: list[dict] = []
    primary_dry_run_sources = [variant['source'] for variant in variant_specs] or [expected_hloc_primary_source(preset)]
    hloc_errors: dict[str, str] = {}
    pair_router_decisions: dict[str, dict] = {}
    edges = []
    failures = []
    matcher = None
    hloc_primary_pair_count = 0
    loftr_rescue_pair_count = 0
    loftr_texture_router_pair_count = 0
    dry_run_simulated_pair_count = 0
    router_enabled = False

    try:
        if not dry_run and not variant_specs:
            raise RuntimeError(f'no_hloc_primary_variant_available:{canonicalize_hloc_preset(preset)}')

        if not dry_run and variant_specs:
            for spec in variant_specs:
                features_path = prepare_hloc_variant_matches(
                    images_dir=images_dir,
                    output_dir=output_dir,
                    feature_key=spec['featureKey'],
                    variant_name=spec['name'],
                )
                variant_files.append({
                    'source': spec['source'],
                    'variantName': spec['name'],
                    'matcherKey': spec['matcherKey'],
                    'featuresPath': features_path,
                    'featureFile': h5py.File(features_path, 'r'),
                    'matchFile': None,
                })

            for variant in variant_files:
                variant['keypointCounts'] = build_hloc_keypoint_counts(
                    variant['featureFile'],
                    images,
                    router_union_masks,
                )

            router_stats = build_hloc_texture_router(
                images=images,
                pair_specs=target_pairs,
                variant_files=variant_files,
            )
            router_enabled = bool(router_stats['enabled'])
            pair_router_decisions = dict(router_stats['pairDecisions'])
            hloc_pair_specs = [
                pair_spec for pair_spec in target_pairs
                if not pair_router_decisions.get(pair_spec['pairId'], {}).get('routeToLoftr')
            ]

            for variant in variant_files:
                matches_path = match_hloc_variant_pairs(
                    pair_specs=hloc_pair_specs,
                    output_dir=output_dir,
                    features_path=variant['featuresPath'],
                    matcher_key=variant['matcherKey'],
                    variant_name=variant['variantName'],
                )
                variant['matchFile'] = h5py.File(matches_path, 'r')

        for pair_spec in target_pairs:
            pair_id = pair_spec['pairId']
            image1 = pair_spec['image0']
            image2 = pair_spec['image1']
            pair_path = pair_spec['pairPath']
            preview_path = pair_spec['previewPath']
            router_decision = pair_router_decisions.get(pair_id, {})

            if dry_run:
                edge = process_dry_run_pair('loftr', image1, image2, pair_path, preview_path, pair_id)
                if router_decision.get('routeToLoftr'):
                    edge['matchSource'] = 'loftr_texture_router_dry_run'
                    edge['variantSources'] = ['loftr_texture_router']
                else:
                    edge['matchSource'] = 'hloc_lightglue_primary_dry_run'
                    edge['variantSources'] = list(primary_dry_run_sources)
                edges.append(edge)
                dry_run_simulated_pair_count += 1
                continue

            if router_decision.get('routeToLoftr'):
                if matcher is None:
                    matcher = load_loftr_matcher('loftr_indoor', device)

                try:
                    edge = process_loftr_pair(matcher, image1, image2, pair_path, preview_path, pair_id, image_size, device)
                    edge['matchSource'] = 'loftr_texture_router'
                    edge['variantSources'] = ['loftr_texture_router']
                    edge['primaryError'] = router_decision.get('reason')
                    edge['routerMetrics'] = {
                        'keypointSupport': int(router_decision.get('keypointSupport', 0)),
                    }
                    edges.append(edge)
                    loftr_texture_router_pair_count += 1
                    continue
                except Exception as error:
                    failures.append({
                        'pairId': pair_id,
                        'image0': image1.name,
                        'image1': image2.name,
                        'error': ' | '.join(filter(None, [router_decision.get('reason'), f'loftr: {error}'])),
                    })
                    continue

            if variant_files:
                try:
                    edge = build_hloc_lightglue_edge(
                        variant_files=variant_files,
                        image1=image1,
                        image2=image2,
                        pair_path=pair_path,
                        preview_path=preview_path,
                        pair_id=pair_id,
                    )
                    edges.append(edge)
                    hloc_primary_pair_count += 1
                    continue
                except Exception as error:
                    hloc_errors[pair_id] = str(error)

            if matcher is None:
                matcher = load_loftr_matcher('loftr_indoor', device)

            try:
                edge = process_loftr_pair(matcher, image1, image2, pair_path, preview_path, pair_id, image_size, device)
                edge['matchSource'] = 'loftr_rescue' if pair_id in hloc_errors else 'loftr_primary_fallback'
                edge['variantSources'] = ['loftr_low_texture_rescue'] if pair_id in hloc_errors else ['loftr_primary_fallback']
                if pair_id in hloc_errors:
                    edge['primaryError'] = hloc_errors[pair_id]
                edges.append(edge)
                loftr_rescue_pair_count += 1
            except Exception as error:
                error_parts = []
                if pair_id in hloc_errors:
                    error_parts.append(f"hloc_lightglue: {hloc_errors[pair_id]}")
                elif not HLOC_HYBRID_AVAILABLE:
                    error_parts.append('hloc_lightglue: unavailable_in_active_environment')
                error_parts.append(f'loftr: {error}')
                failures.append({
                    'pairId': pair_id,
                    'image0': image1.name,
                    'image1': image2.name,
                    'error': ' | '.join(error_parts),
                })
    finally:
        for variant in variant_files:
            try:
                variant['featureFile'].close()
            except Exception:
                pass
            try:
                variant['matchFile'].close()
            except Exception:
                pass

    return edges, failures, {
        'hlocAvailable': bool(HLOC_HYBRID_AVAILABLE),
        'hlocVariants': [variant['source'] for variant in variant_specs],
        'textureRouterEnabled': bool(router_enabled),
        'textureRouterPairCount': int(loftr_texture_router_pair_count),
        'hlocPrimaryPairCount': int(hloc_primary_pair_count),
        'loftrRescuePairCount': int(loftr_rescue_pair_count),
        'hybridFailureCount': int(len(failures)),
        'dryRunSimulatedPairCount': int(dry_run_simulated_pair_count),
    }


def load_fast3r_model(device):
    import torch

    configure_model_cache()
    configure_fast3r_imports()
    from fast3r.models.fast3r import Fast3R

    torch.hub.set_dir(os.environ['TORCH_HOME'])
    torch.backends.cuda.matmul.allow_tf32 = True
    weights_path = os.environ.get('MASTER_PIPELINE_FAST3R_WEIGHTS') or DEFAULT_FAST3R_MODEL_NAME
    try:
        model = Fast3R.from_pretrained(weights_path).to(device).eval()
    except NameError as exc:
        if 'safetensors' not in str(exc):
            raise
        raise RuntimeError(
            'Fast3r checkpoint loading requires safetensors; install safetensors>=0.4.3 in the active Python environment'
        ) from exc
    return model, weights_path


def reciprocal_nn_matches_3d(pointmap0, pointmap1, confidence_map0, confidence_map1):
    import numpy as np
    from scipy.spatial import cKDTree

    h0, w0 = pointmap0.shape[:2]
    h1, w1 = pointmap1.shape[:2]
    y0, x0 = np.indices((h0, w0), dtype=np.float32)
    y1, x1 = np.indices((h1, w1), dtype=np.float32)

    valid0 = np.isfinite(pointmap0).all(axis=-1) & np.isfinite(confidence_map0)
    valid1 = np.isfinite(pointmap1).all(axis=-1) & np.isfinite(confidence_map1)
    if valid0.sum() < 128 or valid1.sum() < 128:
        raise RuntimeError('Fast3r point maps do not contain enough valid points')

    threshold0 = np.quantile(confidence_map0[valid0], 0.7)
    threshold1 = np.quantile(confidence_map1[valid1], 0.7)
    strong0 = valid0 & (confidence_map0 >= threshold0)
    strong1 = valid1 & (confidence_map1 >= threshold1)
    if strong0.sum() >= 128:
        valid0 = strong0
    if strong1.sum() >= 128:
        valid1 = strong1

    points0 = pointmap0[valid0].reshape(-1, 3)
    points1 = pointmap1[valid1].reshape(-1, 3)
    pixels0 = np.stack([x0[valid0], y0[valid0]], axis=-1).astype(np.float32)
    pixels1 = np.stack([x1[valid1], y1[valid1]], axis=-1).astype(np.float32)
    conf0 = confidence_map0[valid0].reshape(-1).astype(np.float32)
    conf1 = confidence_map1[valid1].reshape(-1).astype(np.float32)

    tree1 = cKDTree(points1)
    distances01, nearest01 = tree1.query(points0, k=1)
    tree0 = cKDTree(points0)
    _distances10, nearest10 = tree0.query(points1, k=1)

    candidate_indices0 = np.arange(points0.shape[0], dtype=np.int32)
    reciprocal = nearest10[nearest01] == candidate_indices0
    candidate_indices0 = candidate_indices0[reciprocal]
    candidate_indices1 = nearest01[reciprocal]
    candidate_distances = distances01[reciprocal]
    if candidate_indices0.size < DEFAULT_FAST3R_MIN_DIRECT_MATCHES:
        raise RuntimeError('Fast3r produced too few reciprocal 3D correspondences')

    scene_points = np.concatenate([points0, points1], axis=0)
    scene_center = np.median(scene_points, axis=0)
    scene_scale = np.median(np.linalg.norm(scene_points - scene_center, axis=1))
    if not np.isfinite(scene_scale) or scene_scale <= 1e-6:
        scene_scale = 1.0

    distance_limit = np.quantile(candidate_distances, 0.9)
    distance_limit = max(distance_limit, scene_scale * 0.01)
    distance_mask = candidate_distances <= distance_limit
    if distance_mask.sum() >= DEFAULT_FAST3R_MIN_DIRECT_MATCHES:
        candidate_indices0 = candidate_indices0[distance_mask]
        candidate_indices1 = candidate_indices1[distance_mask]

    keypoints0 = pixels0[candidate_indices0]
    keypoints1 = pixels1[candidate_indices1]
    confidence = ((conf0[candidate_indices0] + conf1[candidate_indices1]) * 0.5).astype(np.float32)
    order = np.argsort(-confidence)
    keep = order[: min(len(order), DEFAULT_FAST3R_MAX_MATCHES)]
    return keypoints0[keep], keypoints1[keep], confidence[keep]


def orient_fast3r_prediction(pointmap, confidence_map, true_shape):
    import numpy as np

    height, width = int(true_shape[0]), int(true_shape[1])
    oriented_pointmap = np.asarray(pointmap, dtype=np.float32)
    oriented_confidence = np.asarray(confidence_map, dtype=np.float32)
    if height > width:
        oriented_pointmap = np.transpose(oriented_pointmap, (1, 0, 2))
        oriented_confidence = np.transpose(oriented_confidence, (1, 0))
    return oriented_pointmap, oriented_confidence


def scale_matches_to_original(matches, image_path: Path, resized_shape):
    import numpy as np

    orig_w, orig_h = read_image_size(image_path)
    resized_h = max(int(resized_shape[0]), 1)
    resized_w = max(int(resized_shape[1]), 1)
    scaled = np.asarray(matches, dtype=np.float32).copy()
    scaled[:, 0] *= float(orig_w) / float(resized_w)
    scaled[:, 1] *= float(orig_h) / float(resized_h)
    return scaled


def estimate_similarity_transform(source_points, target_points):
    import numpy as np

    source = np.asarray(source_points, dtype=np.float64)
    target = np.asarray(target_points, dtype=np.float64)
    if source.shape != target.shape or source.shape[0] < 3:
        raise RuntimeError('Not enough points for local-head alignment')

    source_mean = source.mean(axis=0)
    target_mean = target.mean(axis=0)
    source_centered = source - source_mean
    target_centered = target - target_mean

    covariance = (target_centered.T @ source_centered) / float(source.shape[0])
    u, singular_values, vh = np.linalg.svd(covariance)
    correction = np.eye(3, dtype=np.float64)
    if np.linalg.det(u) * np.linalg.det(vh) < 0:
        correction[-1, -1] = -1.0

    rotation = u @ correction @ vh
    variance = np.mean(np.sum(source_centered * source_centered, axis=1))
    if not np.isfinite(variance) or variance <= 1e-12:
        scale = 1.0
    else:
        scale = float(np.sum(singular_values * np.diag(correction)) / variance)
    translation = target_mean - scale * (rotation @ source_mean)
    return rotation.astype(np.float32), np.asarray(translation, dtype=np.float32), float(scale)


def align_local_head_to_global(pointmap_global, confidence_global, pointmap_local, confidence_local):
    import numpy as np

    valid_mask = (
        np.isfinite(pointmap_global).all(axis=-1)
        & np.isfinite(pointmap_local).all(axis=-1)
        & np.isfinite(confidence_global)
        & np.isfinite(confidence_local)
    )
    if valid_mask.sum() < 16:
        return None

    combined_confidence = (np.asarray(confidence_global, dtype=np.float32) + np.asarray(confidence_local, dtype=np.float32)) * 0.5
    threshold = np.quantile(combined_confidence[valid_mask], 0.8)
    strong_mask = valid_mask & (combined_confidence >= threshold)
    if strong_mask.sum() < 8:
        strong_mask = valid_mask

    source_points = np.asarray(pointmap_local[strong_mask], dtype=np.float32).reshape(-1, 3)
    target_points = np.asarray(pointmap_global[strong_mask], dtype=np.float32).reshape(-1, 3)
    if source_points.shape[0] < 3:
        return None

    rotation, translation, scale = estimate_similarity_transform(source_points, target_points)
    aligned = np.asarray(pointmap_local, dtype=np.float32).reshape(-1, 3)
    aligned = (scale * (aligned @ rotation.T)) + translation
    return aligned.reshape(pointmap_local.shape), np.asarray(confidence_local, dtype=np.float32)


def extract_fast3r_prediction_variants(view, pred):
    import numpy as np

    variants = []
    pointmap_global, confidence_global = extract_fast3r_prediction(view, pred)
    variants.append({
        'name': 'global_head',
        'pointmap': pointmap_global,
        'confidence': confidence_global,
    })

    local_pointmap_raw = pred.get('pts3d_local')
    local_confidence_raw = pred.get('conf_local')
    if local_pointmap_raw is not None and local_confidence_raw is not None:
        true_shape = to_numpy(view['true_shape'][0], dtype=np.int32)
        local_pointmap, local_confidence = orient_fast3r_prediction(
            to_numpy(local_pointmap_raw, dtype=np.float32).squeeze(0),
            to_numpy(local_confidence_raw, dtype=np.float32).squeeze(0),
            true_shape,
        )
        aligned = align_local_head_to_global(pointmap_global, confidence_global, local_pointmap, local_confidence)
        if aligned is not None:
            aligned_pointmap, aligned_confidence = aligned
            variants.append({
                'name': 'local_head_aligned',
                'pointmap': aligned_pointmap,
                'confidence': aligned_confidence,
            })

    return variants


def merge_pair_matches(keypoints0, keypoints1, confidence, max_matches: int | None = None, dedupe_radius: float = 2.5, window_support: int = 1):
    import numpy as np

    keypoints0 = np.asarray(keypoints0, dtype=np.float32)
    keypoints1 = np.asarray(keypoints1, dtype=np.float32)
    confidence = np.asarray(confidence, dtype=np.float32).reshape(-1)
    if keypoints0.size == 0 or keypoints1.size == 0 or confidence.size == 0:
        return (
            np.zeros((0, 2), dtype=np.float32),
            np.zeros((0, 2), dtype=np.float32),
            np.zeros((0,), dtype=np.float32),
        )

    if keypoints0.ndim == 1:
        keypoints0 = keypoints0.reshape(-1, 2)
    if keypoints1.ndim == 1:
        keypoints1 = keypoints1.reshape(-1, 2)

    if max_matches is None:
        max_matches = resolve_fast3r_match_cap(int(confidence.shape[0]), window_support=window_support)

    bucket_size = max(float(dedupe_radius), 1.0)
    order = np.argsort(-confidence)
    fused_keypoints0 = []
    fused_keypoints1 = []
    fused_confidence = []
    seen_buckets = set()

    for index in order:
        bucket = (
            int(np.floor(float(keypoints0[index, 0]) / bucket_size)),
            int(np.floor(float(keypoints0[index, 1]) / bucket_size)),
            int(np.floor(float(keypoints1[index, 0]) / bucket_size)),
            int(np.floor(float(keypoints1[index, 1]) / bucket_size)),
        )
        if bucket in seen_buckets:
            continue
        seen_buckets.add(bucket)
        fused_keypoints0.append(keypoints0[index])
        fused_keypoints1.append(keypoints1[index])
        fused_confidence.append(confidence[index])
        if len(fused_confidence) >= max_matches:
            break

    return (
        np.asarray(fused_keypoints0, dtype=np.float32),
        np.asarray(fused_keypoints1, dtype=np.float32),
        np.asarray(fused_confidence, dtype=np.float32),
    )


def build_tracks_from_match_entries(feature_store: dict[str, dict], match_entries: list[dict]) -> list[dict]:
    import math
    import numpy as np

    class UnionFind:
        def __init__(self):
            self.parent = {}
            self.rank = {}

        def add(self, item):
            if item in self.parent:
                return
            self.parent[item] = item
            self.rank[item] = 0

        def find(self, item):
            parent = self.parent[item]
            if parent != item:
                self.parent[item] = self.find(parent)
            return self.parent[item]

        def union(self, left, right):
            left_root = self.find(left)
            right_root = self.find(right)
            if left_root == right_root:
                return
            if self.rank[left_root] < self.rank[right_root]:
                left_root, right_root = right_root, left_root
            self.parent[right_root] = left_root
            if self.rank[left_root] == self.rank[right_root]:
                self.rank[left_root] += 1

    union_find = UnionFind()
    image_scores = {
        image_name: [float(score) for score in store.get('scores', [])]
        for image_name, store in feature_store.items()
    }
    image_keypoints = {
        image_name: store.get('keypoints', [])
        for image_name, store in feature_store.items()
    }

    for image_name, keypoints in image_keypoints.items():
        for keypoint_index in range(len(keypoints)):
            union_find.add((image_name, int(keypoint_index)))

    for pair_entry in match_entries:
        image0 = pair_entry['image0']
        image1 = pair_entry['image1']
        for keypoint_index0, keypoint_index1 in pair_entry.get('globalMatches', []):
            left = (image0, int(keypoint_index0))
            right = (image1, int(keypoint_index1))
            if left not in union_find.parent or right not in union_find.parent:
                continue
            union_find.union(left, right)

    components: dict[tuple[str, int], list[tuple[str, int]]] = {}
    for node in union_find.parent:
        root = union_find.find(node)
        components.setdefault(root, []).append(node)

    component_pair_metrics: dict[tuple[str, int], dict[str, dict]] = {}
    for pair_entry in match_entries:
        image0 = pair_entry['image0']
        image1 = pair_entry['image1']
        if bool(pair_entry.get('syntheticConsolidation')) or image0 == image1:
            continue
        pair_id = str(pair_entry.get('pairId') or f'{image0}__{image1}')
        window_support = int(pair_entry.get('windowSupport', 1) or 1)
        mean_confidence = float(pair_entry.get('meanConfidence', 0.0) or 0.0)
        variant_sources = [str(value) for value in pair_entry.get('variantSources', [])]
        uses_local_head = any('local_head' in value for value in variant_sources)

        for keypoint_index0, keypoint_index1 in pair_entry.get('globalMatches', []):
            left = (image0, int(keypoint_index0))
            right = (image1, int(keypoint_index1))
            if left not in union_find.parent or right not in union_find.parent:
                continue

            left_root = union_find.find(left)
            right_root = union_find.find(right)
            if left_root != right_root:
                continue

            root_pair_metrics = component_pair_metrics.setdefault(left_root, {})
            pair_metrics = root_pair_metrics.setdefault(pair_id, {
                'windowSupport': window_support,
                'meanConfidence': mean_confidence,
                'usesLocalHead': uses_local_head,
                'variantSourceCount': len(variant_sources),
                'connectionCount': 0,
            })
            pair_metrics['windowSupport'] = max(int(pair_metrics['windowSupport']), window_support)
            pair_metrics['meanConfidence'] = max(float(pair_metrics['meanConfidence']), mean_confidence)
            pair_metrics['usesLocalHead'] = bool(pair_metrics['usesLocalHead'] or uses_local_head)
            pair_metrics['variantSourceCount'] = max(int(pair_metrics['variantSourceCount']), len(variant_sources))
            pair_metrics['connectionCount'] += 1

    tracks = []
    for track_index, (root, members) in enumerate(sorted(components.items(), key=lambda item: len(item[1]), reverse=True)):
        observations_by_image = {}
        for image_name, keypoint_index in members:
            score_list = image_scores.get(image_name, [])
            score = float(score_list[keypoint_index]) if keypoint_index < len(score_list) else 0.0
            existing = observations_by_image.get(image_name)
            if existing is None or score > existing['score']:
                observations_by_image[image_name] = {
                    'image': image_name,
                    'keypointIndex': int(keypoint_index),
                    'xy': image_keypoints[image_name][keypoint_index],
                    'score': score,
                }

        observations = sorted(observations_by_image.values(), key=lambda item: (item['image'], item['keypointIndex']))
        if len(observations) < 2:
            continue

        pair_metrics = component_pair_metrics.get(root, {})
        connection_count = sum(int(metric.get('connectionCount', 0)) for metric in pair_metrics.values())
        weighted_window_support = 0.0
        weighted_mean_confidence = 0.0
        for metric in pair_metrics.values():
            metric_connection_count = max(int(metric.get('connectionCount', 0)), 1)
            weighted_window_support += float(metric.get('windowSupport', 1)) * metric_connection_count
            weighted_mean_confidence += float(metric.get('meanConfidence', 0.0)) * metric_connection_count
        mean_window_support = weighted_window_support / connection_count if connection_count > 0 else 1.0
        mean_pair_confidence = weighted_mean_confidence / connection_count if connection_count > 0 else 0.0
        max_window_support = max((int(metric.get('windowSupport', 1)) for metric in pair_metrics.values()), default=1)
        local_head_pair_count = sum(1 for metric in pair_metrics.values() if bool(metric.get('usesLocalHead')))
        multiview_pair_count = sum(1 for metric in pair_metrics.values() if int(metric.get('windowSupport', 1)) > 1)
        max_variant_source_count = max((int(metric.get('variantSourceCount', 0)) for metric in pair_metrics.values()), default=0)

        tracks.append({
            'trackId': f'track_{track_index:06d}',
            'support': len(observations),
            'meanScore': float(sum(observation['score'] for observation in observations) / len(observations)),
            'sourcePairCount': len(pair_metrics),
            'sourceConnectionCount': int(connection_count),
            'multiviewSourcePairCount': int(multiview_pair_count),
            'localHeadSourcePairCount': int(local_head_pair_count),
            'maxWindowSupport': int(max_window_support),
            'meanWindowSupport': float(mean_window_support) if math.isfinite(mean_window_support) else 1.0,
            'meanPairConfidence': float(mean_pair_confidence) if math.isfinite(mean_pair_confidence) else 0.0,
            'maxVariantSourceCount': int(max_variant_source_count),
            'observations': observations,
        })

    return tracks


def track_is_fast3r_multiview_consolidation_candidate(track: dict) -> bool:
    support = int(track.get('support', 0))
    if support < 2 or support > FAST3R_TRACK_CONSOLIDATION_MAX_TRACK_SUPPORT:
        return False
    if int(track.get('sourcePairCount', 0)) < FAST3R_TRACK_CONSOLIDATION_MIN_SOURCE_PAIRS:
        return False
    if int(track.get('multiviewSourcePairCount', 0)) < FAST3R_TRACK_CONSOLIDATION_MIN_MULTIVIEW_SOURCE_PAIRS:
        return False
    if int(track.get('localHeadSourcePairCount', 0)) < FAST3R_TRACK_CONSOLIDATION_MIN_LOCAL_HEAD_SOURCE_PAIRS:
        return False
    if int(track.get('maxWindowSupport', 1)) < FAST3R_TRACK_CONSOLIDATION_MIN_WINDOW_SUPPORT:
        return False
    if float(track.get('meanPairConfidence', 0.0)) < FAST3R_TRACK_CONSOLIDATION_MIN_MEAN_PAIR_CONFIDENCE:
        return False
    if float(track.get('meanScore', 0.0)) < FAST3R_TRACK_CONSOLIDATION_MIN_MEAN_SCORE:
        return False
    return True


def tracks_are_fast3r_multiview_compatible(track0: dict, track1: dict, merge_radius: float, reject_radius: float, min_shared_images: int) -> tuple[bool, list[str]]:
    import numpy as np

    observations0 = {observation['image']: np.asarray(observation['xy'], dtype=np.float32) for observation in track0.get('observations', [])}
    observations1 = {observation['image']: np.asarray(observation['xy'], dtype=np.float32) for observation in track1.get('observations', [])}
    shared_images = []
    for image_name in sorted(set(observations0) & set(observations1)):
        distance = float(np.linalg.norm(observations0[image_name] - observations1[image_name]))
        if distance <= merge_radius:
            shared_images.append(image_name)
        elif distance >= reject_radius:
            return False, []
        else:
            return False, []

    if len(shared_images) < min_shared_images:
        return False, []

    combined_support = len(set(observations0) | set(observations1))
    if combined_support <= max(len(observations0), len(observations1)):
        return False, []

    return True, shared_images


def track_is_roma_multiview_consolidation_candidate(track: dict) -> bool:
    support = int(track.get('support', 0))
    if support < 2 or support > ROMA_TRACK_CONSOLIDATION_MAX_TRACK_SUPPORT:
        return False
    if float(track.get('meanScore', 0.0)) < ROMA_TRACK_CONSOLIDATION_MIN_MEAN_SCORE:
        return False
    return True


def build_multiview_consolidation_match_entries(
    tracks: list[dict],
    *,
    candidate_filter,
    merge_radius: float,
    reject_radius: float,
    min_shared_images: int,
) -> list[dict]:
    import numpy as np

    merge_radius = float(merge_radius)
    reject_radius = float(max(reject_radius, merge_radius))
    min_shared_images = int(min_shared_images)
    candidate_track_indices = [
        track_index
        for track_index, track in enumerate(tracks)
        if candidate_filter(track)
    ]
    if len(candidate_track_indices) < 2:
        return []

    bucket_size = max(float(merge_radius), 1.0)
    candidate_pairs: dict[tuple[int, int], set[str]] = {}
    observations_by_image: dict[str, list[tuple[int, dict]]] = {}
    for track_index in candidate_track_indices:
        for observation in tracks[track_index].get('observations', []):
            observations_by_image.setdefault(observation['image'], []).append((track_index, observation))

    for image_name in sorted(observations_by_image):
        bucket_index: dict[tuple[int, int], list[tuple[int, dict, np.ndarray]]] = {}
        for track_index, observation in observations_by_image[image_name]:
            xy = np.asarray(observation['xy'], dtype=np.float32)
            cell = point_bucket(xy, bucket_size)
            for offset_x in (-1, 0, 1):
                for offset_y in (-1, 0, 1):
                    for other_track_index, _other_observation, other_xy in bucket_index.get((cell[0] + offset_x, cell[1] + offset_y), []):
                        if other_track_index == track_index:
                            continue
                        if float(np.linalg.norm(xy - other_xy)) > reject_radius:
                            continue
                        pair_key = tuple(sorted((track_index, other_track_index)))
                        candidate_pairs.setdefault(pair_key, set()).add(image_name)
            bucket_index.setdefault(cell, []).append((track_index, observation, xy))

    consolidation_entries = []
    for track_index0, track_index1 in sorted(candidate_pairs):
        compatible, shared_images = tracks_are_fast3r_multiview_compatible(
            tracks[track_index0],
            tracks[track_index1],
            merge_radius=merge_radius,
            reject_radius=reject_radius,
            min_shared_images=min_shared_images,
        )
        if not compatible:
            continue
        image_name = shared_images[0]
        observation0 = next(entry for entry in tracks[track_index0].get('observations', []) if entry['image'] == image_name)
        observation1 = next(entry for entry in tracks[track_index1].get('observations', []) if entry['image'] == image_name)
        consolidation_entries.append({
            'pairId': f'consolidation__{image_name}__{tracks[track_index0]["trackId"]}__{tracks[track_index1]["trackId"]}',
            'image0': image_name,
            'image1': image_name,
            'globalMatches': [[int(observation0['keypointIndex']), int(observation1['keypointIndex'])]],
            'syntheticConsolidation': True,
        })

    return consolidation_entries


def consolidate_multiview_tracks_generic(
    feature_store: dict[str, dict],
    match_entries: list[dict],
    tracks: list[dict],
    *,
    passes: int,
    candidate_filter,
    merge_radius: float,
    reject_radius: float,
    min_shared_images: int,
) -> tuple[list[dict], list[dict]]:
    current_tracks = list(tracks)
    augmented_match_entries = list(match_entries)
    consolidation_entries = []
    for _pass_index in range(int(passes)):
        new_entries = build_multiview_consolidation_match_entries(
            current_tracks,
            candidate_filter=candidate_filter,
            merge_radius=merge_radius,
            reject_radius=reject_radius,
            min_shared_images=min_shared_images,
        )
        if not new_entries:
            break
        augmented_match_entries.extend(new_entries)
        next_tracks = build_tracks_from_match_entries(feature_store, augmented_match_entries)
        consolidation_entries.extend(new_entries)
        if len(next_tracks) >= len(current_tracks):
            break
        current_tracks = next_tracks

    return current_tracks, consolidation_entries


def consolidate_fast3r_multiview_tracks(feature_store: dict[str, dict], match_entries: list[dict], tracks: list[dict]) -> tuple[list[dict], list[dict]]:
    if not FAST3R_MULTIVIEW_TRACK_CONSOLIDATION_ENABLED:
        return tracks, []

    return consolidate_multiview_tracks_generic(
        feature_store,
        match_entries,
        tracks,
        passes=int(FAST3R_TRACK_CONSOLIDATION_PASSES),
        candidate_filter=track_is_fast3r_multiview_consolidation_candidate,
        merge_radius=float(FAST3R_TRACK_CONSOLIDATION_MERGE_RADIUS),
        reject_radius=float(FAST3R_TRACK_CONSOLIDATION_REJECT_RADIUS),
        min_shared_images=int(FAST3R_TRACK_CONSOLIDATION_MIN_SHARED_IMAGES),
    )


def consolidate_roma_multiview_tracks(feature_store: dict[str, dict], match_entries: list[dict], tracks: list[dict]) -> tuple[list[dict], list[dict]]:
    if not ROMA_MULTIVIEW_TRACK_CONSOLIDATION_ENABLED:
        return tracks, []

    return consolidate_multiview_tracks_generic(
        feature_store,
        match_entries,
        tracks,
        passes=int(ROMA_TRACK_CONSOLIDATION_PASSES),
        candidate_filter=track_is_roma_multiview_consolidation_candidate,
        merge_radius=float(ROMA_TRACK_CONSOLIDATION_MERGE_RADIUS),
        reject_radius=float(ROMA_TRACK_CONSOLIDATION_REJECT_RADIUS),
        min_shared_images=int(ROMA_TRACK_CONSOLIDATION_MIN_SHARED_IMAGES),
    )


def resolve_fast3r_match_cap(candidate_count: int, window_support: int = 1) -> int:
    base_cap = int(DEFAULT_FAST3R_MAX_MATCHES)
    max_cap = int(DEFAULT_FAST3R_MAX_MATCHES_CEILING)
    if candidate_count <= base_cap:
        return base_cap

    overflow = max(0, int(candidate_count) - base_cap)
    overflow_steps = (overflow + DEFAULT_FAST3R_MATCH_CAP_STEP - 1) // DEFAULT_FAST3R_MATCH_CAP_STEP
    adaptive_cap = base_cap + (overflow_steps * DEFAULT_FAST3R_MATCH_CAP_STEP)
    adaptive_cap += max(0, int(window_support) - 1) * DEFAULT_FAST3R_MATCH_CAP_WINDOW_BONUS
    return min(max_cap, max(base_cap, adaptive_cap))


def select_preferred_fast3r_variant(view, pred):
    variants = extract_fast3r_prediction_variants(view, pred)
    return next((variant for variant in variants if variant['name'] == 'local_head_aligned'), variants[0])


def resolve_fast3r_context_window_size(image_count: int, requested_window_size: int = DEFAULT_FAST3R_CONTEXT_WINDOW_SIZE) -> int:
    if image_count <= 0:
        return 0

    minimum_window_size = min(image_count, 4)
    return min(image_count, max(int(requested_window_size), minimum_window_size))


def build_fast3r_window_indices(image_count: int, requested_window_size: int = DEFAULT_FAST3R_CONTEXT_WINDOW_SIZE) -> list[tuple[int, ...]]:
    effective_window_size = resolve_fast3r_context_window_size(image_count, requested_window_size)
    if effective_window_size == 0:
        return []

    windows: list[tuple[int, ...]] = []
    seen_windows: set[tuple[int, ...]] = set()

    def add_window(indices) -> None:
        window = tuple(int(index) for index in indices)
        if len(window) != effective_window_size:
            return
        if len(set(window)) != len(window):
            return
        if window in seen_windows:
            return
        seen_windows.add(window)
        windows.append(window)

    if image_count <= effective_window_size:
        add_window(range(image_count))
        return windows

    for start_index in range(0, image_count - effective_window_size + 1):
        add_window(range(start_index, start_index + effective_window_size))

    for wrap_count in range(1, effective_window_size):
        tail_count = effective_window_size - wrap_count
        add_window(list(range(image_count - tail_count, image_count)) + list(range(0, wrap_count)))

    return windows


def process_loftr_pair(matcher, image1: Path, image2: Path, pair_path: Path, preview_path: Path, pair_id: str, image_size: int, device) -> dict:
    import numpy as np
    import torch

    image0_tensor, scale0 = load_grayscale_image(image1, image_size)
    image1_tensor, scale1 = load_grayscale_image(image2, image_size)
    data = {
        'image0': image0_tensor.to(device),
        'image1': image1_tensor.to(device),
    }

    with torch.inference_mode():
        output = matcher(data)

    keypoints0 = output['keypoints0'].detach().cpu().numpy().astype(np.float32)
    keypoints1 = output['keypoints1'].detach().cpu().numpy().astype(np.float32)
    confidence = output['confidence'].detach().cpu().numpy().astype(np.float32)

    if keypoints0.size == 0:
        raise RuntimeError('LoFTR produced no usable correspondences')

    keypoints0[:, 0] /= max(scale0, 1e-6)
    keypoints0[:, 1] /= max(scale0, 1e-6)
    keypoints1[:, 0] /= max(scale1, 1e-6)
    keypoints1[:, 1] /= max(scale1, 1e-6)

    order = np.argsort(-confidence)
    keep = order[: min(len(order), 8192)]
    keypoints0 = keypoints0[keep]
    keypoints1 = keypoints1[keep]
    confidence = confidence[keep]

    confidence_mask = confidence >= 0.2
    keypoints0 = keypoints0[confidence_mask]
    keypoints1 = keypoints1[confidence_mask]
    confidence = confidence[confidence_mask]
    if confidence.size < 32:
        raise RuntimeError('LoFTR correspondences fell below minimum support after filtering')

    np.savez_compressed(
        pair_path,
        keypoints0=keypoints0,
        keypoints1=keypoints1,
        confidence=confidence,
    )
    write_pair_preview(image1, image2, preview_path)

    return {
        'pairId': pair_id,
        'image0': image1.name,
        'image1': image2.name,
        'pairDataPath': str(pair_path),
        'previewPath': str(preview_path),
        'matchCount': int(confidence.shape[0]),
        'meanConfidence': float(confidence.mean()),
    }


def filter_roma_v2_inliers(keypoints0, keypoints1):
    import cv2
    import numpy as np

    if keypoints0.shape[0] < 8:
        raise RuntimeError('RoMa v2 produced fewer than 8 correspondences before geometric verification')

    method = getattr(cv2, 'USAC_MAGSAC', cv2.FM_RANSAC)
    try:
        _fundamental, mask = cv2.findFundamentalMat(
            keypoints0,
            keypoints1,
            method,
            DEFAULT_ROMA_V2_RANSAC_REPROJECTION_THRESHOLD,
            DEFAULT_ROMA_V2_RANSAC_CONFIDENCE,
            DEFAULT_ROMA_V2_RANSAC_MAX_ITERS,
        )
    except TypeError:
        _fundamental, mask = cv2.findFundamentalMat(
            keypoints0,
            keypoints1,
            method,
            DEFAULT_ROMA_V2_RANSAC_REPROJECTION_THRESHOLD,
            DEFAULT_ROMA_V2_RANSAC_CONFIDENCE,
        )

    if mask is None and method != cv2.FM_RANSAC:
        _fundamental, mask = cv2.findFundamentalMat(
            keypoints0,
            keypoints1,
            cv2.FM_RANSAC,
            DEFAULT_ROMA_V2_RANSAC_REPROJECTION_THRESHOLD,
            DEFAULT_ROMA_V2_RANSAC_CONFIDENCE,
        )

    if mask is None:
        raise RuntimeError('RoMa v2 geometric verification failed to estimate a fundamental matrix')

    inlier_mask = np.asarray(mask).reshape(-1).astype(bool)
    if int(inlier_mask.sum()) < DEFAULT_ROMA_V2_MIN_MATCHES:
        raise RuntimeError('RoMa v2 correspondences fell below minimum support after geometric verification')
    return inlier_mask


def process_roma_v2_pair(matcher, image1: Path, image2: Path, pair_path: Path, preview_path: Path, pair_id: str, image_size: int, device) -> dict:
    import numpy as np
    import torch

    del image_size, device

    width0, height0 = read_image_size(image1)
    width1, height1 = read_image_size(image2)

    with torch.inference_mode():
        preds = matcher.match(image1, image2)
        matches, overlap, _precision_ab, _precision_ba = matcher.sample(preds, DEFAULT_ROMA_V2_SAMPLED_MATCHES)
        keypoints0, keypoints1 = matcher.to_pixel_coordinates(matches, height0, width0, height1, width1)

    keypoints0 = to_numpy(keypoints0, np.float32).reshape(-1, 2)
    keypoints1 = to_numpy(keypoints1, np.float32).reshape(-1, 2)
    confidence = np.clip(to_numpy(overlap, np.float32).reshape(-1), 0.0, None)

    if keypoints0.size == 0:
        raise RuntimeError('RoMa v2 produced no usable correspondences')

    # RoMa returns pixel-center coordinates; shift back to COLMAP-style image space.
    keypoints0 -= 0.5
    keypoints1 -= 0.5

    valid_mask = (
        np.isfinite(keypoints0).all(axis=1)
        & np.isfinite(keypoints1).all(axis=1)
        & np.isfinite(confidence)
        & (keypoints0[:, 0] >= 0.0)
        & (keypoints0[:, 0] < float(width0))
        & (keypoints0[:, 1] >= 0.0)
        & (keypoints0[:, 1] < float(height0))
        & (keypoints1[:, 0] >= 0.0)
        & (keypoints1[:, 0] < float(width1))
        & (keypoints1[:, 1] >= 0.0)
        & (keypoints1[:, 1] < float(height1))
    )
    keypoints0 = keypoints0[valid_mask]
    keypoints1 = keypoints1[valid_mask]
    confidence = confidence[valid_mask]
    if confidence.size < DEFAULT_ROMA_V2_MIN_MATCHES:
        raise RuntimeError('RoMa v2 correspondences fell below minimum support after sampling')

    inlier_mask = filter_roma_v2_inliers(keypoints0, keypoints1)
    keypoints0 = keypoints0[inlier_mask]
    keypoints1 = keypoints1[inlier_mask]
    confidence = confidence[inlier_mask]

    order = np.argsort(-confidence)
    keep = order[: min(len(order), DEFAULT_ROMA_V2_MAX_MATCHES)]
    keypoints0 = keypoints0[keep]
    keypoints1 = keypoints1[keep]
    confidence = confidence[keep]

    np.savez_compressed(
        pair_path,
        keypoints0=keypoints0,
        keypoints1=keypoints1,
        confidence=confidence,
    )
    write_pair_preview(image1, image2, preview_path)

    return {
        'pairId': pair_id,
        'image0': image1.name,
        'image1': image2.name,
        'pairDataPath': str(pair_path),
        'previewPath': str(preview_path),
        'matchCount': int(confidence.shape[0]),
        'meanConfidence': float(confidence.mean()),
    }


def run_fast3r_inference(model, image_paths: list[Path], context_id: str, image_size: int, device):
    import torch
    from fast3r.dust3r.inference_multiview import inference
    from fast3r.dust3r.utils.image import load_images

    views = load_images([str(image_path) for image_path in image_paths], size=image_size)
    for index, (view, image_path) in enumerate(zip(views, image_paths)):
        view.setdefault('dataset', 'master_v1')
        view.setdefault('label', image_path.name)
        view.setdefault('instance', f'{context_id}:{index}')
    return inference(views, model, device, dtype=torch.float32, verbose=False)


def extract_fast3r_prediction(view, pred):
    import numpy as np

    true_shape = to_numpy(view['true_shape'][0], dtype=np.int32)
    pointmap_raw = to_numpy(pred.get('pts3d_in_other_view', pred.get('pts3d')), dtype=np.float32).squeeze(0)
    confidence_map_raw = to_numpy(pred.get('conf'), dtype=np.float32).squeeze(0)
    return orient_fast3r_prediction(pointmap_raw, confidence_map_raw, true_shape)


def build_fast3r_edge_from_predictions(
    image1: Path,
    image2: Path,
    pair_id: str,
    view0,
    pred0,
    view1,
    pred1,
) -> dict:
    import numpy as np

    variants0 = extract_fast3r_prediction_variants(view0, pred0)
    variants1 = extract_fast3r_prediction_variants(view1, pred1)

    match_keypoints0 = []
    match_keypoints1 = []
    match_confidence = []
    selected_pointmap0 = variants0[0]['pointmap']
    selected_pointmap1 = variants1[0]['pointmap']
    selected_confidence0 = variants0[0]['confidence']
    selected_confidence1 = variants1[0]['confidence']
    source_names = []

    for variant0 in variants0:
        for variant1 in variants1:
            if variant0['name'] != variant1['name'] and {'local_head_aligned', 'global_head'} != {variant0['name'], variant1['name']}:
                continue
            try:
                matches_im0, matches_im1, confidence = reciprocal_nn_matches_3d(
                    variant0['pointmap'],
                    variant1['pointmap'],
                    variant0['confidence'],
                    variant1['confidence'],
                )
            except Exception:
                continue
            match_keypoints0.append(scale_matches_to_original(matches_im0, image1, variant0['pointmap'].shape[:2]))
            match_keypoints1.append(scale_matches_to_original(matches_im1, image2, variant1['pointmap'].shape[:2]))
            match_confidence.append(confidence)
            source_names.append(f"{variant0['name']}->{variant1['name']}")
            if variant0['name'] == 'local_head_aligned' and variant1['name'] == 'local_head_aligned':
                selected_pointmap0 = variant0['pointmap']
                selected_pointmap1 = variant1['pointmap']
                selected_confidence0 = variant0['confidence']
                selected_confidence1 = variant1['confidence']

    if not match_confidence:
        raise RuntimeError('Fast3r produced too few reciprocal 3D correspondences')

    keypoints0, keypoints1, confidence = merge_pair_matches(
        np.concatenate(match_keypoints0, axis=0),
        np.concatenate(match_keypoints1, axis=0),
        np.concatenate(match_confidence, axis=0),
        window_support=1,
    )
    if confidence.size < DEFAULT_FAST3R_MIN_DIRECT_MATCHES:
        raise RuntimeError('Fast3r correspondences fell below minimum support after 3D reciprocal matching')

    return {
        'pairId': pair_id,
        'image0': image1.name,
        'image1': image2.name,
        'keypoints0': keypoints0,
        'keypoints1': keypoints1,
        'confidence': confidence,
        'pointmap0': selected_pointmap0,
        'pointmap1': selected_pointmap1,
        'confidence_map0': selected_confidence0,
        'confidence_map1': selected_confidence1,
        'pointmapShape': [int(value) for value in selected_pointmap0.shape],
        'validPointsImage1': int(np.isfinite(selected_pointmap0).all(axis=-1).sum()),
        'validPointsImage2': int(np.isfinite(selected_pointmap1).all(axis=-1).sum()),
        'meanConfidenceImage1': float(np.mean(selected_confidence0[np.isfinite(selected_confidence0)])),
        'meanConfidenceImage2': float(np.mean(selected_confidence1[np.isfinite(selected_confidence1)])),
        'matchCount': int(confidence.shape[0]),
        'meanConfidence': float(confidence.mean()),
        'variantSources': source_names,
    }


def build_fast3r_track_consensus_candidates(
    *,
    window_images: list[Path],
    window_pairs: list[dict],
    direct_edges: list[dict],
    window_views,
    window_preds,
) -> dict[str, dict]:
    preferred_variants = {
        image_path.name: select_preferred_fast3r_variant(view, pred)
        for image_path, view, pred in zip(window_images, window_views, window_preds)
    }
    image_artifacts_by_name = {
        image_name: {
            'pointmap': variant['pointmap'],
            'confidence': variant['confidence'],
        }
        for image_name, variant in preferred_variants.items()
    }
    return build_fast3r_track_consensus_candidates_from_edges(
        feature_images=window_images,
        pair_specs=window_pairs,
        direct_edges=direct_edges,
        image_artifacts_by_name=image_artifacts_by_name,
        minimum_match_count=DEFAULT_FAST3R_MIN_TRACK_RESCUE_MATCHES,
        min_track_support=DEFAULT_FAST3R_WINDOW_TRACK_MIN_SUPPORT,
        variant_sources=['multiview_track_consensus'],
    )


def build_fast3r_track_consensus_candidates_from_edges(
    *,
    feature_images: list[Path],
    pair_specs: list[dict],
    direct_edges: list[dict],
    image_artifacts_by_name: dict[str, dict],
    minimum_match_count: int,
    min_track_support: int,
    variant_sources: list[str],
) -> dict[str, dict]:
    import numpy as np

    if len(direct_edges) < 2 or not pair_specs:
        return {}

    feature_store = init_feature_store(feature_images)
    match_entries = []
    for edge in direct_edges:
        keypoints0 = np.asarray(edge['keypoints0'], dtype=np.float32)
        keypoints1 = np.asarray(edge['keypoints1'], dtype=np.float32)
        confidence = np.asarray(edge['confidence'], dtype=np.float32).reshape(-1)
        if confidence.size == 0:
            continue
        indices0 = assign_global_keypoints(feature_store, edge['image0'], keypoints0, confidence)
        indices1 = assign_global_keypoints(feature_store, edge['image1'], keypoints1, confidence)
        global_matches = np.stack([indices0, indices1], axis=1).astype(np.uint32)
        match_entries.append({
            'pairId': edge['pairId'],
            'image0': edge['image0'],
            'image1': edge['image1'],
            'globalMatches': global_matches.tolist(),
            'windowSupport': int(edge.get('windowSupport', 1) or 1),
            'meanConfidence': float(edge.get('meanConfidence', 0.0) or 0.0),
            'variantSources': [str(value) for value in edge.get('variantSources', [])],
        })

    if not match_entries:
        return {}

    tracks = build_tracks_from_match_entries(feature_store, match_entries)
    if not tracks:
        return {}
    pair_lookup = {
        (pair_spec['image0'].name, pair_spec['image1'].name): pair_spec
        for pair_spec in pair_specs
    }
    pair_accumulator: dict[str, dict[str, list]] = {}

    for track in tracks:
        if int(track.get('support', 0)) < min_track_support:
            continue
        observations = track.get('observations', [])
        for left_observation, right_observation in itertools.combinations(observations, 2):
            image_pair = tuple(sorted((left_observation['image'], right_observation['image'])))
            pair_spec = pair_lookup.get(image_pair)
            if pair_spec is None:
                continue
            if left_observation['image'] == pair_spec['image0'].name:
                observation0, observation1 = left_observation, right_observation
            else:
                observation0, observation1 = right_observation, left_observation
            accumulator = pair_accumulator.setdefault(pair_spec['pairId'], {
                'keypoints0': [],
                'keypoints1': [],
                'confidence': [],
                'trackSupports': [],
            })
            accumulator['keypoints0'].append(observation0['xy'])
            accumulator['keypoints1'].append(observation1['xy'])
            accumulator['confidence'].append(float(min(observation0.get('score', 0.0), observation1.get('score', 0.0))))
            accumulator['trackSupports'].append(int(track.get('support', 0)))

    candidates = {}
    for pair_spec in pair_specs:
        accumulator = pair_accumulator.get(pair_spec['pairId'])
        if accumulator is None:
            continue
        keypoints0, keypoints1, confidence = merge_pair_matches(
            np.asarray(accumulator['keypoints0'], dtype=np.float32),
            np.asarray(accumulator['keypoints1'], dtype=np.float32),
            np.asarray(accumulator['confidence'], dtype=np.float32),
            window_support=max(int(max(accumulator.get('trackSupports', [min_track_support]))), 1),
        )
        if confidence.size < int(minimum_match_count):
            continue

        artifact0 = image_artifacts_by_name.get(pair_spec['image0'].name)
        artifact1 = image_artifacts_by_name.get(pair_spec['image1'].name)
        if artifact0 is None or artifact1 is None:
            continue
        pointmap0 = np.asarray(artifact0['pointmap'], dtype=np.float32)
        pointmap1 = np.asarray(artifact1['pointmap'], dtype=np.float32)
        confidence_map0 = np.asarray(artifact0['confidence'], dtype=np.float32)
        confidence_map1 = np.asarray(artifact1['confidence'], dtype=np.float32)
        candidates[pair_spec['pairId']] = {
            'pairId': pair_spec['pairId'],
            'image0': pair_spec['image0'].name,
            'image1': pair_spec['image1'].name,
            'keypoints0': keypoints0,
            'keypoints1': keypoints1,
            'confidence': confidence,
            'pointmap0': pointmap0,
            'pointmap1': pointmap1,
            'confidence_map0': confidence_map0,
            'confidence_map1': confidence_map1,
            'pointmapShape': [int(value) for value in pointmap0.shape],
            'validPointsImage1': int(np.isfinite(pointmap0).all(axis=-1).sum()),
            'validPointsImage2': int(np.isfinite(pointmap1).all(axis=-1).sum()),
            'meanConfidenceImage1': float(np.mean(confidence_map0[np.isfinite(confidence_map0)])),
            'meanConfidenceImage2': float(np.mean(confidence_map1[np.isfinite(confidence_map1)])),
            'matchCount': int(confidence.shape[0]),
            'meanConfidence': float(confidence.mean()) if confidence.size else 0.0,
            'variantSources': [str(value) for value in variant_sources],
            'windowSupport': max(accumulator.get('trackSupports', [DEFAULT_FAST3R_WINDOW_TRACK_MIN_SUPPORT])),
            'sourceTrackCount': int(len(accumulator.get('trackSupports', []))),
        }

    return candidates


def build_fast3r_image_artifacts_by_name(direct_edges: list[dict]) -> dict[str, dict]:
    import numpy as np

    artifacts_by_name: dict[str, dict] = {}

    def register(image_name: str, pointmap_key: str, confidence_key: str, edge: dict) -> None:
        score = (
            int(edge.get('windowSupport', 1) or 1),
            int(edge.get('matchCount', 0) or 0),
            float(edge.get('meanConfidence', 0.0) or 0.0),
        )
        current = artifacts_by_name.get(image_name)
        if current is not None and tuple(current.get('scoreKey', ())) >= score:
            return
        artifacts_by_name[image_name] = {
            'pointmap': np.asarray(edge[pointmap_key], dtype=np.float32),
            'confidence': np.asarray(edge[confidence_key], dtype=np.float32),
            'scoreKey': score,
        }

    for edge in direct_edges:
        register(str(edge['image0']), 'pointmap0', 'confidence_map0', edge)
        register(str(edge['image1']), 'pointmap1', 'confidence_map1', edge)

    return artifacts_by_name


def build_fast3r_failed_pair_rescue_candidates(*, images: list[Path], failed_pair_specs: list[dict], pair_candidates: dict[str, list[dict]]) -> dict[str, dict]:
    if not FAST3R_FAILED_PAIR_MULTIVIEW_RESCUE_ENABLED:
        return {}

    direct_edges = [
        candidate
        for candidate_list in pair_candidates.values()
        for candidate in candidate_list
        if not fast3r_candidate_uses_track_consensus(candidate)
    ]
    if len(direct_edges) < 2 or not failed_pair_specs:
        return {}

    image_artifacts_by_name = build_fast3r_image_artifacts_by_name(direct_edges)
    return build_fast3r_track_consensus_candidates_from_edges(
        feature_images=images,
        pair_specs=failed_pair_specs,
        direct_edges=direct_edges,
        image_artifacts_by_name=image_artifacts_by_name,
        minimum_match_count=FAST3R_FAILED_PAIR_RESCUE_MIN_MATCHES,
        min_track_support=DEFAULT_FAST3R_WINDOW_TRACK_MIN_SUPPORT,
        variant_sources=['multiview_track_consensus', 'failed_pair_multiview_rescue'],
    )


def build_fast3r_failed_pair_two_view_rescue_candidates(
    *,
    model,
    failed_pair_specs: list[dict],
    image_size: int,
    device,
) -> dict[str, dict]:
    if not FAST3R_FAILED_PAIR_TWO_VIEW_RESCUE_ENABLED:
        return {}

    rescued_candidates = {}
    for pair_spec in failed_pair_specs:
        try:
            output = run_fast3r_inference(
                model,
                [pair_spec['image0'], pair_spec['image1']],
                f"{pair_spec['pairId']}__failed_pair_two_view",
                image_size,
                device,
            )
            views = output['views']
            preds = output['preds']
            candidate = build_fast3r_edge_from_predictions(
                pair_spec['image0'],
                pair_spec['image1'],
                pair_spec['pairId'],
                views[0],
                preds[0],
                views[1],
                preds[1],
            )
        except Exception:
            continue

        candidate['variantSources'] = sorted({
            *[str(value) for value in candidate.get('variantSources', [])],
            'failed_pair_two_view_rescue',
        })
        rescued_candidates[pair_spec['pairId']] = candidate

    return rescued_candidates


def write_fast3r_pair_result(image1: Path, image2: Path, pair_path: Path, preview_path: Path, pair_result: dict) -> dict:
    import numpy as np

    np.savez_compressed(
        pair_path,
        keypoints0=np.asarray(pair_result['keypoints0'], dtype=np.float32),
        keypoints1=np.asarray(pair_result['keypoints1'], dtype=np.float32),
        confidence=np.asarray(pair_result['confidence'], dtype=np.float32),
        pointmap0=np.asarray(pair_result['pointmap0'], dtype=np.float32),
        pointmap1=np.asarray(pair_result['pointmap1'], dtype=np.float32),
        confidence_map0=np.asarray(pair_result['confidence_map0'], dtype=np.float32),
        confidence_map1=np.asarray(pair_result['confidence_map1'], dtype=np.float32),
    )
    write_pair_preview(image1, image2, preview_path)
    serialized = {
        key: value
        for key, value in pair_result.items()
        if key not in {'keypoints0', 'keypoints1', 'confidence', 'pointmap0', 'pointmap1', 'confidence_map0', 'confidence_map1'}
    }
    serialized['pairDataPath'] = str(pair_path)
    serialized['previewPath'] = str(preview_path)
    return serialized


def fast3r_candidate_uses_track_consensus(candidate: dict) -> bool:
    return 'multiview_track_consensus' in {str(value) for value in candidate.get('variantSources', [])}


def scale_fast3r_candidate_confidence(candidate: dict):
    import numpy as np

    confidence = np.asarray(candidate['confidence'], dtype=np.float32).reshape(-1)
    if confidence.size == 0:
        return confidence

    scaled_confidence = confidence.copy()
    scaled_confidence *= 1.0 + (max(0, int(candidate.get('windowSupport', 1) or 1) - 1) * FAST3R_WINDOW_SUPPORT_CONFIDENCE_BOOST)
    if fast3r_candidate_uses_track_consensus(candidate):
        scaled_confidence *= FAST3R_TRACK_CONSENSUS_CONFIDENCE_BOOST
    return scaled_confidence


def fuse_fast3r_candidate_subset(pair_candidates: list[dict], max_matches: int):
    import numpy as np

    if not pair_candidates or max_matches <= 0:
        return (
            np.zeros((0, 2), dtype=np.float32),
            np.zeros((0, 2), dtype=np.float32),
            np.zeros((0,), dtype=np.float32),
        )

    max_window_support = max(int(candidate.get('windowSupport', 1) or 1) for candidate in pair_candidates)
    return merge_pair_matches(
        np.concatenate([np.asarray(candidate['keypoints0'], dtype=np.float32) for candidate in pair_candidates], axis=0),
        np.concatenate([np.asarray(candidate['keypoints1'], dtype=np.float32) for candidate in pair_candidates], axis=0),
        np.concatenate([scale_fast3r_candidate_confidence(candidate) for candidate in pair_candidates], axis=0),
        max_matches=max_matches,
        window_support=max_window_support,
    )


def fuse_fast3r_pair_candidates(pair_candidates: list[dict]) -> dict:
    import numpy as np

    if not pair_candidates:
        raise RuntimeError('No Fast3r candidates available for fusion')

    consensus_candidates = [candidate for candidate in pair_candidates if fast3r_candidate_uses_track_consensus(candidate)]
    direct_candidates = [candidate for candidate in pair_candidates if not fast3r_candidate_uses_track_consensus(candidate)]
    max_window_support = max(int(candidate.get('windowSupport', 1) or 1) for candidate in pair_candidates)
    total_candidate_count = sum(int(np.asarray(candidate['confidence']).reshape(-1).shape[0]) for candidate in pair_candidates)
    overall_match_cap = resolve_fast3r_match_cap(total_candidate_count, window_support=max_window_support)

    consensus_keypoints0 = np.zeros((0, 2), dtype=np.float32)
    consensus_keypoints1 = np.zeros((0, 2), dtype=np.float32)
    consensus_confidence = np.zeros((0,), dtype=np.float32)
    if consensus_candidates:
        consensus_available = sum(int(np.asarray(candidate['confidence']).reshape(-1).shape[0]) for candidate in consensus_candidates)
        consensus_quota = max(
            int(FAST3R_TRACK_CONSENSUS_MIN_RESERVE),
            int(round(float(overall_match_cap) * FAST3R_TRACK_CONSENSUS_RESERVE_FRACTION)),
        )
        consensus_quota = min(consensus_available, overall_match_cap, max(consensus_quota, 0))
        consensus_keypoints0, consensus_keypoints1, consensus_confidence = fuse_fast3r_candidate_subset(
            consensus_candidates,
            consensus_quota,
        )

    remaining_match_cap = max(overall_match_cap - int(consensus_confidence.shape[0]), 0)
    direct_keypoints0, direct_keypoints1, direct_confidence = fuse_fast3r_candidate_subset(
        direct_candidates if direct_candidates else pair_candidates,
        remaining_match_cap if (direct_candidates and remaining_match_cap > 0) else overall_match_cap,
    )

    keypoints0, keypoints1, confidence = merge_pair_matches(
        np.concatenate([consensus_keypoints0, direct_keypoints0], axis=0),
        np.concatenate([consensus_keypoints1, direct_keypoints1], axis=0),
        np.concatenate([consensus_confidence, direct_confidence], axis=0),
        max_matches=overall_match_cap,
        window_support=max_window_support,
    )
    if confidence.size < 32:
        raise RuntimeError('Fast3r correspondences fell below minimum support after multiview fusion')

    best_candidate = max(pair_candidates, key=lambda candidate: (candidate['matchCount'], candidate['meanConfidence']))
    fused_result = dict(best_candidate)
    fused_result['keypoints0'] = keypoints0
    fused_result['keypoints1'] = keypoints1
    fused_result['confidence'] = confidence
    fused_result['matchCount'] = int(confidence.shape[0])
    fused_result['meanConfidence'] = float(confidence.mean()) if confidence.size else 0.0
    fused_result['windowSupport'] = max_window_support
    fused_result['variantSources'] = sorted({
        str(source)
        for candidate in pair_candidates
        for source in candidate.get('variantSources', [])
    })
    fused_result['consensusCandidateCount'] = int(len(consensus_candidates))
    fused_result['consensusReservedMatchCount'] = int(consensus_confidence.shape[0])
    fused_result['sourceTrackCount'] = int(sum(int(candidate.get('sourceTrackCount', 0)) for candidate in consensus_candidates))
    return fused_result


def process_fast3r_pair(model, image1: Path, image2: Path, pair_path: Path, preview_path: Path, pair_id: str, image_size: int, device) -> dict:
    output = run_fast3r_inference(model, [image1, image2], pair_id, image_size, device)
    views = output['views']
    preds = output['preds']
    pair_result = build_fast3r_edge_from_predictions(
        image1,
        image2,
        pair_id,
        views[0],
        preds[0],
        views[1],
        preds[1],
    )
    return write_fast3r_pair_result(image1, image2, pair_path, preview_path, pair_result)


def run_fast3r_multiview_context(
    *,
    model,
    images: list[Path],
    pair_list: list[tuple[Path, Path]],
    pairs_dir: Path,
    previews_dir: Path,
    image_size: int,
    device,
    shard_index: int,
    shard_count: int,
) -> tuple[list[dict], list[dict]]:
    image_indices = {image.name: index for index, image in enumerate(images)}
    target_pairs = []
    for pair_index, (image1, image2) in enumerate(pair_list):
        if pair_index % max(shard_count, 1) != shard_index:
            continue
        target_pairs.append({
            'pairId': build_pair_id(pair_index, image1, image2),
            'image0': image1,
            'image1': image2,
            'imageIndex0': image_indices[image1.name],
            'imageIndex1': image_indices[image2.name],
            'pairPath': pairs_dir / f'{build_pair_id(pair_index, image1, image2)}.npz',
            'previewPath': previews_dir / f'{build_pair_id(pair_index, image1, image2)}.jpg',
        })

    if not target_pairs:
        return [], []

    pair_candidates: dict[str, list[dict]] = {}
    failure_reasons: dict[str, str] = {}
    window_indices_list = build_fast3r_window_indices(len(images), DEFAULT_FAST3R_CONTEXT_WINDOW_SIZE)

    for window_number, window_indices in enumerate(window_indices_list):
        window_images = [images[index] for index in window_indices]
        window_index_set = set(window_indices)
        window_pairs = [
            pair_spec
            for pair_spec in target_pairs
            if pair_spec['imageIndex0'] in window_index_set and pair_spec['imageIndex1'] in window_index_set
        ]
        if not window_pairs:
            continue

        output = run_fast3r_inference(
            model,
            window_images,
            f'window_{window_number:03d}',
            image_size,
            device,
        )
        window_views = output['views']
        window_preds = output['preds']
        local_indices = {global_index: local_index for local_index, global_index in enumerate(window_indices)}
        direct_window_edges = []

        for pair_spec in window_pairs:
            try:
                candidate_edge = build_fast3r_edge_from_predictions(
                    pair_spec['image0'],
                    pair_spec['image1'],
                    pair_spec['pairId'],
                    window_views[local_indices[pair_spec['imageIndex0']]],
                    window_preds[local_indices[pair_spec['imageIndex0']]],
                    window_views[local_indices[pair_spec['imageIndex1']]],
                    window_preds[local_indices[pair_spec['imageIndex1']]],
                )
                direct_window_edges.append(candidate_edge)
                pair_candidates.setdefault(pair_spec['pairId'], []).append(candidate_edge)
                failure_reasons.pop(pair_spec['pairId'], None)
            except Exception as error:
                if pair_spec['pairId'] not in pair_candidates:
                    failure_reasons[pair_spec['pairId']] = str(error)

        track_consensus_candidates = build_fast3r_track_consensus_candidates(
            window_images=window_images,
            window_pairs=window_pairs,
            direct_edges=direct_window_edges,
            window_views=window_views,
            window_preds=window_preds,
        )
        for pair_id, candidate_edge in track_consensus_candidates.items():
            pair_candidates.setdefault(pair_id, []).append(candidate_edge)
            failure_reasons.pop(pair_id, None)

    failed_pair_specs = [
        pair_spec
        for pair_spec in target_pairs
        if not pair_candidates.get(pair_spec['pairId'])
    ]
    failed_pair_rescue_candidates = build_fast3r_failed_pair_rescue_candidates(
        images=images,
        failed_pair_specs=failed_pair_specs,
        pair_candidates=pair_candidates,
    )
    for pair_id, candidate_edge in failed_pair_rescue_candidates.items():
        pair_candidates.setdefault(pair_id, []).append(candidate_edge)
        failure_reasons.pop(pair_id, None)

    unresolved_pair_specs = [
        pair_spec
        for pair_spec in target_pairs
        if not pair_candidates.get(pair_spec['pairId'])
    ]
    failed_pair_two_view_candidates = build_fast3r_failed_pair_two_view_rescue_candidates(
        model=model,
        failed_pair_specs=unresolved_pair_specs,
        image_size=image_size,
        device=device,
    )
    for pair_id, candidate_edge in failed_pair_two_view_candidates.items():
        pair_candidates.setdefault(pair_id, []).append(candidate_edge)
        failure_reasons.pop(pair_id, None)

    edges = []
    failures = []
    for pair_spec in target_pairs:
        candidates = pair_candidates.get(pair_spec['pairId'])
        if candidates:
            try:
                fused_result = fuse_fast3r_pair_candidates(candidates)
                edges.append(write_fast3r_pair_result(
                    pair_spec['image0'],
                    pair_spec['image1'],
                    pair_spec['pairPath'],
                    pair_spec['previewPath'],
                    fused_result,
                ))
                continue
            except Exception as error:
                failure_reasons[pair_spec['pairId']] = str(error)

        failures.append({
            'pairId': pair_spec['pairId'],
            'image0': pair_spec['image0'].name,
            'image1': pair_spec['image1'].name,
            'error': failure_reasons.get(pair_spec['pairId'], 'Fast3r multiview context did not yield usable correspondences'),
        })

    return edges, failures


def process_dry_run_pair(backend: str, image1: Path, image2: Path, pair_path: Path, preview_path: Path, pair_id: str) -> dict:
    import numpy as np

    keypoints0, keypoints1, confidence = build_dry_run_matches()
    payload = {
        'keypoints0': keypoints0,
        'keypoints1': keypoints1,
        'confidence': confidence,
    }
    edge = {
        'pairId': pair_id,
        'image0': image1.name,
        'image1': image2.name,
        'pairDataPath': str(pair_path),
        'previewPath': str(preview_path),
        'matchCount': int(confidence.shape[0]),
        'meanConfidence': float(confidence.mean()),
    }

    if backend == 'fast3r':
        pointmap0, pointmap1, conf0, conf1 = build_dry_run_pointmaps()
        payload.update({
            'pointmap0': pointmap0,
            'pointmap1': pointmap1,
            'confidence_map0': conf0,
            'confidence_map1': conf1,
        })
        edge.update({
            'pointmapShape': [int(value) for value in pointmap0.shape],
            'validPointsImage1': int(np.isfinite(pointmap0).all(axis=-1).sum()),
            'validPointsImage2': int(np.isfinite(pointmap1).all(axis=-1).sum()),
            'meanConfidenceImage1': float(conf0.mean()),
            'meanConfidenceImage2': float(conf1.mean()),
        })

    np.savez_compressed(pair_path, **payload)
    write_pair_preview(image1, image2, preview_path)
    return edge


def run_worker(
    *,
    job_id: str,
    images_dir: Path,
    images: list[Path],
    output_dir: Path,
    masks_dir: Path | None,
    preset: str,
    image_size: int,
    dry_run: bool,
    gpu_indices: list[str],
    shard_index: int,
    shard_count: int,
) -> dict:
    backend = resolve_backend(preset)
    pairs_dir = ensure_dir(output_dir / 'pairs')
    previews_dir = ensure_dir(output_dir / 'previews')
    failures = []
    edges = []
    if backend == 'fast3r':
        pair_list = select_fast3r_pairs(images)
        pair_selection_policy = 'all_pairs_within_fast3r_context_windows'
    else:
        pair_list, pair_selection_policy = select_pairs(images)

    try:
        import torch as torch_module
    except ImportError:
        torch_module = None

    device = resolve_torch_device(gpu_indices, require_torch=not dry_run)
    model = None
    model_checkpoint = None
    hybrid_stats = None

    if not dry_run:
        if backend == 'fast3r':
            model, model_checkpoint = load_fast3r_model(device)
        elif backend == 'roma_v2':
            model = load_roma_v2_matcher(device, preset)
        elif backend == 'loftr':
            model = load_loftr_matcher(preset, device)

    if backend == 'fast3r' and not dry_run:
        edges, failures = run_fast3r_multiview_context(
            model=model,
            images=images,
            pair_list=pair_list,
            pairs_dir=pairs_dir,
            previews_dir=previews_dir,
            image_size=image_size,
            device=device,
            shard_index=shard_index,
            shard_count=shard_count,
        )
    elif backend == 'hloc_lightglue_loftr':
        edges, failures, hybrid_stats = run_hloc_lightglue_loftr_hybrid(
            images_dir=images_dir,
            pair_list=pair_list,
            pairs_dir=pairs_dir,
            previews_dir=previews_dir,
            output_dir=output_dir,
            masks_dir=masks_dir,
            preset=preset,
            image_size=image_size,
            device=device,
            dry_run=dry_run,
            shard_index=shard_index,
            shard_count=shard_count,
        )
    else:
        for pair_index, (image1, image2) in enumerate(pair_list):
            if pair_index % max(shard_count, 1) != shard_index:
                continue

            pair_id = build_pair_id(pair_index, image1, image2)
            pair_path = pairs_dir / f'{pair_id}.npz'
            preview_path = previews_dir / f'{pair_id}.jpg'

            try:
                if dry_run:
                    edge = process_dry_run_pair(backend, image1, image2, pair_path, preview_path, pair_id)
                elif backend == 'fast3r':
                    edge = process_fast3r_pair(model, image1, image2, pair_path, preview_path, pair_id, image_size, device)
                elif backend == 'roma_v2':
                    edge = process_roma_v2_pair(model, image1, image2, pair_path, preview_path, pair_id, image_size, device)
                else:
                    edge = process_loftr_pair(model, image1, image2, pair_path, preview_path, pair_id, image_size, device)
                edges.append(edge)
            except Exception as error:
                failures.append({
                    'pairId': pair_id,
                    'image0': image1.name,
                    'image1': image2.name,
                    'error': str(error),
                })

    del model
    if torch_module is not None and torch_module.cuda.is_available():
        torch_module.cuda.empty_cache()

    canonical_preset = canonicalize_hloc_preset(preset) if backend == 'hloc_lightglue_loftr' else preset
    payload = {
        'jobId': job_id,
        'createdAt': now_iso(),
        'backend': backend,
        'preset': canonical_preset,
        'dryRun': dry_run,
        'device': str(device),
        'gpuIndices': gpu_indices,
        'shardIndex': shard_index,
        'shardCount': shard_count,
        'modelCheckpoint': model_checkpoint,
        'contextWindowSize': resolve_fast3r_context_window_size(len(images)) if backend == 'fast3r' else None,
        'pairSelectionPolicy': pair_selection_policy,
        'edges': edges,
        'failures': failures,
        'hybridStats': hybrid_stats,
    }
    if canonical_preset != preset:
        payload['requestedPreset'] = preset
    return payload


class ReflectiveMaskFilter:
    """Drop correspondences that fall inside mirror / window regions.

    Reflections and through-glass parallax inject view-dependent geometry that
    biases the global SfM solve, so we remove any match whose pixel in either
    image lands inside a masked surface before the matches reach COLMAP.

    By default we exclude the ``glass`` bucket because open-vocab detections
    frequently over-segment shiny bathroom surfaces. Masks whose manifest
    coverage exceeds ``DEFAULT_MATCHING_REFLECTIVE_MASK_MAX_COVERAGE`` are also
    skipped as likely false positives.
    """

    def __init__(self, masks_dir: Path, manifest: dict, loader_module):
        self._masks_dir = masks_dir
        self._manifest = manifest
        self._loader = loader_module
        self._cache: dict[str, object] = {}
        self._frame_lookup = loader_module.manifest_frame_lookup(manifest)
        self._mask_classes = DEFAULT_MATCHING_REFLECTIVE_MASK_CLASSES
        self._max_coverage = float(DEFAULT_MATCHING_REFLECTIVE_MASK_MAX_COVERAGE)

    def _class_coverage(self, image_name: str, class_name: str) -> float:
        record = self._frame_lookup.get(image_name) or {}
        coverage = record.get('coverage') or {}
        try:
            return float(coverage.get(class_name, 0.0) or 0.0)
        except (TypeError, ValueError):
            return 0.0

    def _union_mask(self, image_name: str):
        import numpy as np

        if image_name in self._cache:
            return self._cache[image_name]

        masks = self._loader.load_frame_masks(self._masks_dir, image_name, self._manifest)
        union = None
        for class_name in self._mask_classes:
            mask = masks.get(class_name)
            if mask is None:
                continue
            if self._max_coverage > 0.0 and self._class_coverage(image_name, class_name) > self._max_coverage:
                continue
            mask_bool = np.asarray(mask) > 0
            union = mask_bool if union is None else (union | mask_bool)
        self._cache[image_name] = union
        return union

    @staticmethod
    def _inside(union, keypoints) -> object:
        import numpy as np

        height, width = union.shape[:2]
        xs = np.clip(np.round(keypoints[:, 0]).astype(np.int64), 0, width - 1)
        ys = np.clip(np.round(keypoints[:, 1]).astype(np.int64), 0, height - 1)
        return union[ys, xs]

    def keep_pair(self, image0_name: str, keypoints0, image1_name: str, keypoints1):
        import numpy as np

        union0 = self._union_mask(image0_name)
        union1 = self._union_mask(image1_name)
        if union0 is None and union1 is None:
            return None
        if keypoints0.shape[0] == 0:
            return np.ones((0,), dtype=bool)

        inside = np.zeros((keypoints0.shape[0],), dtype=bool)
        if union0 is not None:
            inside |= self._inside(union0, keypoints0)
        if union1 is not None:
            inside |= self._inside(union1, keypoints1)
        return ~inside


def load_reflective_mask_filter(masks_dir: Path | None) -> ReflectiveMaskFilter | None:
    if masks_dir is None:
        return None
    try:
        import run_semantic_masks as semantic_masks_loader
    except Exception:
        script_dir = Path(__file__).resolve().parent
        if str(script_dir) not in sys.path:
            sys.path.insert(0, str(script_dir))
        try:
            import run_semantic_masks as semantic_masks_loader  # type: ignore[no-redef]
        except Exception:
            return None

    manifest = semantic_masks_loader.load_manifest(masks_dir)
    if not manifest:
        return None
    if manifest.get('status') not in {'ok', 'no_detections'}:
        return None
    lookup = semantic_masks_loader.manifest_frame_lookup(manifest)
    has_any_mask = any(
        any((record.get('masks') or {}).values())
        for record in lookup.values()
    )
    if not has_any_mask:
        return None
    return ReflectiveMaskFilter(Path(masks_dir), manifest, semantic_masks_loader)


def finalize_outputs(
    *,
    job_id: str,
    images: list[Path],
    output_dir: Path,
    preset: str,
    image_size: int,
    manifests: list[dict],
    masks_dir: Path | None = None,
) -> dict:
    import numpy as np

    backend = resolve_backend(preset)
    dry_run = any(bool(manifest.get('dryRun')) for manifest in manifests)
    feature_store = init_feature_store(images)
    match_entries = []
    mask_filter = load_reflective_mask_filter(masks_dir)
    matches_dropped_by_mask = 0
    edges = sorted(
        [edge for manifest in manifests for edge in manifest.get('edges', [])],
        key=lambda item: item['pairId'],
    )
    failures = sorted(
        [failure for manifest in manifests for failure in manifest.get('failures', [])],
        key=lambda item: item['pairId'],
    )

    for edge in edges:
        pair_path = Path(edge['pairDataPath'])
        with np.load(pair_path, allow_pickle=False) as pair_data:
            payload = {key: pair_data[key] for key in pair_data.files}
            keypoints0 = np.asarray(payload['keypoints0'], dtype=np.float32)
            keypoints1 = np.asarray(payload['keypoints1'], dtype=np.float32)
            confidence = np.asarray(payload['confidence'], dtype=np.float32)

        if keypoints0.ndim == 1:
            keypoints0 = keypoints0.reshape(-1, 2)
        if keypoints1.ndim == 1:
            keypoints1 = keypoints1.reshape(-1, 2)
        if confidence.ndim > 1:
            confidence = confidence.reshape(-1)

        if mask_filter is not None:
            keep_mask = mask_filter.keep_pair(edge['image0'], keypoints0, edge['image1'], keypoints1)
            if keep_mask is not None:
                dropped = int((~keep_mask).sum())
                if dropped:
                    matches_dropped_by_mask += dropped
                    keypoints0 = keypoints0[keep_mask]
                    keypoints1 = keypoints1[keep_mask]
                    confidence = confidence[keep_mask]

        indices0 = assign_global_keypoints(feature_store, edge['image0'], keypoints0, confidence)
        indices1 = assign_global_keypoints(feature_store, edge['image1'], keypoints1, confidence)
        global_matches = np.stack([indices0, indices1], axis=1).astype(np.uint32)

        payload['global_matches'] = global_matches
        np.savez_compressed(pair_path, **payload)

        edge['matchCount'] = int(confidence.shape[0])
        edge['meanConfidence'] = float(confidence.mean()) if confidence.size else 0.0
        match_entries.append({
            'pairId': edge['pairId'],
            'image0': edge['image0'],
            'image1': edge['image1'],
            'globalMatches': global_matches.tolist(),
            'windowSupport': int(edge.get('windowSupport', 1) or 1),
            'meanConfidence': float(edge.get('meanConfidence', 0.0) or 0.0),
            'variantSources': [str(value) for value in edge.get('variantSources', [])],
        })

    feature_store_path = output_dir / 'feature_store.json'
    matches_store_path = output_dir / 'matches_store.json'
    match_graph_path = output_dir / 'match_graph.json'
    track_store_path = output_dir / 'track_store.json'

    serialized_feature_store = {
        'images': [
            {
                'image': store['image'],
                'keypoints': store['keypoints'],
                'scores': store['scores'],
            }
            for store in feature_store.values()
        ]
    }
    initial_tracks = build_tracks_from_match_entries(feature_store, match_entries)
    consolidation_entries = []
    tracks = initial_tracks
    if backend == 'fast3r':
        tracks, consolidation_entries = consolidate_fast3r_multiview_tracks(feature_store, match_entries, initial_tracks)
    elif backend == 'roma_v2':
        tracks, consolidation_entries = consolidate_roma_multiview_tracks(feature_store, match_entries, initial_tracks)

    feature_store_path.write_text(json.dumps(serialized_feature_store, indent=2), encoding='utf-8')
    matches_store_path.write_text(json.dumps({'pairs': match_entries}, indent=2), encoding='utf-8')
    track_store_path.write_text(json.dumps({
        'tracks': tracks,
        'metadata': {
            'multiviewTrackConsolidationEnabled': bool(
                (backend == 'fast3r' and FAST3R_MULTIVIEW_TRACK_CONSOLIDATION_ENABLED)
                or (backend == 'roma_v2' and ROMA_MULTIVIEW_TRACK_CONSOLIDATION_ENABLED)
            ),
            'consolidationEntryCount': int(len(consolidation_entries)),
            'trackCountBeforeConsolidation': int(len(initial_tracks)),
            'trackCountAfterConsolidation': int(len(tracks)),
            'support4PlusBeforeConsolidation': int(sum(1 for track in initial_tracks if int(track.get('support', 0)) >= 4)),
            'support4PlusAfterConsolidation': int(sum(1 for track in tracks if int(track.get('support', 0)) >= 4)),
        },
    }, indent=2), encoding='utf-8')
    match_graph_path.write_text(json.dumps({
        'jobId': job_id,
        'createdAt': now_iso(),
        'dryRun': dry_run,
        'nodes': [image.name for image in images],
        'edges': edges,
        'failures': failures,
    }, indent=2), encoding='utf-8')

    devices_used = sorted({manifest['device'] for manifest in manifests})
    pair_selection_policy = next((manifest.get('pairSelectionPolicy') for manifest in manifests if manifest.get('pairSelectionPolicy')), None)
    fast3r_context_window_size = next((manifest.get('contextWindowSize') for manifest in manifests if manifest.get('contextWindowSize')), resolve_fast3r_context_window_size(len(images)))
    pair_count = (
        len(select_fast3r_pairs(images, fast3r_context_window_size))
        if backend == 'fast3r'
        else len(select_pairs(images)[0])
    )
    hybrid_stats = {
        'hlocAvailable': any(bool((manifest.get('hybridStats') or {}).get('hlocAvailable')) for manifest in manifests),
        'textureRouterEnabled': any(bool((manifest.get('hybridStats') or {}).get('textureRouterEnabled')) for manifest in manifests),
        'textureRouterPairCount': sum(int((manifest.get('hybridStats') or {}).get('textureRouterPairCount', 0)) for manifest in manifests),
        'hlocPrimaryPairCount': sum(int((manifest.get('hybridStats') or {}).get('hlocPrimaryPairCount', 0)) for manifest in manifests),
        'loftrRescuePairCount': sum(int((manifest.get('hybridStats') or {}).get('loftrRescuePairCount', 0)) for manifest in manifests),
        'hybridFailureCount': sum(int((manifest.get('hybridStats') or {}).get('hybridFailureCount', 0)) for manifest in manifests),
        'dryRunSimulatedPairCount': sum(int((manifest.get('hybridStats') or {}).get('dryRunSimulatedPairCount', 0)) for manifest in manifests),
    }
    canonical_preset = canonicalize_hloc_preset(preset) if backend == 'hloc_lightglue_loftr' else preset
    summary = {
        'jobId': job_id,
        'createdAt': now_iso(),
        'dryRun': dry_run,
        'backend': backend,
        'preset': canonical_preset,
        'device': devices_used[0] if len(devices_used) == 1 else 'multi_gpu',
        'devicesUsed': devices_used,
        'imageSize': image_size,
        'imageCount': len(images),
        'pairCount': pair_count,
        'processedPairCount': len(edges),
        'failedPairCount': len(failures),
        'matchesDroppedByReflectiveMask': int(matches_dropped_by_mask),
        'reflectiveMaskFilterApplied': bool(mask_filter is not None),
        'reflectiveMaskClasses': list(DEFAULT_MATCHING_REFLECTIVE_MASK_CLASSES),
        'reflectiveMaskMaxCoverage': float(DEFAULT_MATCHING_REFLECTIVE_MASK_MAX_COVERAGE),
        'pairSelectionPolicy': pair_selection_policy or ('all_pairs_within_fast3r_context_windows' if backend == 'fast3r' else 'adaptive_pair_selection_missing_policy'),
        'featureStorePath': str(feature_store_path),
        'matchesStorePath': str(matches_store_path),
        'trackStorePath': str(track_store_path),
        'matchGraphPath': str(match_graph_path),
        'shardCount': len(manifests),
        'trackCount': len(tracks),
        'trackCountBeforeConsolidation': len(initial_tracks),
        'trackCountAfterConsolidation': len(tracks),
        'support4PlusBeforeConsolidation': int(sum(1 for track in initial_tracks if int(track.get('support', 0)) >= 4)),
        'support4PlusAfterConsolidation': int(sum(1 for track in tracks if int(track.get('support', 0)) >= 4)),
        'consolidationEntryCount': len(consolidation_entries),
    }
    if canonical_preset != preset:
        summary['requestedPreset'] = preset

    if backend == 'fast3r':
        model_checkpoint = next((manifest.get('modelCheckpoint') for manifest in manifests if manifest.get('modelCheckpoint')), DEFAULT_FAST3R_MODEL_NAME)
        summary.update({
            'method': 'fast3r_multiview_context_matching',
            'implementation': 'fast3r',
            'modelCheckpoint': model_checkpoint,
            'pointmapFormat': 'npz_float32',
            'normalization': 'multiview_object_centric_pointmaps',
            'contextWindowSize': int(fast3r_context_window_size),
            'maxMatchesPerPair': int(DEFAULT_FAST3R_MAX_MATCHES),
            'maxMatchesPerPairCeiling': int(DEFAULT_FAST3R_MAX_MATCHES_CEILING),
            'adaptiveMatchCapStep': int(DEFAULT_FAST3R_MATCH_CAP_STEP),
            'adaptiveMatchCapWindowBonus': int(DEFAULT_FAST3R_MATCH_CAP_WINDOW_BONUS),
            'directMatchMinSupport': int(DEFAULT_FAST3R_MIN_DIRECT_MATCHES),
            'windowTrackMinSupport': int(DEFAULT_FAST3R_WINDOW_TRACK_MIN_SUPPORT),
            'windowTrackRescueMinMatches': int(DEFAULT_FAST3R_MIN_TRACK_RESCUE_MATCHES),
            'multiviewTrackConsolidationEnabled': bool(FAST3R_MULTIVIEW_TRACK_CONSOLIDATION_ENABLED),
            'multiviewTrackConsolidationPasses': int(FAST3R_TRACK_CONSOLIDATION_PASSES),
            'multiviewTrackConsolidationMergeRadius': float(FAST3R_TRACK_CONSOLIDATION_MERGE_RADIUS),
            'multiviewTrackConsolidationRejectRadius': float(FAST3R_TRACK_CONSOLIDATION_REJECT_RADIUS),
            'acceptancePolicy': 'direct_reciprocal_3d_plus_window_track_consensus_rescue',
        })
    elif backend == 'roma_v2':
        summary.update({
            'method': 'roma_v2_pairwise_matching',
            'implementation': 'roma_v2',
            'descriptorBackbone': resolve_roma_v2_descriptor_name(preset),
            'variant': resolve_roma_v2_variant_label(preset),
            'blankWallBias': 'dense_detector_free_semantic_matching',
            'romaSetting': DEFAULT_ROMA_V2_SETTING,
            'sampledMatchTarget': int(DEFAULT_ROMA_V2_SAMPLED_MATCHES),
            'maxMatchesPerPair': int(DEFAULT_ROMA_V2_MAX_MATCHES),
            'minMatchSupport': int(DEFAULT_ROMA_V2_MIN_MATCHES),
            'geometricVerifier': 'fundamental_matrix_usac_magsac',
            'geometricVerifierReprojectionThreshold': float(DEFAULT_ROMA_V2_RANSAC_REPROJECTION_THRESHOLD),
            'geometricVerifierConfidence': float(DEFAULT_ROMA_V2_RANSAC_CONFIDENCE),
            'geometricVerifierMaxIters': int(DEFAULT_ROMA_V2_RANSAC_MAX_ITERS),
            'weightTransferMode': 'official_checkpoint',
            'acceptancePolicy': 'balanced_dense_sampling_then_fundamental_matrix_verification',
        })
    elif backend == 'hloc_lightglue_loftr':
        summary.update(build_hloc_summary_fields(canonical_preset, hybrid_stats))
    else:
        summary.update({
            'method': 'loftr_indoor_pairwise_matching',
            'blankWallBias': 'detector_free_indoor_matching',
        })

    (output_dir / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    return summary


def run_sharded(
    *,
    args,
    images: list[Path],
    output_dir: Path,
    gpu_indices: list[str],
) -> dict:
    shard_dir = ensure_dir(output_dir / '.shards')
    processes = []

    for shard_index, gpu_index in enumerate(gpu_indices):
        manifest_path = shard_dir / f'shard_{shard_index:02d}.json'
        command = [
            sys.executable,
            str(Path(__file__).resolve()),
            '--job-id', args.job_id,
            '--images-dir', args.images_dir,
            '--output-dir', args.output_dir,
            '--preset', args.preset,
            '--image-size', str(args.image_size),
            '--gpu-indices', gpu_index,
            '--shard-index', str(shard_index),
            '--shard-count', str(len(gpu_indices)),
            '--manifest-path', str(manifest_path),
        ]
        if args.dry_run:
            command.append('--dry-run')
        processes.append({
            'gpuIndex': gpu_index,
            'manifestPath': manifest_path,
            'process': subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=str(Path(__file__).resolve().parents[3]),
                env=os.environ.copy(),
            ),
        })

    shard_logs = []
    manifests = []
    errors = []
    for shard in processes:
        stdout, stderr = shard['process'].communicate()
        shard_logs.append('\n'.join(filter(None, [stdout.strip(), stderr.strip()])))
        if shard['process'].returncode != 0:
            errors.append(
                f"gpu={shard['gpuIndex']} exit={shard['process'].returncode}\n{stdout.strip()}\n{stderr.strip()}".strip()
            )
            continue

        manifests.append(json.loads(Path(shard['manifestPath']).read_text(encoding='utf-8')))

    if errors:
        raise RuntimeError('learned_matching_sharded_failed\n' + '\n\n'.join(error for error in errors if error))

    if any(log for log in shard_logs):
        print('\n\n'.join(log for log in shard_logs if log), flush=True)

    return finalize_outputs(
        job_id=args.job_id,
        images=images,
        output_dir=output_dir,
        preset=args.preset,
        image_size=int(args.image_size),
        manifests=manifests,
        masks_dir=Path(args.masks_dir) if args.masks_dir else None,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description='Run master_v1 learned matching priors')
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--images-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--masks-dir', default='')
    parser.add_argument('--preset', default='disk_lightglue_loftr')
    parser.add_argument('--image-size', default='1024')
    parser.add_argument('--gpu-indices', default=os.environ.get('MASTER_PIPELINE_LEARNED_MATCHING_GPU_INDICES', ''))
    parser.add_argument('--shard-index', type=int, default=0)
    parser.add_argument('--shard-count', type=int, default=1)
    parser.add_argument('--manifest-path')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    images_dir = Path(args.images_dir)
    output_dir = ensure_dir(Path(args.output_dir))
    images = list_images(images_dir)
    if len(images) < 3:
        raise RuntimeError(f'Need at least 3 images for learned indoor matching, found {len(images)}')

    gpu_indices = parse_gpu_indices(args.gpu_indices)
    is_worker = bool(args.manifest_path)
    backend = resolve_backend(args.preset)

    effective_gpu_indices = gpu_indices
    if len(gpu_indices) > 1 and backend == 'hloc_lightglue_loftr' and not is_worker:
        print(
            'Disabling learned-matching sharding for the HLOC hybrid backend; shared feature stores are not shard-safe.',
            file=sys.stderr,
            flush=True,
        )
        effective_gpu_indices = gpu_indices[:1]

    if is_worker:
        manifest = run_worker(
            job_id=args.job_id,
            images_dir=images_dir,
            images=images,
            output_dir=output_dir,
            masks_dir=Path(args.masks_dir) if args.masks_dir else None,
            preset=args.preset,
            image_size=int(args.image_size),
            dry_run=args.dry_run,
            gpu_indices=effective_gpu_indices,
            shard_index=int(args.shard_index),
            shard_count=max(int(args.shard_count), 1),
        )
        Path(args.manifest_path).write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        print(json.dumps({
            'jobId': args.job_id,
            'backend': manifest['backend'],
            'device': manifest['device'],
            'processedPairCount': len(manifest['edges']),
            'failedPairCount': len(manifest['failures']),
            'shardIndex': manifest['shardIndex'],
            'shardCount': manifest['shardCount'],
        }), flush=True)
        return

    if len(effective_gpu_indices) > 1 and not args.dry_run:
        summary = run_sharded(args=args, images=images, output_dir=output_dir, gpu_indices=effective_gpu_indices)
    else:
        manifest = run_worker(
            job_id=args.job_id,
            images_dir=images_dir,
            images=images,
            output_dir=output_dir,
            masks_dir=Path(args.masks_dir) if args.masks_dir else None,
            preset=args.preset,
            image_size=int(args.image_size),
            dry_run=args.dry_run,
            gpu_indices=effective_gpu_indices,
            shard_index=0,
            shard_count=1,
        )
        summary = finalize_outputs(
            job_id=args.job_id,
            images=images,
            output_dir=output_dir,
            preset=args.preset,
            image_size=int(args.image_size),
            manifests=[manifest],
            masks_dir=Path(args.masks_dir) if args.masks_dir else None,
        )

    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
