#!/usr/bin/env python3
"""
Specialist vision service for measurement-target detection and refinement.

This service is intended to run on the GCP GPU VM behind the new
MEASUREMENT_TARGET_DETECTOR_URL / MEASUREMENT_TARGET_SEGMENTATION_URL hooks in
photoMeasurementService.js.

Environment:
- SPECIALIST_DETECTOR_BACKEND: auto, yolo, grounding_dino, or none (default auto)
- SPECIALIST_YOLO_WEIGHTS: path to fine-tuned detector weights
- SPECIALIST_GROUNDING_DINO_MODEL: Hugging Face model id/path for Grounding DINO
- SPECIALIST_SAM2_CHECKPOINT: SAM2 checkpoint name or path
- SPECIALIST_HOST: bind host (default 0.0.0.0)
- SPECIALIST_PORT: bind port (default 8010)
- SPECIALIST_YOLO_CONFIDENCE: detection confidence threshold (default 0.15)
- SPECIALIST_GROUNDING_DINO_BOX_THRESHOLD: detection threshold (default 0.22)
- SPECIALIST_GROUNDING_DINO_TEXT_THRESHOLD: text grounding threshold (default 0.15)
- SPECIALIST_SAM2_MASK_THRESHOLD: segmentation mask threshold (default 0.0)
"""

from __future__ import annotations

import base64
import io
import inspect
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from PIL import Image

try:
    import torch
except Exception:
    torch = None

YOLO = None
YOLO_IMPORT_ATTEMPTED = False

try:
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor
except Exception:
    AutoModelForZeroShotObjectDetection = None
    AutoProcessor = None

try:
    from sam2.sam2_image_predictor import SAM2ImagePredictor
except Exception:
    SAM2ImagePredictor = None

try:
    from sam2.build_sam import build_sam2
except Exception:
    build_sam2 = None

DEVICE = 'cuda' if torch is not None and torch.cuda.is_available() else 'cpu'
DETECTOR_BACKEND_REQUESTED = (os.environ.get('SPECIALIST_DETECTOR_BACKEND', 'auto').strip().lower() or 'auto')
DETECTOR_WEIGHTS = os.environ.get('SPECIALIST_YOLO_WEIGHTS', '').strip()
GROUNDING_DINO_MODEL = os.environ.get('SPECIALIST_GROUNDING_DINO_MODEL', 'IDEA-Research/grounding-dino-tiny').strip()
SAM2_CHECKPOINT = os.environ.get('SPECIALIST_SAM2_CHECKPOINT', '').strip()
SAM2_CONFIG = os.environ.get('SPECIALIST_SAM2_CONFIG', '').strip()
YOLO_CONFIDENCE = float(os.environ.get('SPECIALIST_YOLO_CONFIDENCE', '0.15'))
GROUNDING_DINO_BOX_THRESHOLD = float(os.environ.get('SPECIALIST_GROUNDING_DINO_BOX_THRESHOLD', '0.22'))
GROUNDING_DINO_TEXT_THRESHOLD = float(os.environ.get('SPECIALIST_GROUNDING_DINO_TEXT_THRESHOLD', '0.15'))
SAM2_MASK_THRESHOLD = float(os.environ.get('SPECIALIST_SAM2_MASK_THRESHOLD', '0.0'))
GROUNDING_DINO_LOAD_ERROR: Optional[str] = None
DETECTOR_LOAD_ERROR: Optional[str] = None
SEGMENTER_LOAD_ERROR: Optional[str] = None
VALID_DETECTOR_BACKENDS = {'auto', 'yolo', 'grounding_dino', 'none'}
DETECTOR_BACKEND = DETECTOR_BACKEND_REQUESTED if DETECTOR_BACKEND_REQUESTED in VALID_DETECTOR_BACKENDS else 'auto'

TARGET_LABEL_PATTERNS: Dict[str, List[str]] = {
    'existing_vanity': ['vanity', 'sink cabinet', 'bathroom cabinet', 'cabinet'],
    'vanity_space': ['vanity', 'sink cabinet', 'bathroom cabinet', 'cabinet'],
    'existing_toilet': ['toilet', 'commode'],
    'bathroom_mirror': ['mirror', 'medicine cabinet', 'mirrored cabinet'],
    'shower_door_opening': ['shower', 'bathtub', 'tub', 'entry', 'opening'],
    'existing_bathtub': ['bathtub', 'tub'],
    'door': ['door'],
    'window': ['window'],
}

TARGET_TEXT_PROMPTS: Dict[str, List[str]] = {
    'existing_vanity': ['bathroom vanity', 'sink cabinet', 'vanity cabinet'],
    'vanity_space': ['bathroom vanity', 'sink cabinet', 'vanity opening'],
    'existing_toilet': ['toilet', 'bathroom toilet'],
    'bathroom_mirror': ['bathroom mirror', 'wall mirror', 'medicine cabinet'],
    'shower_door_opening': ['shower door opening', 'shower entry', 'bathtub opening'],
    'existing_bathtub': ['bathtub', 'bath tub'],
    'door': ['door', 'door opening'],
    'window': ['window'],
}

app = FastAPI(title='HouseYield Specialist Vision Service', version='0.1.0')


class BoundingBox(BaseModel):
    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)
    width: float = Field(..., gt=0.0, le=1.0)
    height: float = Field(..., gt=0.0, le=1.0)


class DetectTargetRequest(BaseModel):
    image: str
    targetType: str
    roughBox: Optional[BoundingBox] = None
    classes: List[str] = Field(default_factory=list)


class SegmentTargetRequest(BaseModel):
    image: str
    targetType: str
    roughBox: BoundingBox


class OpenVocabSegmentRequest(BaseModel):
    image: str
    prompt: str = ''
    classes: List[str] = Field(default_factory=list)
    boxThreshold: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    textThreshold: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    returnMasks: bool = True


def decode_image(image_value: str) -> np.ndarray:
    payload = image_value or ''
    if payload.startswith('data:'):
        payload = payload.split(',', 1)[1]
    try:
        raw = base64.b64decode(payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f'invalid_image_base64: {exc}') from exc

    try:
        image = Image.open(io.BytesIO(raw)).convert('RGB')
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f'invalid_image_payload: {exc}') from exc
    return np.array(image)


def bbox_to_xyxy(box: BoundingBox, width: int, height: int) -> np.ndarray:
    x1 = max(0.0, min(width - 1.0, box.x * width))
    y1 = max(0.0, min(height - 1.0, box.y * height))
    x2 = max(x1 + 1.0, min(width, (box.x + box.width) * width))
    y2 = max(y1 + 1.0, min(height, (box.y + box.height) * height))
    return np.array([x1, y1, x2, y2], dtype=np.float32)


def xyxy_to_bbox(x1: float, y1: float, x2: float, y2: float, width: int, height: int) -> Dict[str, float]:
    return {
        'x': max(0.0, min(1.0, x1 / max(1, width))),
        'y': max(0.0, min(1.0, y1 / max(1, height))),
        'width': max(1.0 / max(1, width), min(1.0, (x2 - x1) / max(1, width))),
        'height': max(1.0 / max(1, height), min(1.0, (y2 - y1) / max(1, height))),
    }


def label_matches_target(target_type: str, label: str) -> bool:
    normalized_label = (label or '').lower()
    if not normalized_label:
        return True
    patterns = TARGET_LABEL_PATTERNS.get(target_type, [])
    if not patterns:
        return True
    return any(pattern in normalized_label for pattern in patterns)


def normalize_phrase(value: str) -> str:
    return str(value or '').strip().lower().replace('_', ' ')


def label_matches_requested_classes(label: str, requested_classes: Optional[List[str]] = None) -> bool:
    normalized_label = normalize_phrase(label)
    normalized_classes = [normalize_phrase(value) for value in requested_classes or [] if normalize_phrase(value)]
    if not normalized_classes:
        return True
    return any(class_name in normalized_label or normalized_label in class_name for class_name in normalized_classes)


def canonicalize_requested_class(label: str, requested_classes: Optional[List[str]] = None) -> str:
    normalized_label = normalize_phrase(label)
    for class_name in requested_classes or []:
        normalized_class = normalize_phrase(class_name)
        if normalized_class and (normalized_class in normalized_label or normalized_label in normalized_class):
            return normalized_class
    if normalized_label:
        return normalized_label
    fallback_classes = [normalize_phrase(value) for value in requested_classes or [] if normalize_phrase(value)]
    return fallback_classes[0] if fallback_classes else 'object'


def open_vocab_prompt(prompt: str, requested_classes: Optional[List[str]] = None) -> str:
    normalized_prompt = str(prompt or '').strip()
    if normalized_prompt:
        return normalized_prompt if normalized_prompt.endswith('.') else f'{normalized_prompt}.'

    phrases = [normalize_phrase(value) for value in requested_classes or [] if normalize_phrase(value)]
    if not phrases:
        phrases = ['mirror', 'window', 'glass door', 'glass wall']
    return '. '.join(phrases) + '.'


def yolo_backend_available() -> bool:
    if not DETECTOR_WEIGHTS:
        return False
    if Path(DETECTOR_WEIGHTS).is_absolute() and not Path(DETECTOR_WEIGHTS).exists():
        return False
    return get_yolo_class() is not None


def get_yolo_class() -> Optional[Any]:
    global YOLO, YOLO_IMPORT_ATTEMPTED
    if YOLO_IMPORT_ATTEMPTED:
        return YOLO

    YOLO_IMPORT_ATTEMPTED = True
    try:
        from ultralytics import YOLO as YOLOClass
    except Exception:
        YOLO = None
        return None

    YOLO = YOLOClass
    return YOLO


def grounding_dino_backend_available() -> bool:
    return bool(
        torch is not None
        and AutoProcessor is not None
        and AutoModelForZeroShotObjectDetection is not None
        and GROUNDING_DINO_MODEL
    )


def resolve_detector_backend() -> str:
    if DETECTOR_BACKEND == 'none':
        return 'none'
    if DETECTOR_BACKEND == 'yolo':
        return 'yolo' if yolo_backend_available() else 'none'
    if DETECTOR_BACKEND == 'grounding_dino':
        return 'grounding_dino' if grounding_dino_backend_available() else 'none'
    if yolo_backend_available():
        return 'yolo'
    if grounding_dino_backend_available():
        return 'grounding_dino'
    return 'none'


def detector_unavailable_error() -> str:
    if DETECTOR_BACKEND == 'none':
        return 'detector_disabled'
    if DETECTOR_BACKEND == 'yolo':
        if get_yolo_class() is None:
            return 'yolo_backend_unavailable'
        if not DETECTOR_WEIGHTS:
            return 'missing_detector_weights'
        if Path(DETECTOR_WEIGHTS).is_absolute() and not Path(DETECTOR_WEIGHTS).exists():
            return f'missing_detector_weights:{DETECTOR_WEIGHTS}'
        return 'yolo_backend_unavailable'
    if DETECTOR_BACKEND == 'grounding_dino':
        if torch is None:
            return 'torch_unavailable'
        if AutoProcessor is None or AutoModelForZeroShotObjectDetection is None:
            return 'grounding_dino_transformers_unavailable'
        if not GROUNDING_DINO_MODEL:
            return 'missing_grounding_dino_model'
        return 'grounding_dino_backend_unavailable'
    if DETECTOR_WEIGHTS and Path(DETECTOR_WEIGHTS).is_absolute() and not Path(DETECTOR_WEIGHTS).exists():
        return f'missing_detector_weights:{DETECTOR_WEIGHTS}'
    if grounding_dino_backend_available():
        return 'grounding_dino_backend_not_loaded'
    return 'no_detector_backend_available'


def grounding_dino_prompt(target_type: str, requested_classes: Optional[List[str]] = None) -> str:
    phrases: List[str] = []
    for raw_value in requested_classes or []:
        normalized_value = str(raw_value or '').strip().lower().replace('_', ' ')
        if normalized_value and normalized_value not in phrases:
            phrases.append(normalized_value)

    for raw_value in TARGET_TEXT_PROMPTS.get(target_type, []):
        normalized_value = str(raw_value or '').strip().lower()
        if normalized_value and normalized_value not in phrases:
            phrases.append(normalized_value)

    if not phrases:
        phrases.append(str(target_type or 'fixture').strip().lower().replace('_', ' '))
    return '. '.join(phrases) + '.'


@lru_cache(maxsize=1)
def get_grounding_dino_bundle() -> Optional[Dict[str, Any]]:
    global GROUNDING_DINO_LOAD_ERROR

    if torch is None:
        GROUNDING_DINO_LOAD_ERROR = 'torch_unavailable'
        return None
    if AutoProcessor is None or AutoModelForZeroShotObjectDetection is None:
        GROUNDING_DINO_LOAD_ERROR = 'grounding_dino_transformers_unavailable'
        return None
    if not GROUNDING_DINO_MODEL:
        GROUNDING_DINO_LOAD_ERROR = 'missing_grounding_dino_model'
        return None

    try:
        processor = AutoProcessor.from_pretrained(GROUNDING_DINO_MODEL)
        model = AutoModelForZeroShotObjectDetection.from_pretrained(GROUNDING_DINO_MODEL)
        model.to(DEVICE)
        model.eval()
    except Exception as exc:
        GROUNDING_DINO_LOAD_ERROR = f'grounding_dino_load_failed:{exc}'
        return None

    GROUNDING_DINO_LOAD_ERROR = None
    return {
        'backend': 'grounding_dino',
        'processor': processor,
        'model': model,
    }


@lru_cache(maxsize=1)
def get_detector() -> Optional[Any]:
    global DETECTOR_LOAD_ERROR
    backend = resolve_detector_backend()
    if backend == 'none':
        DETECTOR_LOAD_ERROR = detector_unavailable_error()
        return None

    if backend == 'yolo':
        try:
            yolo_class = get_yolo_class()
            if yolo_class is None:
                DETECTOR_LOAD_ERROR = 'yolo_backend_unavailable'
                return None
            model = yolo_class(DETECTOR_WEIGHTS)
        except Exception as exc:
            DETECTOR_LOAD_ERROR = f'detector_load_failed:{exc}'
            return None
        DETECTOR_LOAD_ERROR = None
        return {
            'backend': 'yolo',
            'model': model,
            'modelId': DETECTOR_WEIGHTS,
        }

    detector_bundle = get_grounding_dino_bundle()
    DETECTOR_LOAD_ERROR = GROUNDING_DINO_LOAD_ERROR
    if detector_bundle is None:
        return None
    return {
        'backend': 'grounding_dino',
        'model': detector_bundle['model'],
        'processor': detector_bundle['processor'],
        'modelId': GROUNDING_DINO_MODEL,
    }


@lru_cache(maxsize=1)
def get_segmenter() -> Optional[Any]:
    global SEGMENTER_LOAD_ERROR
    if SAM2ImagePredictor is None:
        SEGMENTER_LOAD_ERROR = 'sam2_predictor_unavailable'
        return None
    if not SAM2_CHECKPOINT:
        SEGMENTER_LOAD_ERROR = 'missing_sam2_checkpoint'
        return None
    try:
        checkpoint_path = Path(SAM2_CHECKPOINT)
        if SAM2_CONFIG and checkpoint_path.exists():
            if build_sam2 is None:
                SEGMENTER_LOAD_ERROR = 'sam2_builder_unavailable'
                return None
            model = build_sam2(SAM2_CONFIG, str(checkpoint_path), device=DEVICE)
            predictor = SAM2ImagePredictor(model)
        elif hasattr(SAM2ImagePredictor, 'from_pretrained'):
            predictor = SAM2ImagePredictor.from_pretrained(SAM2_CHECKPOINT, device=DEVICE)
        else:
            SEGMENTER_LOAD_ERROR = 'sam2_from_pretrained_unavailable'
            return None
    except Exception as exc:
        SEGMENTER_LOAD_ERROR = f'segmenter_load_failed:{exc}'
        return None
    if hasattr(predictor, 'model') and DEVICE == 'cuda':
        predictor.model.to(DEVICE)
    SEGMENTER_LOAD_ERROR = None
    return predictor


@app.get('/healthz')
def healthz() -> Dict[str, Any]:
    detector = get_detector()
    grounding_dino_bundle = get_grounding_dino_bundle()
    segmenter = get_segmenter()
    return {
        'ok': True,
        'device': DEVICE,
        'detectorBackendRequested': DETECTOR_BACKEND_REQUESTED,
        'detectorBackend': detector.get('backend') if detector is not None else resolve_detector_backend(),
        'detectorConfigured': detector is not None,
        'groundingDinoConfigured': grounding_dino_bundle is not None,
        'segmenterConfigured': segmenter is not None,
        'openVocabSegmenterConfigured': grounding_dino_bundle is not None and segmenter is not None,
        'detectorWeights': DETECTOR_WEIGHTS or None,
        'groundingDinoModel': GROUNDING_DINO_MODEL or None,
        'sam2Checkpoint': SAM2_CHECKPOINT or None,
        'sam2Config': SAM2_CONFIG or None,
        'detectorLoadError': DETECTOR_LOAD_ERROR,
        'groundingDinoLoadError': GROUNDING_DINO_LOAD_ERROR,
        'segmenterLoadError': SEGMENTER_LOAD_ERROR,
    }


def detect_with_yolo(detector_bundle: Dict[str, Any], request: DetectTargetRequest, image: np.ndarray, width: int, height: int) -> List[Dict[str, Any]]:
    detector = detector_bundle['model']

    try:
        results = detector.predict(
            source=image,
            conf=YOLO_CONFIDENCE,
            verbose=False,
            device=0 if DEVICE == 'cuda' else 'cpu',
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f'detector_failed: {exc}') from exc

    rough_box = request.roughBox
    predictions: List[Dict[str, Any]] = []
    class_names = getattr(detector, 'names', {}) or {}
    requested_classes = [value.lower() for value in request.classes or []]

    for result in results:
        boxes = getattr(result, 'boxes', None)
        if boxes is None:
            continue

        xyxy = boxes.xyxy.detach().cpu().numpy() if hasattr(boxes.xyxy, 'detach') else np.asarray(boxes.xyxy)
        confs = boxes.conf.detach().cpu().numpy() if hasattr(boxes.conf, 'detach') else np.asarray(boxes.conf)
        class_ids = boxes.cls.detach().cpu().numpy() if hasattr(boxes.cls, 'detach') else np.asarray(boxes.cls)

        for box, confidence, class_id in zip(xyxy, confs, class_ids):
            label = str(class_names.get(int(class_id), class_id)).lower()
            if requested_classes and not any(class_hint in label for class_hint in requested_classes):
                if not label_matches_target(request.targetType, label):
                    continue
            elif not label_matches_target(request.targetType, label):
                continue

            x1, y1, x2, y2 = [float(value) for value in box.tolist()]
            output = {
                'class': label,
                'confidence': float(confidence),
                'boundingBox': xyxy_to_bbox(x1, y1, x2, y2, width, height),
            }
            if rough_box is not None:
                output['roughBox'] = rough_box.model_dump()
            predictions.append(output)

    predictions.sort(key=lambda item: item.get('confidence', 0.0), reverse=True)
    return predictions


def detect_with_grounding_dino(detector_bundle: Dict[str, Any], request: DetectTargetRequest, image: np.ndarray, width: int, height: int) -> List[Dict[str, Any]]:
    if torch is None:
        raise HTTPException(status_code=503, detail='torch_unavailable')

    processor = detector_bundle['processor']
    model = detector_bundle['model']
    prompt = grounding_dino_prompt(request.targetType, request.classes)

    try:
        inputs = processor(images=Image.fromarray(image), text=prompt, return_tensors='pt')
        inputs = inputs.to(DEVICE)
        with torch.no_grad():
            outputs = model(**inputs)
        postprocess_parameters = inspect.signature(processor.post_process_grounded_object_detection).parameters
        postprocess_kwargs = {
            'text_threshold': GROUNDING_DINO_TEXT_THRESHOLD,
            'target_sizes': [(height, width)],
        }
        if 'box_threshold' in postprocess_parameters:
            postprocess_kwargs['box_threshold'] = GROUNDING_DINO_BOX_THRESHOLD
        else:
            postprocess_kwargs['threshold'] = GROUNDING_DINO_BOX_THRESHOLD
        processed = processor.post_process_grounded_object_detection(
            outputs,
            inputs.input_ids,
            **postprocess_kwargs,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f'detector_failed: {exc}') from exc

    predictions: List[Dict[str, Any]] = []
    rough_box = request.roughBox
    result = processed[0] if processed else {}

    for box, score, label in zip(result.get('boxes', []), result.get('scores', []), result.get('labels', [])):
        normalized_label = str(label or '').lower().strip()
        if normalized_label and not label_matches_target(request.targetType, normalized_label):
            continue

        x1, y1, x2, y2 = [float(value) for value in box.tolist()]
        output = {
            'class': normalized_label or request.targetType,
            'confidence': float(score.item() if hasattr(score, 'item') else score),
            'boundingBox': xyxy_to_bbox(x1, y1, x2, y2, width, height),
        }
        if rough_box is not None:
            output['roughBox'] = rough_box.model_dump()
        predictions.append(output)

    predictions.sort(key=lambda item: item.get('confidence', 0.0), reverse=True)
    return predictions


@app.post('/detect-target')
def detect_target(request: DetectTargetRequest) -> Dict[str, Any]:
    detector_bundle = get_detector()
    if detector_bundle is None:
        raise HTTPException(status_code=503, detail='detector_unavailable')

    image = decode_image(request.image)
    height, width = image.shape[:2]

    if detector_bundle.get('backend') == 'grounding_dino':
        predictions = detect_with_grounding_dino(detector_bundle, request, image, width, height)
    else:
        predictions = detect_with_yolo(detector_bundle, request, image, width, height)

    return {
        'configured': True,
        'device': DEVICE,
        'detectorBackend': detector_bundle.get('backend'),
        'predictions': predictions,
    }


@app.post('/segment-target')
def segment_target(request: SegmentTargetRequest) -> Dict[str, Any]:
    predictor = get_segmenter()
    if predictor is None:
        raise HTTPException(status_code=503, detail='segmenter_unavailable')

    image = decode_image(request.image)
    height, width = image.shape[:2]
    prompt_box = bbox_to_xyxy(request.roughBox, width, height)

    try:
        predictor.set_image(image)
        masks, scores, _ = predictor.predict(box=prompt_box, multimask_output=True)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f'segmenter_failed: {exc}') from exc

    if masks is None or len(masks) == 0:
        raise HTTPException(status_code=422, detail='segmenter_returned_no_masks')

    best_index = int(np.argmax(scores)) if len(scores) else 0
    best_mask = np.asarray(masks[best_index]) > SAM2_MASK_THRESHOLD
    ys, xs = np.where(best_mask)
    if len(xs) == 0 or len(ys) == 0:
        raise HTTPException(status_code=422, detail='segmenter_mask_empty')

    x1 = float(xs.min())
    x2 = float(xs.max() + 1)
    y1 = float(ys.min())
    y2 = float(ys.max() + 1)

    return {
        'configured': True,
        'device': DEVICE,
        'confidence': float(scores[best_index]) if len(scores) else 0.0,
        'boundingBox': xyxy_to_bbox(x1, y1, x2, y2, width, height),
        'area': int(best_mask.sum()),
        'targetType': request.targetType,
    }


def encode_mask_png(mask: np.ndarray) -> str:
    image = Image.fromarray((mask.astype(np.uint8) > 0).astype(np.uint8) * 255, mode='L')
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return base64.b64encode(buffer.getvalue()).decode('ascii')


@app.post('/segment-open-vocab')
def segment_open_vocab(request: OpenVocabSegmentRequest) -> Dict[str, Any]:
    detector_bundle = get_grounding_dino_bundle()
    predictor = get_segmenter()
    if detector_bundle is None or predictor is None:
        raise HTTPException(status_code=503, detail='open_vocab_segmenter_unavailable')

    image = decode_image(request.image)
    height, width = image.shape[:2]
    processor = detector_bundle['processor']
    model = detector_bundle['model']

    prompt = open_vocab_prompt(request.prompt, request.classes)

    box_threshold = float(request.boxThreshold if request.boxThreshold is not None else GROUNDING_DINO_BOX_THRESHOLD)
    text_threshold = float(request.textThreshold if request.textThreshold is not None else GROUNDING_DINO_TEXT_THRESHOLD)

    try:
        inputs = processor(images=Image.fromarray(image), text=prompt, return_tensors='pt')
        inputs = inputs.to(DEVICE)
        with torch.no_grad():
            outputs = model(**inputs)
        postprocess_parameters = inspect.signature(processor.post_process_grounded_object_detection).parameters
        postprocess_kwargs = {
            'text_threshold': text_threshold,
            'target_sizes': [(height, width)],
        }
        if 'box_threshold' in postprocess_parameters:
            postprocess_kwargs['box_threshold'] = box_threshold
        else:
            postprocess_kwargs['threshold'] = box_threshold
        processed = processor.post_process_grounded_object_detection(
            outputs,
            inputs.input_ids,
            **postprocess_kwargs,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f'open_vocab_detector_failed: {exc}') from exc

    predictor.set_image(image)
    detections: List[Dict[str, Any]] = []
    result = processed[0] if processed else {}

    for box, score, label in zip(result.get('boxes', []), result.get('scores', []), result.get('labels', [])):
        normalized_label = normalize_phrase(label)
        if request.classes and not label_matches_requested_classes(normalized_label, request.classes):
            continue

        x1, y1, x2, y2 = [float(value) for value in box.tolist()]
        try:
            masks, mask_scores, _ = predictor.predict(
                box=np.array([x1, y1, x2, y2], dtype=np.float32),
                multimask_output=True,
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f'segmenter_failed: {exc}') from exc

        if masks is None or len(masks) == 0:
            continue

        best_index = int(np.argmax(mask_scores)) if len(mask_scores) else 0
        best_mask = np.asarray(masks[best_index]) > SAM2_MASK_THRESHOLD
        if not np.any(best_mask):
            continue

        detection = {
            'class': canonicalize_requested_class(normalized_label, request.classes),
            'label': normalized_label or 'object',
            'score': float(score.item() if hasattr(score, 'item') else score),
            'box': xyxy_to_bbox(x1, y1, x2, y2, width, height),
        }
        if request.returnMasks:
            detection['maskPng'] = encode_mask_png(best_mask)
        detections.append(detection)

    detections.sort(key=lambda item: item.get('score', 0.0), reverse=True)
    return {
        'configured': True,
        'device': DEVICE,
        'detectorBackend': 'grounding_dino',
        'detections': detections,
    }


if __name__ == '__main__':
    import uvicorn

    uvicorn.run(
        'specialist_vision_service:app',
        host=os.environ.get('SPECIALIST_HOST', '0.0.0.0'),
        port=int(os.environ.get('SPECIALIST_PORT', '8010')),
        reload=False,
    )
