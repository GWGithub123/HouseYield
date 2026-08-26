#!/usr/bin/env python3
"""master_v1 canonical mesh-first remote orchestrator.

This worker owns the remote process boundary from Stage 4 through Stage 13 for
the standalone Master VM. It keeps the local service focused on intake,
frame-QC, and calibration while the GPU worker executes the reconstruction and
export stages against the synced job directory.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

STAGES = [
    'ingest',
    'frame_qc',
    'camera_calibration',
    'semantic_masks',
    'learned_matching',
    'global_sfm',
    'metric3d_priors',
    'depth_priors',
    'dense_evidence',
    'gaussian_splatting',
    'plane_layout',
    'opening_detection',
    'mesh_authoring',
    'uv_initial_bake',
    'appearance_refinement',
    'export_qa',
]
REMOTE_STAGE_IDS = STAGES[3:]
SCRIPT_DIR = Path(__file__).resolve().parent
DEPTH_PRIOR_STAGE_IDS = {'depth_priors', 'metric3d_priors'}
DEFAULT_GAUSSIAN_VIEWER_PRESET = 'sparse_first'
GAUSSIAN_VIEWER_PRESET_CONFIGS = {
    'sparse_first': {
        'depthStageId': 'depth_priors',
        'depthOutputSubdir': 'depth_priors',
        'defaultLearnedMatchingPreset': None,
        'forceGaussianDepthPriors': False,
        'gaussianTrainingMaxAnisotropy': None,
        'gaussianPostprocessLargestComponentVoxel': None,
        'gaussianPostprocessReflectiveMaskedSupportRatio': None,
        'gaussianPostprocessReflectiveMaskedMinHits': None,
        'gaussianPostprocessReflectiveMaskedMinSupportViews': None,
        'gaussianPostprocessMaxAnisotropyRatio': None,
        'description': 'Sparse-first gaussian viewer path with optional post-SfM depth priors.',
    },
    'legacy_metric3d_masked_viewer': {
        'depthStageId': 'metric3d_priors',
        'depthOutputSubdir': 'metric3d',
        'defaultLearnedMatchingPreset': 'superpoint_lightglue_loftr',
        'forceGaussianDepthPriors': True,
        'gaussianTrainingMaxAnisotropy': 32.0,
        'gaussianPostprocessLargestComponentVoxel': 0.08,
        'gaussianPostprocessMaxAnisotropyRatio': 16.0,
        'description': 'Legacy Metric3D-seeded gaussian viewer path tuned for mirror-heavy room tours.',
    },
    'legacy_metric3d_masked_viewer_balanced_density': {
        'depthStageId': 'metric3d_priors',
        'depthOutputSubdir': 'metric3d',
        'defaultLearnedMatchingPreset': 'superpoint_lightglue_loftr',
        'forceGaussianDepthPriors': True,
        'gaussianTrainingMaxAnisotropy': 32.0,
        'gaussianPostprocessLargestComponentVoxel': 0.08,
        'gaussianPostprocessReflectiveMaskedSupportRatio': 0.6,
        'gaussianPostprocessReflectiveMaskedMinHits': 2,
        'gaussianPostprocessReflectiveMaskedMinSupportViews': 2,
        'gaussianPostprocessMaxAnisotropyRatio': 16.0,
        'description': 'Legacy Metric3D-seeded gaussian viewer path with reflective-mask cleanup to preserve mirror cuts while keeping higher density.',
    },
    'legacy_metric3d_masked_viewer_solid_surfaces': {
        'depthStageId': 'metric3d_priors',
        'depthOutputSubdir': 'metric3d',
        'defaultLearnedMatchingPreset': 'superpoint_lightglue_loftr',
        'forceGaussianDepthPriors': True,
        'gaussianTrainingMaxAnisotropy': 16.0,
        'gaussianPostprocessLargestComponentVoxel': 0.08,
        'gaussianPostprocessReflectiveMaskedSupportRatio': 0.6,
        'gaussianPostprocessReflectiveMaskedMinHits': 2,
        'gaussianPostprocessReflectiveMaskedMinSupportViews': 2,
        'gaussianPostprocessMaxAnisotropyRatio': 8.0,
        'gaussianPostprocessReflectiveBoundaryBandPx': 12,
        'gaussianPostprocessReflectiveBoundaryMinSupportViews': 2,
        'gaussianPostprocessReflectiveBoundaryMaxAnisotropyRatio': 16.0,
        'description': 'Legacy Metric3D-seeded gaussian viewer path that thickens interior surfaces while relaxing the anisotropy clamp near reflective boundaries to preserve mirror cuts.',
    },
    'legacy_metric3d_masked_viewer_solid_surfaces_sharp_mirror': {
        'depthStageId': 'metric3d_priors',
        'depthOutputSubdir': 'metric3d',
        'defaultLearnedMatchingPreset': 'superpoint_lightglue_loftr',
        'forceGaussianDepthPriors': True,
        'gaussianTrainingMaxAnisotropy': 32.0,
        'gaussianPostprocessLargestComponentVoxel': 0.08,
        'gaussianPostprocessReflectiveMaskedSupportRatio': 0.6,
        'gaussianPostprocessReflectiveMaskedMinHits': 2,
        'gaussianPostprocessReflectiveMaskedMinSupportViews': 2,
        'gaussianPostprocessMaxAnisotropyRatio': 10.0,
        'gaussianPostprocessReflectiveBoundaryBandPx': 6,
        'gaussianPostprocessReflectiveBoundaryMinSupportViews': 3,
        'gaussianPostprocessReflectiveBoundaryMaxAnisotropyRatio': 24.0,
        'description': 'Metric3D-seeded gaussian viewer path that keeps fuller interior surfaces than the legacy preset while restoring sharper mirror edges with a narrower, higher-confidence reflective boundary relaxation band.',
    },
    'legacy_metric3d_masked_viewer_disk': {
        'depthStageId': 'metric3d_priors',
        'depthOutputSubdir': 'metric3d',
        'defaultLearnedMatchingPreset': 'disk_lightglue_loftr',
        'forceGaussianDepthPriors': True,
        'gaussianTrainingMaxAnisotropy': 32.0,
        'gaussianPostprocessLargestComponentVoxel': 0.08,
        'gaussianPostprocessMaxAnisotropyRatio': 16.0,
        'description': 'Legacy Metric3D-seeded gaussian viewer path with DISK+LightGlue matching.',
    },
}
GAUSSIAN_VIEWER_PRESET_ALIASES = {
    'default': DEFAULT_GAUSSIAN_VIEWER_PRESET,
    'sparse_first_default': DEFAULT_GAUSSIAN_VIEWER_PRESET,
    'legacy_metric3d': 'legacy_metric3d_masked_viewer',
    'legacy_metric3d_masked': 'legacy_metric3d_masked_viewer',
    'legacy_metric3d_balanced': 'legacy_metric3d_masked_viewer_balanced_density',
    'legacy_metric3d_masked_balanced': 'legacy_metric3d_masked_viewer_balanced_density',
    'legacy_metric3d_solid': 'legacy_metric3d_masked_viewer_solid_surfaces',
    'legacy_metric3d_masked_solid': 'legacy_metric3d_masked_viewer_solid_surfaces',
    'legacy_metric3d_sharp_mirror': 'legacy_metric3d_masked_viewer_solid_surfaces_sharp_mirror',
    'legacy_metric3d_disk': 'legacy_metric3d_masked_viewer_disk',
}


def normalize_gaussian_viewer_preset(raw_value: str | None) -> str:
    normalized = str(raw_value or DEFAULT_GAUSSIAN_VIEWER_PRESET).strip().lower()
    normalized = GAUSSIAN_VIEWER_PRESET_ALIASES.get(normalized, normalized)
    if normalized not in GAUSSIAN_VIEWER_PRESET_CONFIGS:
        allowed = ', '.join(sorted(GAUSSIAN_VIEWER_PRESET_CONFIGS))
        raise ValueError(f'invalid_gaussian_viewer_preset:{normalized}; allowed={allowed}')
    return normalized


def resolve_gaussian_viewer_profile(raw_value: str | None) -> dict:
    normalized = normalize_gaussian_viewer_preset(raw_value)
    profile = dict(GAUSSIAN_VIEWER_PRESET_CONFIGS[normalized])
    profile['name'] = normalized
    return profile


def resolve_effective_learned_matching_preset(
    requested_preset: str,
    viewer_profile: dict,
    allow_explicit_override: bool = False,
) -> str:
    requested = str(requested_preset or '').strip()
    forced_preset = viewer_profile.get('defaultLearnedMatchingPreset')
    if allow_explicit_override and requested:
        return requested
    return str(forced_preset or requested)


def gaussian_viewer_uses_dense_priors(gaussian_use_depth_priors: bool, viewer_profile: dict) -> bool:
    return bool(viewer_profile.get('forceGaussianDepthPriors') or gaussian_use_depth_priors)


def resolve_active_depth_prior_stage(
    *,
    gaussian_only: bool,
    gaussian_use_depth_priors: bool,
    viewer_profile: dict,
) -> str | None:
    if gaussian_only and not gaussian_viewer_uses_dense_priors(gaussian_use_depth_priors, viewer_profile):
        return None
    return str(viewer_profile['depthStageId'])


def resolve_selected_depth_priors_dir(job_dir: Path, viewer_profile: dict) -> Path:
    return job_dir / 'priors' / str(viewer_profile['depthOutputSubdir'])


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def env_flag(name: str, default: bool = False) -> bool:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    return str(raw_value).strip().lower() in {'1', 'true', 'yes', 'on'}


def build_plan(
    job_dir: Path,
    *,
    gaussian_only: bool = False,
    metric3d_mesh_sidecar: bool = False,
    metric3d_mesh_only: bool = False,
    gaussian_use_depth_priors: bool = False,
    gaussian_viewer_preset: str = DEFAULT_GAUSSIAN_VIEWER_PRESET,
    active_depth_prior_stage: str | None = None,
    learned_matching_preset: str | None = None,
) -> dict:
    plan_stages = [
        stage_id
        for stage_id in STAGES
        if stage_id not in DEPTH_PRIOR_STAGE_IDS or stage_id == active_depth_prior_stage
    ]
    mesh_branch = [
        'dense_evidence',
        'plane_layout',
        'opening_detection',
        'mesh_authoring',
        'uv_initial_bake',
        'appearance_refinement',
        'export_qa',
    ] if (not gaussian_only or metric3d_mesh_sidecar or metric3d_mesh_only) else []
    if metric3d_mesh_only:
        note = (
            'Stage 1 through Stage 3 remain local to the master_v1 service. '
            'Stage 4 onward executes on the standalone Master VM. '
            'This run is mesh-primary-only: RoMA/GLOMAP poses, Metric3D-assisted COLMAP PatchMatch dense fusion, '
            'Poisson mesh, and OpenMVS texturing. '
            'Ref-Gaussian and gaussian splatting are skipped.'
        )
    elif gaussian_only and metric3d_mesh_sidecar:
        note = (
            'Stage 1 through Stage 3 remain local to the master_v1 service. '
            'Stage 4 onward executes on the standalone Master VM. '
            'This run keeps Ref-Gaussian/Gaussian as the primary branch while also running a '
            'Metric3D-fused Poisson/OpenMVS mesh sidecar after GLOMAP; COLMAP dense PatchMatch is skipped for that sidecar.'
        )
    elif gaussian_only and active_depth_prior_stage == 'metric3d_priors':
        note = (
            'Stage 1 through Stage 3 remain local to the master_v1 service. '
            'Stage 4 onward executes on the standalone Master VM. '
            'This run is gaussian-primary-only and stops after gaussian splatting to avoid mesh branch compute. '
            'The selected viewer preset uses legacy Metric3D dense priors for gaussian seeding; '
            'post-train component cleanup and anisotropy clamp are integrated into the gaussian publish step.'
        )
    elif gaussian_only and active_depth_prior_stage == 'depth_priors':
        note = (
            'Stage 1 through Stage 3 remain local to the master_v1 service. '
            'Stage 4 onward executes on the standalone Master VM. '
            'This run is gaussian-primary-only and stops after gaussian splatting to avoid mesh branch compute. '
            'Gaussian splatting seeds from sparse global SfM points plus post-SfM aligned depth priors.'
        )
    elif gaussian_only:
        note = (
            'Stage 1 through Stage 3 remain local to the master_v1 service. '
            'Stage 4 onward executes on the standalone Master VM. '
            'This run is gaussian-primary-only and stops after gaussian splatting to avoid mesh branch compute. '
            'Gaussian splatting seeds from sparse global SfM points unless depth priors are explicitly enabled.'
        )
    elif active_depth_prior_stage == 'metric3d_priors':
        note = (
            'Stage 1 through Stage 3 remain local to the master_v1 service. Stage 4 onward executes on the standalone Master VM. '
            'After global SfM, the canonical mesh branch continues while the gaussian viewer branch uses the legacy Metric3D dense-prior path.'
        )
    else:
        note = (
            'Stage 1 through Stage 3 remain local to the master_v1 service. Stage 4 onward executes on the standalone Master VM. '
            'After global SfM, the canonical mesh branch continues while gaussian splatting runs as an optional side branch for viewer artifacts.'
        )

    return {
        'createdAt': now_iso(),
        'jobDir': str(job_dir),
        'pipelineVersion': 'master-v1',
        'mode': (
            'mesh_first_metric3d_primary' if metric3d_mesh_only
            else ('gaussian_primary_only' if gaussian_only else 'mesh_first_canonical')
        ),
        'geometryAuthority': 'plane_aware_mesh',
        'appearanceRefinement': 'openmvs_uv_bake' if metric3d_mesh_only else 'splat_to_uv_sidecar',
        'gaussianBranch': (
            'disabled' if metric3d_mesh_only
            else ('required_room_tour_primary' if gaussian_only else 'post_glomap_viewer_sidecar')
        ),
        'gaussianViewerPreset': gaussian_viewer_preset,
        'metric3dMeshSidecar': bool(metric3d_mesh_sidecar),
        'metric3dMeshOnly': bool(metric3d_mesh_only),
        'activeDepthPriorStage': active_depth_prior_stage,
        'learnedMatchingPreset': learned_matching_preset,
        'localServiceStages': STAGES[:3],
        'remoteWorkerStages': plan_stages[3:],
        'stages': plan_stages,
        'branchGraph': {
            'post_global_sfm': {
                'depthPriorStage': active_depth_prior_stage,
                'meshBranch': mesh_branch,
                'gaussianBranch': [] if metric3d_mesh_only else ['gaussian_splatting'],
            },
        },
        'blankWallPolicy': {
            'geometry': 'infer walls from layout, intersections, and soft priors',
            'texture': 'prefer clean low-frequency bake over noisy sparse-detail hallucination',
        },
        'note': note,
    }


def write_json(file_path: Path, payload: dict) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def write_minimal_placeholder_glb(glb_path: Path) -> None:
    glb_path.parent.mkdir(parents=True, exist_ok=True)
    gltf_payload = {
        'asset': {
            'version': '2.0',
            'generator': 'master-v1-gaussian-only-placeholder',
        },
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{}],
    }
    json_chunk = json.dumps(gltf_payload, separators=(',', ':')).encode('utf-8')
    padding = (4 - (len(json_chunk) % 4)) % 4
    json_chunk += b' ' * padding
    total_length = 12 + 8 + len(json_chunk)

    with glb_path.open('wb') as handle:
        handle.write(struct.pack('<III', 0x46546C67, 2, total_length))
        handle.write(struct.pack('<II', len(json_chunk), 0x4E4F534A))
        handle.write(json_chunk)


def ensure_gaussian_only_compat_outputs(job_dir: Path, stage_summaries: dict[str, dict]) -> None:
    dense_evidence_dir = job_dir / 'dense_evidence'
    plane_layout_dir = job_dir / 'layout' / 'plane_layout'
    opening_detection_dir = job_dir / 'layout' / 'opening_detection'
    mesh_authoring_dir = job_dir / 'mesh' / 'authoring'
    uv_initial_bake_dir = job_dir / 'texture' / 'uv_initial_bake'
    appearance_dir = job_dir / 'appearance' / 'refinement'
    export_qa_dir = job_dir / 'export' / 'qa'

    placeholder_glb_path = export_qa_dir / 'model.optimized.glb'
    write_minimal_placeholder_glb(placeholder_glb_path)

    dense_summary = {
        'jobId': job_dir.name,
        'createdAt': now_iso(),
        'status': 'skipped_gaussian_only',
        'pointCount': 0,
        'note': 'Dense evidence branch skipped because gaussian-only execution was requested.',
    }
    write_json(dense_evidence_dir / 'summary.json', dense_summary)

    layout_payload = {
        'jobId': job_dir.name,
        'createdAt': now_iso(),
        'status': 'skipped_gaussian_only',
        'planes': [],
        'note': 'Plane layout skipped in gaussian-only execution.',
    }
    write_json(plane_layout_dir / 'summary.json', layout_payload)
    write_json(plane_layout_dir / 'layout.json', {
        'jobId': job_dir.name,
        'createdAt': now_iso(),
        'status': 'skipped_gaussian_only',
        'planes': [],
    })

    opening_summary = {
        'jobId': job_dir.name,
        'createdAt': now_iso(),
        'status': 'skipped_gaussian_only',
        'openings': [],
        'note': 'Opening detection skipped in gaussian-only execution.',
    }
    write_json(opening_detection_dir / 'summary.json', opening_summary)
    write_json(opening_detection_dir / 'candidates.json', {
        'jobId': job_dir.name,
        'createdAt': now_iso(),
        'status': 'skipped_gaussian_only',
        'candidates': [],
    })

    mesh_summary = {
        'jobId': job_dir.name,
        'createdAt': now_iso(),
        'status': 'skipped_gaussian_only',
        'detailMesh': False,
        'note': 'Mesh authoring skipped in gaussian-only execution.',
    }
    write_json(mesh_authoring_dir / 'summary.json', mesh_summary)

    uv_summary = {
        'jobId': job_dir.name,
        'createdAt': now_iso(),
        'status': 'skipped_gaussian_only',
        'texturedMeshPath': None,
        'texturePath': None,
        'note': 'UV bake skipped in gaussian-only execution.',
    }
    write_json(uv_initial_bake_dir / 'summary.json', uv_summary)

    appearance_summary = {
        'jobId': job_dir.name,
        'createdAt': now_iso(),
        'status': 'skipped_gaussian_only',
        'refinedMeshPath': None,
        'refinedTexturePath': None,
        'note': 'Appearance refinement skipped in gaussian-only execution.',
    }
    write_json(appearance_dir / 'summary.json', appearance_summary)

    qa_report_path = export_qa_dir / 'qa_report.json'
    qa_report_payload = {
        'jobId': job_dir.name,
        'createdAt': now_iso(),
        'sourceMeshStats': {
            'vertices': 0,
            'faces': 0,
            'isWatertight': False,
            'isWindingConsistent': True,
            'bounds': {
                'min': [0.0, 0.0, 0.0],
                'max': [0.0, 0.0, 0.0],
            },
        },
        'finalGlb': {
            'path': str(placeholder_glb_path),
            'bytes': int(placeholder_glb_path.stat().st_size),
        },
        'optimizedGlb': {
            'path': str(placeholder_glb_path),
            'bytes': int(placeholder_glb_path.stat().st_size),
            'mode': 'gaussian_only_placeholder',
        },
        'texturePath': None,
        'hasVertexColors': False,
        'note': 'Gaussian-only execution generated a placeholder GLB for backward-compatible mirroring.',
    }
    write_json(qa_report_path, qa_report_payload)

    export_summary = {
        'jobId': job_dir.name,
        'createdAt': now_iso(),
        'finalGlbPath': str(placeholder_glb_path),
        'optimizedGlbPath': str(placeholder_glb_path),
        'qaReportPath': str(qa_report_path),
        'optimizationMode': 'gaussian_only_placeholder',
        'gaussianOnly': True,
        'note': 'Dense/mesh/UV/export stages skipped; placeholder GLB emitted for compatibility.',
    }
    write_json(export_qa_dir / 'summary.json', export_summary)

    stage_summaries['dense_evidence'] = dense_summary
    stage_summaries['plane_layout'] = layout_payload
    stage_summaries['opening_detection'] = opening_summary
    stage_summaries['mesh_authoring'] = mesh_summary
    stage_summaries['uv_initial_bake'] = uv_summary
    stage_summaries['appearance_refinement'] = appearance_summary
    stage_summaries['export_qa'] = export_summary


def reset_dir(root: Path, subdirs: list[str] | None = None) -> None:
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=True)

    for subdir in subdirs or []:
        (root / subdir).mkdir(parents=True, exist_ok=True)


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


def pick_primary_active_stage(active_stages: list[str]) -> str | None:
    for stage_id in REMOTE_STAGE_IDS:
        if stage_id in active_stages:
            return stage_id
    return active_stages[0] if active_stages else None


def should_parallelize_priors(args: argparse.Namespace) -> bool:
    return False


def build_stage_defs(args: argparse.Namespace, job_dir: Path, viewer_profile: dict) -> list[dict]:
    frames_dir = job_dir / 'frames' / 'selected'
    calibration_dir = job_dir / 'calibration'
    semantic_masks_dir = job_dir / 'masks'
    learned_matching_dir = job_dir / 'priors' / 'learned_matching'
    sfm_dir = job_dir / 'sfm' / 'global_sfm'
    metric3d_priors_dir = job_dir / 'priors' / 'metric3d'
    depth_priors_dir = job_dir / 'priors' / 'depth_priors'
    selected_depth_priors_dir = resolve_selected_depth_priors_dir(job_dir, viewer_profile)
    if args.metric3d_mesh_sidecar or args.metric3d_mesh_only:
        selected_depth_priors_dir = metric3d_priors_dir
    dense_evidence_dir = job_dir / 'dense_evidence'
    gaussian_splatting_dir = job_dir / 'gaussian' / 'splatting'
    plane_layout_dir = job_dir / 'layout' / 'plane_layout'
    opening_detection_dir = job_dir / 'layout' / 'opening_detection'
    mesh_authoring_dir = job_dir / 'mesh' / 'authoring'
    uv_initial_bake_dir = job_dir / 'texture' / 'uv_initial_bake'
    appearance_dir = job_dir / 'appearance' / 'refinement'
    export_qa_dir = job_dir / 'export' / 'qa'
    logs_dir = job_dir / 'logs'
    job_id = job_dir.name
    effective_learned_matching_preset = resolve_effective_learned_matching_preset(
        args.learned_matching_preset,
        viewer_profile,
        allow_explicit_override=args.allow_explicit_learned_matching_override,
    )
    gaussian_depth_priors_args = []
    if gaussian_viewer_uses_dense_priors(args.gaussian_use_depth_priors, viewer_profile):
        gaussian_depth_priors_args = ['--depth-priors-dir', str(selected_depth_priors_dir)]
    gaussian_cleanup_args = []
    gaussian_init_args = []
    gaussian_mirror_args = []
    if args.gaussian_max_init_points:
        gaussian_init_args.extend([
            '--max-init-points',
            str(args.gaussian_max_init_points),
        ])
    if args.gaussian_depth_priors_max_points_per_image:
        gaussian_init_args.extend([
            '--depth-priors-max-points-per-image',
            str(args.gaussian_depth_priors_max_points_per_image),
        ])
    if viewer_profile.get('gaussianTrainingMaxAnisotropy'):
        gaussian_cleanup_args.extend([
            '--training-max-anisotropy',
            str(viewer_profile['gaussianTrainingMaxAnisotropy']),
        ])
    if viewer_profile.get('gaussianPostprocessLargestComponentVoxel'):
        gaussian_cleanup_args.extend([
            '--postprocess-largest-component-voxel',
            str(viewer_profile['gaussianPostprocessLargestComponentVoxel']),
        ])
    if viewer_profile.get('gaussianPostprocessReflectiveMaskedSupportRatio'):
        gaussian_cleanup_args.extend([
            '--postprocess-reflective-masked-support-ratio',
            str(viewer_profile['gaussianPostprocessReflectiveMaskedSupportRatio']),
        ])
    if viewer_profile.get('gaussianPostprocessReflectiveMaskedMinHits'):
        gaussian_cleanup_args.extend([
            '--postprocess-reflective-masked-min-hits',
            str(viewer_profile['gaussianPostprocessReflectiveMaskedMinHits']),
        ])
    if viewer_profile.get('gaussianPostprocessReflectiveMaskedMinSupportViews'):
        gaussian_cleanup_args.extend([
            '--postprocess-reflective-masked-min-support-views',
            str(viewer_profile['gaussianPostprocessReflectiveMaskedMinSupportViews']),
        ])
    if viewer_profile.get('gaussianPostprocessMaxAnisotropyRatio'):
        gaussian_cleanup_args.extend([
            '--postprocess-max-anisotropy-ratio',
            str(viewer_profile['gaussianPostprocessMaxAnisotropyRatio']),
        ])
    if viewer_profile.get('gaussianPostprocessReflectiveBoundaryBandPx'):
        gaussian_cleanup_args.extend([
            '--postprocess-reflective-boundary-band-px',
            str(viewer_profile['gaussianPostprocessReflectiveBoundaryBandPx']),
        ])
    if viewer_profile.get('gaussianPostprocessReflectiveBoundaryMinSupportViews'):
        gaussian_cleanup_args.extend([
            '--postprocess-reflective-boundary-min-support-views',
            str(viewer_profile['gaussianPostprocessReflectiveBoundaryMinSupportViews']),
        ])
    if viewer_profile.get('gaussianPostprocessReflectiveBoundaryMaxAnisotropyRatio'):
        gaussian_cleanup_args.extend([
            '--postprocess-reflective-boundary-max-anisotropy-ratio',
            str(viewer_profile['gaussianPostprocessReflectiveBoundaryMaxAnisotropyRatio']),
        ])
    if args.mirror_gaussian_command:
        gaussian_mirror_args.extend([
            '--mirror-gaussian-command',
            args.mirror_gaussian_command,
        ])
    if args.require_mirror_gaussian:
        gaussian_mirror_args.append('--mirror-gaussian-required')
    if args.ref_gaussian_command:
        gaussian_mirror_args.extend([
            '--ref-gaussian-command',
            args.ref_gaussian_command,
        ])
    if args.require_ref_gaussian:
        gaussian_mirror_args.append('--ref-gaussian-required')
    if args.ref_gaussian_only:
        gaussian_mirror_args.append('--ref-gaussian-only')
    if args.scaffold_gs_command:
        gaussian_mirror_args.extend([
            '--scaffold-gs-command',
            args.scaffold_gs_command,
        ])
    if args.require_scaffold_gs:
        gaussian_mirror_args.append('--scaffold-gs-required')
    if args.scaffold_gs_only:
        gaussian_mirror_args.append('--scaffold-gs-only')

    return [
        {
            'id': 'semantic_masks',
            'prepare_root': semantic_masks_dir,
            'prepare_subdirs': ['mirror', 'window', 'glass'],
            'log_path': logs_dir / 'semantic_masks.log',
            'summary_path': semantic_masks_dir / 'summary.json',
            'command': [
                sys.executable,
                str(SCRIPT_DIR / 'run_semantic_masks.py'),
                '--job-id', job_id,
                '--images-dir', str(frames_dir),
                '--output-dir', str(semantic_masks_dir),
                *( ['--dry-run'] if args.semantic_masks_dry_run else [] ),
            ],
        },
        {
            'id': 'learned_matching',
            'prepare_root': learned_matching_dir,
            'prepare_subdirs': ['pairs', 'previews'],
            'log_path': logs_dir / 'learned_matching.log',
            'summary_path': learned_matching_dir / 'summary.json',
            'command': [
                sys.executable,
                str(SCRIPT_DIR / 'run_loftr_indoor_matching.py'),
                '--job-id', job_id,
                '--images-dir', str(frames_dir),
                '--output-dir', str(learned_matching_dir),
                '--masks-dir', str(semantic_masks_dir),
                '--preset', effective_learned_matching_preset,
                '--image-size', args.learned_matching_image_size,
                *( ['--gpu-indices', args.learned_matching_gpu_indices] if args.learned_matching_gpu_indices else [] ),
                *( ['--dry-run'] if args.learned_matching_dry_run else [] ),
            ],
        },
        {
            'id': 'global_sfm',
            'prepare_root': sfm_dir,
            'prepare_subdirs': ['sparse', 'text-model'],
            'log_path': logs_dir / 'global_sfm.log',
            'summary_path': sfm_dir / 'summary.json',
            'command': [
                sys.executable,
                str(SCRIPT_DIR / 'run_global_sfm.py'),
                '--job-id', job_id,
                '--images-dir', str(frames_dir),
                '--output-dir', str(sfm_dir),
                '--learned-match-graph-path', str(learned_matching_dir / 'match_graph.json'),
                '--learned-feature-store-path', str(learned_matching_dir / 'feature_store.json'),
                '--learned-matches-store-path', str(learned_matching_dir / 'matches_store.json'),
                *( ['--dry-run'] if args.global_sfm_dry_run else [] ),
            ],
        },
        {
            'id': 'metric3d_priors',
            'prepare_root': metric3d_priors_dir,
            'prepare_subdirs': ['depth', 'normals', 'confidence', 'previews'],
            'log_path': logs_dir / 'metric3d_priors.log',
            'summary_path': metric3d_priors_dir / 'summary.json',
            'command': [
                sys.executable,
                str(SCRIPT_DIR / 'run_metric3d_priors.py'),
                '--job-id', job_id,
                '--images-dir', str(frames_dir),
                '--calibration-dir', str(calibration_dir),
                '--output-dir', str(metric3d_priors_dir),
                '--masks-dir', str(semantic_masks_dir),
                '--model-size', args.depth_prior_model_size,
                *( ['--gpu-indices', args.depth_prior_gpu_indices] if args.depth_prior_gpu_indices else [] ),
                *( ['--dry-run'] if args.depth_priors_dry_run else [] ),
            ],
        },
        {
            'id': 'depth_priors',
            'prepare_root': depth_priors_dir,
            'prepare_subdirs': ['depth', 'normals', 'confidence', 'previews'],
            'log_path': logs_dir / 'depth_priors.log',
            'summary_path': depth_priors_dir / 'summary.json',
            'command': [
                sys.executable,
                str(SCRIPT_DIR / 'run_depth_priors.py'),
                '--job-id', job_id,
                '--images-dir', str(frames_dir),
                '--sfm-text-model-dir', str(sfm_dir / 'text-model'),
                '--output-dir', str(depth_priors_dir),
                '--masks-dir', str(semantic_masks_dir),
                '--model-size', args.depth_prior_model_size,
                *( ['--gpu-indices', args.depth_prior_gpu_indices] if args.depth_prior_gpu_indices else [] ),
                *( ['--dry-run'] if args.depth_priors_dry_run else [] ),
            ],
        },
        {
            'id': 'dense_evidence',
            'prepare_root': dense_evidence_dir,
            'prepare_subdirs': [],
            'log_path': logs_dir / 'dense_evidence.log',
            'summary_path': dense_evidence_dir / 'summary.json',
            'command': [
                sys.executable,
                str(SCRIPT_DIR / 'run_dense_evidence.py'),
                '--job-id', job_id,
                '--images-dir', str(frames_dir),
                '--sfm-text-model-dir', str(sfm_dir / 'text-model'),
                '--depth-priors-dir', str(selected_depth_priors_dir),
                '--learned-matching-dir', str(learned_matching_dir),
                '--masks-dir', str(semantic_masks_dir),
                '--output-dir', str(dense_evidence_dir),
                *( ['--patch-match-gpu-indices', args.dense_stereo_gpu_indices] if args.dense_stereo_gpu_indices else [] ),
                *( ['--skip-patch-match-stereo'] if args.metric3d_mesh_sidecar else [] ),
                *( ['--mesh-primary-fusion'] if args.metric3d_mesh_only else [] ),
                *( ['--dry-run'] if args.dense_evidence_dry_run else [] ),
            ],
        },
        {
            'id': 'gaussian_splatting',
            'prepare_root': gaussian_splatting_dir,
            'prepare_subdirs': ['native-output', 'workspace'],
            'log_path': logs_dir / 'gaussian_splatting.log',
            'summary_path': gaussian_splatting_dir / 'summary.json',
            'command': [
                sys.executable,
                str(SCRIPT_DIR / 'run_gaussian_splatting.py'),
                '--job-id', job_id,
                '--images-dir', str(frames_dir),
                '--sfm-text-model-dir', str(sfm_dir / 'text-model'),
                *gaussian_depth_priors_args,
                '--masks-dir', str(semantic_masks_dir),
                '--output-dir', str(gaussian_splatting_dir),
                '--gsplat-iterations', str(args.gsplat_iterations),
                *gaussian_init_args,
                *gaussian_cleanup_args,
                *gaussian_mirror_args,
                *( ['--dry-run'] if args.gaussian_splatting_dry_run else [] ),
            ],
        },
        {
            'id': 'plane_layout',
            'prepare_root': plane_layout_dir,
            'prepare_subdirs': [],
            'log_path': logs_dir / 'plane_layout.log',
            'summary_path': plane_layout_dir / 'summary.json',
            'command': [
                sys.executable,
                str(SCRIPT_DIR / 'run_plane_layout.py'),
                '--job-id', job_id,
                '--dense-evidence-dir', str(dense_evidence_dir),
                '--output-dir', str(plane_layout_dir),
                *( ['--dry-run'] if args.plane_layout_dry_run else [] ),
            ],
        },
        {
            'id': 'opening_detection',
            'prepare_root': opening_detection_dir,
            'prepare_subdirs': ['debug'],
            'log_path': logs_dir / 'opening_detection.log',
            'summary_path': opening_detection_dir / 'summary.json',
            'command': [
                sys.executable,
                str(SCRIPT_DIR / 'run_opening_detection.py'),
                '--job-id', job_id,
                '--dense-evidence-dir', str(dense_evidence_dir),
                '--layout-path', str(plane_layout_dir / 'layout.json'),
                '--output-dir', str(opening_detection_dir),
                *( ['--dry-run'] if args.opening_detection_dry_run else [] ),
            ],
        },
        {
            'id': 'mesh_authoring',
            'prepare_root': mesh_authoring_dir,
            'prepare_subdirs': [],
            'log_path': logs_dir / 'mesh_authoring.log',
            'summary_path': mesh_authoring_dir / 'summary.json',
            'command': [
                sys.executable,
                str(SCRIPT_DIR / 'run_mesh_authoring.py'),
                '--job-id', job_id,
                '--layout-path', str(plane_layout_dir / 'layout.json'),
                '--openings-path', str(opening_detection_dir / 'candidates.json'),
                '--dense-evidence-dir', str(dense_evidence_dir),
                '--output-dir', str(mesh_authoring_dir),
                *( ['--dry-run'] if args.mesh_authoring_dry_run else [] ),
            ],
        },
        {
            'id': 'uv_initial_bake',
            'prepare_root': uv_initial_bake_dir,
            'prepare_subdirs': [],
            'log_path': logs_dir / 'uv_initial_bake.log',
            'summary_path': uv_initial_bake_dir / 'summary.json',
            'command': [
                sys.executable,
                str(SCRIPT_DIR / 'run_uv_initial_bake.py'),
                '--job-id', job_id,
                '--images-dir', str(frames_dir),
                '--sfm-sparse-model-dir', str(sfm_dir / 'sparse'),
                '--shell-mesh-path', str(mesh_authoring_dir / 'shell_mesh.obj'),
                '--output-dir', str(uv_initial_bake_dir),
                *( ['--dry-run'] if args.uv_initial_bake_dry_run else [] ),
            ],
        },
        {
            'id': 'appearance_refinement',
            'prepare_root': appearance_dir,
            'prepare_subdirs': [],
            'log_path': logs_dir / 'appearance_refinement.log',
            'summary_path': appearance_dir / 'summary.json',
            'command': [
                sys.executable,
                str(SCRIPT_DIR / 'run_appearance_refinement.py'),
                '--job-id', job_id,
                '--images-dir', str(frames_dir),
                '--sfm-text-model-dir', str(sfm_dir / 'text-model'),
                '--uv-bake-dir', str(uv_initial_bake_dir),
                '--mesh-authoring-dir', str(mesh_authoring_dir),
                '--output-dir', str(appearance_dir),
                *( ['--dry-run'] if args.appearance_refinement_dry_run else [] ),
            ],
        },
        {
            'id': 'export_qa',
            'prepare_root': export_qa_dir,
            'prepare_subdirs': [],
            'log_path': logs_dir / 'export_qa.log',
            'summary_path': export_qa_dir / 'summary.json',
            'command': [
                sys.executable,
                str(SCRIPT_DIR / 'run_export_qa.py'),
                '--job-id', job_id,
                '--appearance-dir', str(appearance_dir),
                '--output-dir', str(export_qa_dir),
            ],
        },
    ]


def read_summary(summary_path: Path) -> dict:
    if not summary_path.exists():
        raise FileNotFoundError(f'master_remote_summary_missing:{summary_path}')
    return json.loads(summary_path.read_text(encoding='utf-8'))


def run_stage(stage: dict) -> dict:
    reset_dir(stage['prepare_root'], stage['prepare_subdirs'])
    stage['log_path'].parent.mkdir(parents=True, exist_ok=True)

    completed = subprocess.run(
        stage['command'],
        capture_output=True,
        text=True,
        cwd=str(SCRIPT_DIR.parent.parent.parent),
        env=None,
    )

    log_text = '\n\n'.join(filter(None, [completed.stdout.strip(), completed.stderr.strip()]))
    stage['log_path'].write_text(log_text, encoding='utf-8')

    if completed.returncode != 0:
        raise RuntimeError(log_text or f"{stage['id']} failed with exit code {completed.returncode}")

    return read_summary(stage['summary_path'])


def launch_stage(stage: dict) -> dict:
    reset_dir(stage['prepare_root'], stage['prepare_subdirs'])
    stage['log_path'].parent.mkdir(parents=True, exist_ok=True)
    log_handle = stage['log_path'].open('w', encoding='utf-8')
    try:
        process = subprocess.Popen(
            stage['command'],
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=str(SCRIPT_DIR.parent.parent.parent),
            env=None,
        )
    except Exception:
        log_handle.close()
        raise
    return {'process': process, 'log_handle': log_handle}


def finish_stage_process(stage: dict, process: subprocess.Popen, log_handle=None) -> dict:
    stdout, stderr = process.communicate()
    if log_handle is not None:
        log_handle.close()

    captured_parts = [
        part.strip()
        for part in (stdout, stderr)
        if isinstance(part, str) and part.strip()
    ]
    if captured_parts:
        log_text = '\n\n'.join(captured_parts)
        stage['log_path'].write_text(log_text, encoding='utf-8')
    elif stage['log_path'].exists():
        log_text = stage['log_path'].read_text(encoding='utf-8', errors='replace')
    else:
        log_text = ''

    if process.returncode != 0:
        raise RuntimeError(log_text or f"{stage['id']} failed with exit code {process.returncode}")

    return read_summary(stage['summary_path'])


def abort_stage_process(stage: dict, process: subprocess.Popen, reason: str, log_handle=None) -> None:
    if process.poll() is None:
        process.kill()
    stdout, stderr = process.communicate()
    if log_handle is not None:
        log_handle.close()

    captured_parts = [
        part.strip()
        for part in (stdout, stderr)
        if isinstance(part, str) and part.strip()
    ]
    if stage['log_path'].exists():
        captured_parts.insert(0, stage['log_path'].read_text(encoding='utf-8', errors='replace').strip())
    captured_parts.append(reason)
    log_text = '\n\n'.join(filter(None, captured_parts))
    stage['log_path'].write_text(log_text, encoding='utf-8')


def build_status_payload(
    *,
    job_dir: Path,
    current_stage: str | None,
    active_stages: list[str],
    completed_stages: list[str],
    stage_summaries: dict[str, dict],
    done: bool,
    success: bool | None = None,
    failed_stage: str | None = None,
    error: str | None = None,
) -> dict:
    return {
        'jobDir': str(job_dir),
        'updatedAt': now_iso(),
        'done': done,
        'success': success,
        'currentStage': current_stage,
        'activeStages': active_stages,
        'completedStages': completed_stages,
        'failedStage': failed_stage,
        'error': error,
        'stageSummaries': stage_summaries,
    }


def write_status(
    *,
    status_path: Path,
    job_dir: Path,
    active_stages: list[str],
    completed_stages: list[str],
    stage_summaries: dict[str, dict],
    done: bool,
    success: bool | None = None,
    failed_stage: str | None = None,
    error: str | None = None,
) -> None:
    write_json(
        status_path,
        build_status_payload(
            job_dir=job_dir,
            current_stage=pick_primary_active_stage(active_stages),
            active_stages=active_stages,
            completed_stages=completed_stages,
            stage_summaries=stage_summaries,
            done=done,
            success=success,
            failed_stage=failed_stage,
            error=error,
        ),
    )


def run_parallel_group(stages: list[dict], status_path: Path, job_dir: Path, completed_stages: list[str], stage_summaries: dict[str, dict]) -> None:
    running = {
        stage['id']: {'stage': stage, **launch_stage(stage)}
        for stage in stages
    }

    active_stages = [stage['id'] for stage in stages]
    write_status(
        status_path=status_path,
        job_dir=job_dir,
        active_stages=active_stages,
        completed_stages=completed_stages,
        stage_summaries=stage_summaries,
        done=False,
    )

    while running:
        completed_any = False
        for stage_id in list(running.keys()):
            stage_entry = running[stage_id]
            process = stage_entry['process']
            if process.poll() is None:
                continue

            completed_any = True
            try:
                summary = finish_stage_process(
                    stage_entry['stage'],
                    process,
                    stage_entry.get('log_handle'),
                )
            except Exception as exc:
                for other_stage_id, other_entry in running.items():
                    if other_stage_id == stage_id:
                        continue
                    abort_stage_process(
                        other_entry['stage'],
                        other_entry['process'],
                        f'aborted_after_parallel_stage_failure:{stage_id}',
                        other_entry.get('log_handle'),
                    )
                setattr(exc, 'failed_stage_id', stage_id)
                raise

            completed_stages.append(stage_id)
            stage_summaries[stage_id] = summary
            del running[stage_id]
            active_stages = [stage_name for stage_name in [stage['id'] for stage in stages] if stage_name in running]
            write_status(
                status_path=status_path,
                job_dir=job_dir,
                active_stages=active_stages,
                completed_stages=completed_stages,
                stage_summaries=stage_summaries,
                done=False,
            )

        if not completed_any:
            time.sleep(1)


def main() -> None:
    parser = argparse.ArgumentParser(description='master_v1 remote orchestrator')
    parser.add_argument('--job-dir', required=True)
    parser.add_argument('--output-path')
    parser.add_argument('--status-path')
    parser.add_argument('--result-path')
    parser.add_argument('--depth-prior-model-size', '--metric3d-model-size', dest='depth_prior_model_size', default='large')
    parser.add_argument(
        '--gaussian-viewer-preset',
        default=os.environ.get('MASTER_PIPELINE_GAUSSIAN_VIEWER_PRESET', DEFAULT_GAUSSIAN_VIEWER_PRESET),
    )
    parser.add_argument('--learned-matching-preset', default='disk_lightglue_loftr')
    parser.add_argument('--allow-explicit-learned-matching-override', action='store_true')
    parser.add_argument('--learned-matching-image-size', default='1024')
    parser.add_argument('--gaussian-only', action='store_true', default=env_flag('MASTER_PIPELINE_REQUIRE_GAUSSIAN_SPLATTING', False))
    parser.add_argument(
        '--gaussian-use-depth-priors',
        action='store_true',
        default=env_flag('MASTER_PIPELINE_GAUSSIAN_USE_DEPTH_PRIORS', False),
    )
    parser.add_argument(
        '--depth-prior-gpu-indices',
        '--metric3d-gpu-indices',
        dest='depth_prior_gpu_indices',
        default=os.environ.get('MASTER_PIPELINE_DEPTH_PRIORS_GPU_INDICES', os.environ.get('MASTER_PIPELINE_METRIC3D_GPU_INDICES', '')),
    )
    parser.add_argument('--learned-matching-gpu-indices', default=os.environ.get('MASTER_PIPELINE_LEARNED_MATCHING_GPU_INDICES', ''))
    parser.add_argument('--dense-stereo-gpu-indices', default=os.environ.get('MASTER_PIPELINE_DENSE_STEREO_GPU_INDICES', ''))
    parser.add_argument('--gsplat-iterations', type=int, default=max(20000, int(os.environ.get('MASTER_PIPELINE_GSPLAT_ITERATIONS', '20000'))))
    parser.add_argument('--gaussian-max-init-points', type=int, default=0)
    parser.add_argument('--gaussian-depth-priors-max-points-per-image', type=int, default=0)
    parser.add_argument('--mirror-gaussian-command', default=os.environ.get('MASTER_PIPELINE_MIRROR_GAUSSIAN_COMMAND', ''))
    parser.add_argument('--require-mirror-gaussian', action='store_true', default=env_flag('MASTER_PIPELINE_REQUIRE_MIRROR_GAUSSIAN', False))
    parser.add_argument('--ref-gaussian-command', default=os.environ.get('MASTER_PIPELINE_REF_GAUSSIAN_COMMAND', ''))
    parser.add_argument('--require-ref-gaussian', action='store_true', default=env_flag('MASTER_PIPELINE_REQUIRE_REF_GAUSSIAN', False))
    parser.add_argument('--ref-gaussian-only', action='store_true')
    parser.add_argument('--scaffold-gs-command', default=os.environ.get('MASTER_PIPELINE_SCAFFOLD_GS_COMMAND', ''))
    parser.add_argument('--require-scaffold-gs', action='store_true', default=env_flag('MASTER_PIPELINE_REQUIRE_SCAFFOLD_GS', False))
    parser.add_argument('--scaffold-gs-only', action='store_true')
    parser.add_argument('--metric3d-mesh-sidecar', action='store_true', default=env_flag('MASTER_PIPELINE_METRIC3D_MESH_SIDECAR', False))
    parser.add_argument('--metric3d-mesh-only', action='store_true', default=env_flag('MASTER_PIPELINE_METRIC3D_MESH_ONLY', False))
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--semantic-masks-dry-run', action='store_true')
    parser.add_argument('--depth-priors-dry-run', '--metric3d-dry-run', dest='depth_priors_dry_run', action='store_true')
    parser.add_argument('--learned-matching-dry-run', action='store_true')
    parser.add_argument('--global-sfm-dry-run', action='store_true')
    parser.add_argument('--dense-evidence-dry-run', action='store_true')
    parser.add_argument('--gaussian-splatting-dry-run', action='store_true')
    parser.add_argument('--plane-layout-dry-run', action='store_true')
    parser.add_argument('--opening-detection-dry-run', action='store_true')
    parser.add_argument('--mesh-authoring-dry-run', action='store_true')
    parser.add_argument('--uv-initial-bake-dry-run', action='store_true')
    parser.add_argument('--appearance-refinement-dry-run', action='store_true')
    args = parser.parse_args()
    args.gaussian_viewer_preset = normalize_gaussian_viewer_preset(args.gaussian_viewer_preset)
    viewer_profile = resolve_gaussian_viewer_profile(args.gaussian_viewer_preset)
    effective_learned_matching_preset = resolve_effective_learned_matching_preset(
        args.learned_matching_preset,
        viewer_profile,
        allow_explicit_override=args.allow_explicit_learned_matching_override,
    )
    active_depth_prior_stage = resolve_active_depth_prior_stage(
        gaussian_only=args.gaussian_only,
        gaussian_use_depth_priors=args.gaussian_use_depth_priors,
        viewer_profile=viewer_profile,
    )
    ref_depth_mode = os.environ.get('MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIORS_MODE', 'light').strip().lower()
    if args.ref_gaussian_only and ref_depth_mode == 'disabled':
        active_depth_prior_stage = None
    if args.metric3d_mesh_sidecar or args.metric3d_mesh_only:
        active_depth_prior_stage = 'metric3d_priors'
    if args.metric3d_mesh_only and args.gaussian_only:
        raise ValueError('metric3d_mesh_only_incompatible_with_gaussian_only')
    if args.ref_gaussian_only and args.scaffold_gs_only:
        raise ValueError('ref_gaussian_only_incompatible_with_scaffold_gs_only')

    job_dir = Path(args.job_dir)
    output_path = Path(args.output_path) if args.output_path else job_dir / 'outputs' / 'master-dry-run.json'
    status_path = Path(args.status_path) if args.status_path else job_dir / 'outputs' / 'master_pipeline_remote_status.json'
    result_path = Path(args.result_path) if args.result_path else job_dir / 'outputs' / 'master_pipeline_remote_result.json'
    payload = build_plan(
        job_dir,
        gaussian_only=args.gaussian_only,
        metric3d_mesh_sidecar=args.metric3d_mesh_sidecar,
        metric3d_mesh_only=args.metric3d_mesh_only,
        gaussian_use_depth_priors=args.gaussian_use_depth_priors,
        gaussian_viewer_preset=viewer_profile['name'],
        active_depth_prior_stage=active_depth_prior_stage,
        learned_matching_preset=effective_learned_matching_preset,
    )

    write_json(output_path, payload)

    if args.dry_run:
        print(json.dumps(payload), flush=True)
        return

    stage_defs = build_stage_defs(args, job_dir, viewer_profile)
    completed_stages: list[str] = []
    stage_summaries: dict[str, dict] = {}
    current_stage: str | None = None

    write_status(
        status_path=status_path,
        job_dir=job_dir,
        active_stages=[],
        completed_stages=completed_stages,
        stage_summaries=stage_summaries,
        done=False,
    )

    try:
        stage_defs_by_id = {stage['id']: stage for stage in stage_defs}
        active_depth_stage = stage_defs_by_id.get(active_depth_prior_stage) if active_depth_prior_stage else None

        semantic_masks_stage = stage_defs_by_id.get('semantic_masks')
        if semantic_masks_stage is not None:
            current_stage = 'semantic_masks'
            write_status(
                status_path=status_path,
                job_dir=job_dir,
                active_stages=[current_stage],
                completed_stages=completed_stages,
                stage_summaries=stage_summaries,
                done=False,
            )
            summary = run_stage(semantic_masks_stage)
            completed_stages.append(current_stage)
            stage_summaries[current_stage] = summary
            write_status(
                status_path=status_path,
                job_dir=job_dir,
                active_stages=[current_stage],
                completed_stages=completed_stages,
                stage_summaries=stage_summaries,
                done=False,
            )

        prior_ids = ['learned_matching']
        if should_parallelize_priors(args):
            prior_stages = [stage_defs_by_id[prior_id] for prior_id in prior_ids]
            current_stage = pick_primary_active_stage([stage['id'] for stage in prior_stages])
            run_parallel_group(prior_stages, status_path, job_dir, completed_stages, stage_summaries)
        else:
            for prior_id in prior_ids:
                stage = stage_defs_by_id[prior_id]
                current_stage = stage['id']
                write_status(
                    status_path=status_path,
                    job_dir=job_dir,
                    active_stages=[current_stage],
                    completed_stages=completed_stages,
                    stage_summaries=stage_summaries,
                    done=False,
                )

                summary = run_stage(stage)
                completed_stages.append(current_stage)
                stage_summaries[current_stage] = summary

                write_status(
                    status_path=status_path,
                    job_dir=job_dir,
                    active_stages=[current_stage],
                    completed_stages=completed_stages,
                    stage_summaries=stage_summaries,
                    done=False,
                )

        if args.metric3d_mesh_only:
            if active_depth_stage is None:
                raise RuntimeError('mesh_only_requires_metric3d_priors')
            stage_order = [
                stage_defs_by_id['global_sfm'],
                active_depth_stage,
                stage_defs_by_id['dense_evidence'],
                stage_defs_by_id['plane_layout'],
                stage_defs_by_id['opening_detection'],
                stage_defs_by_id['mesh_authoring'],
                stage_defs_by_id['uv_initial_bake'],
                stage_defs_by_id['appearance_refinement'],
                stage_defs_by_id['export_qa'],
            ]
        elif args.gaussian_only:
            stage_order = [stage_defs_by_id['global_sfm']]
            if active_depth_stage is not None:
                stage_order.append(active_depth_stage)
            stage_order.append(stage_defs_by_id['gaussian_splatting'])
            if args.metric3d_mesh_sidecar:
                stage_order.extend([
                    stage_defs_by_id['dense_evidence'],
                    stage_defs_by_id['plane_layout'],
                    stage_defs_by_id['opening_detection'],
                    stage_defs_by_id['mesh_authoring'],
                    stage_defs_by_id['uv_initial_bake'],
                    stage_defs_by_id['appearance_refinement'],
                    stage_defs_by_id['export_qa'],
                ])
        else:
            if active_depth_stage is None:
                raise RuntimeError('mesh_first_requires_active_depth_prior_stage')
            stage_order = [
                stage_defs_by_id['global_sfm'],
                active_depth_stage,
                [stage_defs_by_id['dense_evidence'], stage_defs_by_id['gaussian_splatting']],
                stage_defs_by_id['plane_layout'],
                stage_defs_by_id['opening_detection'],
                stage_defs_by_id['mesh_authoring'],
                stage_defs_by_id['uv_initial_bake'],
                stage_defs_by_id['appearance_refinement'],
                stage_defs_by_id['export_qa'],
            ]

        for stage_entry in stage_order:
            if isinstance(stage_entry, list):
                current_stage = pick_primary_active_stage([stage['id'] for stage in stage_entry])
                run_parallel_group(stage_entry, status_path, job_dir, completed_stages, stage_summaries)
                continue

            stage = stage_entry
            current_stage = stage['id']
            write_status(
                status_path=status_path,
                job_dir=job_dir,
                active_stages=[current_stage],
                completed_stages=completed_stages,
                stage_summaries=stage_summaries,
                done=False,
            )

            summary = run_stage(stage)
            completed_stages.append(current_stage)
            stage_summaries[current_stage] = summary

            write_status(
                status_path=status_path,
                job_dir=job_dir,
                active_stages=[current_stage],
                completed_stages=completed_stages,
                stage_summaries=stage_summaries,
                done=False,
            )

        if args.gaussian_only and not args.metric3d_mesh_sidecar:
            ensure_gaussian_only_compat_outputs(job_dir, stage_summaries)

        result_payload = {
            'success': True,
            'jobDir': str(job_dir),
            'completedAt': now_iso(),
            'gaussianOnly': bool(args.gaussian_only),
            'metric3dMeshSidecar': bool(args.metric3d_mesh_sidecar),
            'metric3dMeshOnly': bool(args.metric3d_mesh_only),
            'gaussianViewerPreset': viewer_profile['name'],
            'learnedMatchingPreset': effective_learned_matching_preset,
            'activeDepthPriorStage': active_depth_prior_stage,
            'completedStages': completed_stages,
            'stageSummaries': stage_summaries,
            'finalSummaryPath': None if (args.gaussian_only and not args.metric3d_mesh_sidecar and not args.metric3d_mesh_only) else str(job_dir / 'export' / 'qa' / 'summary.json'),
            'gaussianSummaryPath': None if args.metric3d_mesh_only else str(job_dir / 'gaussian' / 'splatting' / 'summary.json'),
        }
        write_json(result_path, result_payload)
        write_status(
            status_path=status_path,
            job_dir=job_dir,
            active_stages=[],
            completed_stages=completed_stages,
            stage_summaries=stage_summaries,
            done=True,
            success=True,
        )
    except Exception as exc:  # pragma: no cover - CLI failure path
        failed_stage = getattr(exc, 'failed_stage_id', current_stage)
        result_payload = {
            'success': False,
            'jobDir': str(job_dir),
            'failedAt': now_iso(),
            'failedStage': failed_stage,
            'gaussianViewerPreset': viewer_profile['name'],
            'learnedMatchingPreset': effective_learned_matching_preset,
            'activeDepthPriorStage': active_depth_prior_stage,
            'completedStages': completed_stages,
            'stageSummaries': stage_summaries,
            'error': str(exc),
        }
        write_json(result_path, result_payload)
        write_status(
            status_path=status_path,
            job_dir=job_dir,
            active_stages=[failed_stage] if failed_stage else [],
            completed_stages=completed_stages,
            stage_summaries=stage_summaries,
            done=True,
            success=False,
            failed_stage=failed_stage,
            error=str(exc),
        )
        raise SystemExit(str(exc)) from exc


if __name__ == '__main__':
    main()