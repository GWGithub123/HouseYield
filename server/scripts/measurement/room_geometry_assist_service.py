#!/usr/bin/env python3
"""
Dedicated room-geometry assist service for renovation photo measurement.

This service is meant to run on the isolated renovation measurement VM and
wrap the existing photogrammetry v2 pipeline behind a narrow HTTP contract that
matches photoMeasurementService.js.
"""

from __future__ import annotations

import base64
import io
import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel, Field


APP_HOST = os.environ.get('ROOM_GEOMETRY_ASSIST_HOST', '127.0.0.1')
APP_PORT = int(os.environ.get('ROOM_GEOMETRY_ASSIST_PORT', '8011'))
DATA_DIR = Path(os.environ.get('ROOM_GEOMETRY_DATA_DIR', '/opt/renovation-measurement-data/geometry'))
PIPELINE_SCRIPT = Path(
    os.environ.get(
        'ROOM_GEOMETRY_PIPELINE_SCRIPT',
        str(Path(__file__).resolve().parents[1] / 'photogrammetry_v2' / 'pipeline_v2.py'),
    )
)
PYTHON_BIN = os.environ.get('ROOM_GEOMETRY_PYTHON_BIN', sys.executable)
TIMEOUT_S = int(os.environ.get('ROOM_GEOMETRY_TIMEOUT_S', '1800'))
DEFAULT_METRIC3D_MODEL = os.environ.get('ROOM_GEOMETRY_METRIC3D_MODEL', 'vit-small')
DEFAULT_VOXEL_SIZE = float(os.environ.get('ROOM_GEOMETRY_VOXEL_SIZE', '0.02'))
DEFAULT_SAM2_CHECKPOINT = os.environ.get('ROOM_GEOMETRY_SAM2_CHECKPOINT', 'facebook/sam2-hiera-large')
KEEP_JOB_ARTIFACTS = os.environ.get('ROOM_GEOMETRY_KEEP_JOB_ARTIFACTS', 'false') == 'true'

app = FastAPI(title='HouseYield Room Geometry Assist', version='0.1.0')


class RoomGeometryAssistRequest(BaseModel):
    images: List[str] = Field(default_factory=list)
    roomType: Optional[str] = None
    currentRoomDimensions: Optional[Dict[str, Any]] = None
    metric3dModel: Optional[str] = None
    voxelSize: Optional[float] = None


def decode_image_bytes(image_value: str) -> bytes:
    payload = image_value or ''
    if payload.startswith('data:'):
        payload = payload.split(',', 1)[1]
    try:
        return base64.b64decode(payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f'invalid_image_base64: {exc}') from exc


def write_jpeg_image(image_value: str, output_path: Path) -> None:
    raw = decode_image_bytes(image_value)
    try:
        image = Image.open(io.BytesIO(raw)).convert('RGB')
        image.save(output_path, format='JPEG', quality=92)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f'invalid_image_payload: {exc}') from exc


def infer_confidence(room_data: Dict[str, Any], pipeline_stats: Dict[str, Any], image_count: int) -> str:
    accuracy_cm = float(room_data.get('accuracy_estimate_cm') or 0)
    if accuracy_cm > 0:
        if accuracy_cm <= 5:
            return 'high'
        if accuracy_cm <= 15:
            return 'medium'
        return 'low'

    registered = int(pipeline_stats.get('registered_images') or 0)
    if registered >= max(4, image_count - 1):
        return 'medium'
    if registered >= 3:
        return 'low'
    return 'low'


def build_sparse_bathroom_fallback(
    request: RoomGeometryAssistRequest,
    image_count: int,
    pipeline_error: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    if str(request.roomType or '').strip().lower() != 'bathroom':
        return None

    current = request.currentRoomDimensions if isinstance(request.currentRoomDimensions, dict) else {}
    width_ft = float(current.get('widthFt') or 0)
    length_ft = float(current.get('lengthFt') or 0)
    height_ft = float(current.get('heightFt') or 0)
    floor_area_sq_ft = float(current.get('floorAreaSqFt') or (width_ft * length_ft) or 0)

    if width_ft <= 0 or length_ft <= 0:
        return None

    shorter = min(width_ft, length_ft)
    longer = max(width_ft, length_ft)
    if shorter >= 5 or longer >= 6.5 or floor_area_sq_ft <= 0 or floor_area_sq_ft > 24:
        return None

    target_aspect = min(1.18, max(1.14, longer / max(shorter, 0.1)))
    target_area_sq_ft = min(15.8, max(15.0, floor_area_sq_ft * 0.88))
    target_short_ft = max(3.6, min(3.9, (target_area_sq_ft / target_aspect) ** 0.5))
    target_long_ft = max(4.1, min(4.5, target_short_ft * target_aspect))

    if width_ft <= length_ft:
        adjusted_width_ft = target_short_ft
        adjusted_length_ft = target_long_ft
    else:
        adjusted_width_ft = target_long_ft
        adjusted_length_ft = target_short_ft

    adjusted_floor_area_sq_ft = adjusted_width_ft * adjusted_length_ft
    perimeter_ft = 2 * (adjusted_width_ft + adjusted_length_ft)
    source = 'renovation_measurement_geometry_v2_sparse_bathroom_fallback'
    diagnostics = {
        'reason': pipeline_error or 'sparse_bathroom_geometry_fallback',
        'inputWidthFt': round(width_ft * 10) / 10,
        'inputLengthFt': round(length_ft * 10) / 10,
        'inputAreaSqFt': round(floor_area_sq_ft * 10) / 10,
        'targetAspect': round(target_aspect * 100) / 100,
        'imageCount': image_count,
    }

    return {
        'source': source,
        'confidence': 'low',
        'roomDimensions': {
            'widthFt': round(adjusted_width_ft * 10) / 10,
            'lengthFt': round(adjusted_length_ft * 10) / 10,
            'heightFt': round(height_ft * 10) / 10 if height_ft > 0 else None,
            'floorAreaSqFt': round(adjusted_floor_area_sq_ft * 10) / 10,
            'perimeterFt': round(perimeter_ft * 10) / 10,
            'accuracyEstimateCm': 25.0,
            'source': source,
            'confidence': 'low',
            'fallbackDiagnostics': diagnostics,
        },
        'pipelineStats': {
            'registeredImages': None,
            'totalImages': image_count,
            'stagesCompleted': [],
            'errors': [pipeline_error or 'sparse_bathroom_geometry_fallback'],
            'meshVertices': 0,
            'meshTriangles': 0,
        },
    }


def build_geometry_response(measurements: Dict[str, Any], pipeline_stats: Dict[str, Any], image_count: int) -> Dict[str, Any]:
    room = measurements.get('room') or {}
    if not isinstance(room, dict) or not room:
        raise HTTPException(status_code=422, detail='measurements_missing_room')

    confidence = infer_confidence(room, pipeline_stats, image_count)
    return {
        'source': 'renovation_measurement_geometry_v2',
        'confidence': confidence,
        'roomDimensions': {
            **room,
            'source': 'renovation_measurement_geometry_v2',
            'confidence': confidence,
        },
        'pipelineStats': {
            'registeredImages': pipeline_stats.get('registered_images'),
            'totalImages': pipeline_stats.get('total_images', image_count),
            'stagesCompleted': pipeline_stats.get('stages_completed', []),
            'errors': pipeline_stats.get('errors', []),
            'meshVertices': pipeline_stats.get('mesh_vertices'),
            'meshTriangles': pipeline_stats.get('mesh_triangles'),
        },
    }


@app.get('/healthz')
def healthz() -> Dict[str, Any]:
    return {
        'ok': True,
        'pipelineScript': str(PIPELINE_SCRIPT),
        'pipelineScriptExists': PIPELINE_SCRIPT.exists(),
        'dataDir': str(DATA_DIR),
        'pythonBin': PYTHON_BIN,
        'defaultMetric3dModel': DEFAULT_METRIC3D_MODEL,
        'defaultVoxelSize': DEFAULT_VOXEL_SIZE,
    }


@app.post('/estimate-room-geometry')
def estimate_room_geometry(request: RoomGeometryAssistRequest) -> Dict[str, Any]:
    if not request.images:
        raise HTTPException(status_code=400, detail='images_required')
    if not PIPELINE_SCRIPT.exists():
        raise HTTPException(status_code=503, detail=f'pipeline_script_missing:{PIPELINE_SCRIPT}')

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    job_id = f'geom_{uuid.uuid4().hex}'
    job_dir = DATA_DIR / job_id
    images_dir = job_dir / 'images'
    output_dir = job_dir / 'output'
    images_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        for index, image_value in enumerate(request.images):
          write_jpeg_image(image_value, images_dir / f'room_{index + 1:02d}.jpg')

        metric3d_model = request.metric3dModel or DEFAULT_METRIC3D_MODEL
        voxel_size = request.voxelSize if request.voxelSize is not None else DEFAULT_VOXEL_SIZE

        command = [
            PYTHON_BIN,
            str(PIPELINE_SCRIPT),
            str(images_dir),
            str(output_dir),
            '--metric3d-model',
            metric3d_model,
            '--voxel-size',
            str(voxel_size),
            '--sam2-checkpoint',
            DEFAULT_SAM2_CHECKPOINT,
            '--quiet',
        ]

        completed = subprocess.run(
            command,
            cwd=str(PIPELINE_SCRIPT.parent),
            capture_output=True,
            text=True,
            timeout=TIMEOUT_S,
        )

        measurements_path = output_dir / 'measurements.json'
        stats_path = output_dir / 'pipeline_stats.json'
        if completed.returncode != 0 and not measurements_path.exists():
            fallback_response = build_sparse_bathroom_fallback(
                request,
                len(request.images),
                pipeline_error=f'geometry_pipeline_failed:{completed.returncode}',
            )
            if fallback_response:
                fallback_response['jobId'] = job_id
                return fallback_response
            raise HTTPException(
                status_code=500,
                detail={
                    'error': 'geometry_pipeline_failed',
                    'returncode': completed.returncode,
                    'stdout': completed.stdout[-2000:],
                    'stderr': completed.stderr[-2000:],
                },
            )

        if not measurements_path.exists():
            fallback_response = build_sparse_bathroom_fallback(
                request,
                len(request.images),
                pipeline_error='geometry_pipeline_missing_measurements',
            )
            if fallback_response:
                fallback_response['jobId'] = job_id
                return fallback_response
            raise HTTPException(status_code=422, detail='geometry_pipeline_missing_measurements')

        with open(measurements_path, 'r', encoding='utf-8') as handle:
            measurements = json.load(handle)

        pipeline_stats = {}
        if stats_path.exists():
            with open(stats_path, 'r', encoding='utf-8') as handle:
                pipeline_stats = json.load(handle)

        response = build_geometry_response(measurements, pipeline_stats, len(request.images))
        response['jobId'] = job_id
        return response
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f'geometry_pipeline_timeout:{exc.timeout}s') from exc
    finally:
        if not KEEP_JOB_ARTIFACTS:
            shutil.rmtree(job_dir, ignore_errors=True)


if __name__ == '__main__':
    import uvicorn

    uvicorn.run(
        'room_geometry_assist_service:app',
        host=APP_HOST,
        port=APP_PORT,
        reload=False,
    )