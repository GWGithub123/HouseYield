"""
Photogrammetry Pipeline Package

Complete 3D reconstruction pipeline for room scanning:
- Sparse frontend (HLOC SuperPoint + LightGlue + GLOMAP)
- Dense reconstruction
- Mesh generation (Poisson)
- Texture mapping
- Viewpoint navigation
- Export (GLB, PLY, OBJ)
"""

from .pipeline import PhotogrammetryPipeline, ProcessingOptions, ProcessingResult
from .feature_extraction import FeatureExtractor
from .feature_matching import FeatureMatcher
from .sfm import StructureFromMotion
from .dense_reconstruction import DenseReconstructor
from .mesh_generation import MeshGenerator
from .texture_mapping import TextureMapper
from .viewpoint_clustering import ViewpointClusterer
from .export import MeshExporter

__all__ = [
    'PhotogrammetryPipeline',
    'ProcessingOptions',
    'ProcessingResult',
    'FeatureExtractor',
    'FeatureMatcher',
    'StructureFromMotion',
    'DenseReconstructor',
    'MeshGenerator',
    'TextureMapper',
    'ViewpointClusterer',
    'MeshExporter',
]

__version__ = '1.0.0'
