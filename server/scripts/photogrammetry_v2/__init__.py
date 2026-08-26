"""
Photogrammetry Pipeline v2

High-accuracy interior 3D reconstruction pipeline featuring:
- Metric3D v2 for true metric-scale depth estimation
- Confidence-weighted depth fusion (MVS + neural depth)
- TSDF volumetric reconstruction (±2-5mm accuracy)
- SAM2 semantic segmentation for automatic object detection
- Reference-based scale refinement (±0.3% final accuracy)
- Automatic measurement extraction (cabinets, doors, windows)

Modules:
    - generate_metric_depth: Metric3D v2 depth estimation
    - depth_fusion: MVS + Metric3D confidence-weighted fusion
    - tsdf_reconstruction: Open3D TSDF volumetric mesh extraction
    - scale_refinement: Reference object scale calibration
    - semantic_segmentation: SAM2 2D→3D label projection
    - measurement_export: Dimension extraction from labeled mesh
    - pipeline_v2: Main orchestrator

Usage:
    # Run complete pipeline
    python -m photogrammetry_v2.pipeline_v2 ./images ./output

    # Run individual stages
    from photogrammetry_v2.generate_metric_depth import run_metric3d_estimation
    from photogrammetry_v2.depth_fusion import run_depth_fusion
    from photogrammetry_v2.tsdf_reconstruction import run_tsdf_reconstruction
    from photogrammetry_v2.semantic_segmentation import run_semantic_segmentation
    from photogrammetry_v2.measurement_export import run_measurement_export

Accuracy Targets:
    - Room dimensions: ±2-3cm
    - Cabinet measurements: ±3-5mm
    - Door/window dimensions: ±1-2cm
    - Scale accuracy: ±0.3% (with AR + reference objects)

Requirements:
    - Python 3.9+
    - COLMAP (for SfM/MVS)
    - PyTorch 2.0+ (for Metric3D, SAM2)
    - Open3D (for TSDF, mesh processing)
    - transformers (for CLIP classification)
    - sam2 (for segmentation)
"""

__version__ = "2.0.0"
__pipeline_version__ = "v2"

# Import main functions for convenience
try:
    from .pipeline_v2 import run_pipeline_v2, PipelineConfig, PipelineStats
except ImportError:
    pass

try:
    from .generate_metric_depth import run_metric3d_estimation
except ImportError:
    pass

try:
    from .depth_fusion import run_depth_fusion
except ImportError:
    pass

try:
    from .tsdf_reconstruction import run_tsdf_reconstruction
except ImportError:
    pass

try:
    from .scale_refinement import run_scale_refinement
except ImportError:
    pass

try:
    from .semantic_segmentation import run_semantic_segmentation
except ImportError:
    pass

try:
    from .measurement_export import run_measurement_export
except ImportError:
    pass
