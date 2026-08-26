#!/usr/bin/env python3
"""
Measurement Export Module (Pipeline v2)

Extracts real-world measurements from a semantically labeled 3D mesh.

Features:
- Room dimensions (floor area, volume, ceiling height)
- Cabinet measurements (width, height, depth)
- Door/window dimensions
- Counter lengths
- Accuracy estimation based on segmentation confidence

Usage:
    python measurement_export.py <labeled_mesh> <labels_json> <output_path>

Output:
    - measurements.json with all extracted dimensions
    - measurement_visualization.ply (optional mesh with measurement annotations)
"""

import os
import sys
import json
import argparse
import time
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass, field, asdict
from collections import defaultdict
import numpy as np

try:
    import open3d as o3d
    HAS_OPEN3D = True
except ImportError:
    HAS_OPEN3D = False
    print("[Measure] Error: Open3D required")

try:
    from scipy.spatial import ConvexHull
    from scipy.spatial.distance import cdist
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    print("[Measure] Warning: SciPy not available")


# =============================================================================
# DATA CLASSES
# =============================================================================

@dataclass
class RoomMeasurement:
    """Room-level measurements."""
    floor_area_sqm: float = 0.0
    ceiling_height_m: float = 0.0
    volume_m3: float = 0.0
    wall_lengths_m: List[float] = field(default_factory=list)
    perimeter_m: float = 0.0
    accuracy_estimate_cm: float = 2.0  # ±2cm typical


@dataclass
class CabinetMeasurement:
    """Individual cabinet measurement."""
    id: str = ""
    type: str = "base"  # base, upper, tall
    width_m: float = 0.0
    height_m: float = 0.0
    depth_m: float = 0.0
    location: List[float] = field(default_factory=list)  # [x, y, z] centroid
    confidence: float = 0.0
    accuracy_estimate_mm: float = 5.0  # ±5mm typical


@dataclass
class DoorMeasurement:
    """Door opening measurement."""
    id: str = ""
    width_m: float = 0.0
    height_m: float = 0.0
    location: List[float] = field(default_factory=list)
    is_exterior: bool = False
    confidence: float = 0.0
    accuracy_estimate_cm: float = 1.0


@dataclass
class WindowMeasurement:
    """Window measurement."""
    id: str = ""
    width_m: float = 0.0
    height_m: float = 0.0
    sill_height_m: float = 0.0
    location: List[float] = field(default_factory=list)
    confidence: float = 0.0
    accuracy_estimate_cm: float = 2.0


@dataclass
class CounterMeasurement:
    """Counter/countertop measurement."""
    id: str = ""
    length_m: float = 0.0
    depth_m: float = 0.0
    height_m: float = 0.0
    area_sqm: float = 0.0
    location: List[float] = field(default_factory=list)
    confidence: float = 0.0
    accuracy_estimate_cm: float = 1.0


@dataclass
class ApplianceMeasurement:
    """Appliance measurement."""
    id: str = ""
    type: str = "unknown"
    width_m: float = 0.0
    height_m: float = 0.0
    depth_m: float = 0.0
    location: List[float] = field(default_factory=list)
    confidence: float = 0.0


@dataclass
class PropertyMeasurements:
    """Complete property measurements."""
    room: RoomMeasurement = field(default_factory=RoomMeasurement)
    cabinets: List[CabinetMeasurement] = field(default_factory=list)
    doors: List[DoorMeasurement] = field(default_factory=list)
    windows: List[WindowMeasurement] = field(default_factory=list)
    counters: List[CounterMeasurement] = field(default_factory=list)
    appliances: List[ApplianceMeasurement] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)


# =============================================================================
# GEOMETRY UTILITIES
# =============================================================================

def compute_oriented_bbox(points: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Compute oriented bounding box for a set of points.
    
    Returns:
        center: Center of the box
        extent: Width, height, depth (sorted)
        rotation: 3x3 rotation matrix
    """
    if len(points) < 4:
        center = np.mean(points, axis=0)
        extent = np.max(points, axis=0) - np.min(points, axis=0)
        return center, extent, np.eye(3)
    
    # Use PCA to find principal axes
    center = np.mean(points, axis=0)
    centered = points - center
    
    cov = np.cov(centered.T)
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    
    # Sort by eigenvalue (largest first)
    idx = np.argsort(eigenvalues)[::-1]
    eigenvectors = eigenvectors[:, idx]
    
    # Project points onto principal axes
    projected = centered @ eigenvectors
    
    min_pt = np.min(projected, axis=0)
    max_pt = np.max(projected, axis=0)
    extent = max_pt - min_pt
    
    return center, extent, eigenvectors


def fit_plane_ransac(
    points: np.ndarray,
    threshold: float = 0.01,
    n_iterations: int = 1000
) -> Tuple[np.ndarray, float, np.ndarray]:
    """
    Fit plane to points using RANSAC.
    
    Returns:
        normal: Plane normal
        d: Plane distance from origin
        inliers: Boolean mask of inlier points
    """
    best_inliers = np.zeros(len(points), dtype=bool)
    best_normal = np.array([0, 1, 0])
    best_d = 0
    
    for _ in range(n_iterations):
        # Random sample of 3 points
        idx = np.random.choice(len(points), 3, replace=False)
        p1, p2, p3 = points[idx]
        
        # Compute plane
        v1 = p2 - p1
        v2 = p3 - p1
        normal = np.cross(v1, v2)
        norm = np.linalg.norm(normal)
        
        if norm < 1e-10:
            continue
        
        normal = normal / norm
        d = -np.dot(normal, p1)
        
        # Count inliers
        distances = np.abs(points @ normal + d)
        inliers = distances < threshold
        
        if np.sum(inliers) > np.sum(best_inliers):
            best_inliers = inliers
            best_normal = normal
            best_d = d
    
    return best_normal, best_d, best_inliers


def cluster_connected_components(
    triangles: np.ndarray,
    labels: List[str],
    target_label: str
) -> List[List[int]]:
    """
    Cluster triangles by connectivity for a given label.
    
    Returns list of triangle index lists (one per component).
    """
    # Find triangles with target label
    target_indices = [i for i, l in enumerate(labels) if l == target_label]
    
    if not target_indices:
        return []
    
    # Build adjacency from shared vertices
    vertex_to_triangles = defaultdict(set)
    for tri_idx in target_indices:
        for v in triangles[tri_idx]:
            vertex_to_triangles[v].add(tri_idx)
    
    # Find connected components using union-find
    parent = {i: i for i in target_indices}
    
    def find(x):
        if parent[x] != x:
            parent[x] = find(parent[x])
        return parent[x]
    
    def union(x, y):
        px, py = find(x), find(y)
        if px != py:
            parent[px] = py
    
    # Union triangles that share vertices
    for tri_set in vertex_to_triangles.values():
        tri_list = list(tri_set)
        for i in range(1, len(tri_list)):
            union(tri_list[0], tri_list[i])
    
    # Group by component
    components = defaultdict(list)
    for tri_idx in target_indices:
        components[find(tri_idx)].append(tri_idx)
    
    return list(components.values())


# =============================================================================
# MEASUREMENT EXTRACTION
# =============================================================================

class MeasurementExtractor:
    """Extracts measurements from labeled mesh."""
    
    def __init__(
        self,
        mesh: o3d.geometry.TriangleMesh,
        labels: List[str],
        confidences: List[float]
    ):
        self.mesh = mesh
        self.vertices = np.asarray(mesh.vertices)
        self.triangles = np.asarray(mesh.triangles)
        self.labels = labels
        self.confidences = confidences
        
        # Compute triangle areas
        self.triangle_areas = self._compute_triangle_areas()
        
        # Find floor reference
        self.floor_height = self._find_floor_height()
    
    def _compute_triangle_areas(self) -> np.ndarray:
        """Compute area of each triangle."""
        v0 = self.vertices[self.triangles[:, 0]]
        v1 = self.vertices[self.triangles[:, 1]]
        v2 = self.vertices[self.triangles[:, 2]]
        
        cross = np.cross(v1 - v0, v2 - v0)
        areas = 0.5 * np.linalg.norm(cross, axis=1)
        
        return areas
    
    def _find_floor_height(self) -> float:
        """Find floor plane height."""
        floor_indices = [i for i, l in enumerate(self.labels) if l == 'floor']
        
        if not floor_indices:
            # Use lowest point as floor
            return np.min(self.vertices[:, 1])
        
        # Get floor triangle vertices
        floor_vertices = set()
        for i in floor_indices:
            floor_vertices.update(self.triangles[i])
        
        floor_points = self.vertices[list(floor_vertices)]
        
        # Fit plane to floor
        normal, d, _ = fit_plane_ransac(floor_points)
        
        # Return mean height
        return np.mean(floor_points[:, 1])
    
    def _get_label_points(self, label: str) -> np.ndarray:
        """Get all vertices for triangles with given label."""
        indices = [i for i, l in enumerate(self.labels) if l == label]
        
        if not indices:
            return np.array([])
        
        vertex_indices = set()
        for i in indices:
            vertex_indices.update(self.triangles[i])
        
        return self.vertices[list(vertex_indices)]
    
    def extract_room_measurements(self) -> RoomMeasurement:
        """Extract room-level measurements."""
        room = RoomMeasurement()
        
        # Floor area
        floor_indices = [i for i, l in enumerate(self.labels) if l == 'floor']
        if floor_indices:
            room.floor_area_sqm = float(np.sum(self.triangle_areas[floor_indices]))
        
        # Ceiling height
        floor_points = self._get_label_points('floor')
        ceiling_points = self._get_label_points('ceiling')
        
        if len(floor_points) > 0 and len(ceiling_points) > 0:
            floor_y = np.median(floor_points[:, 1])
            ceiling_y = np.median(ceiling_points[:, 1])
            room.ceiling_height_m = float(ceiling_y - floor_y)
        elif len(ceiling_points) > 0:
            room.ceiling_height_m = float(np.median(ceiling_points[:, 1]) - self.floor_height)
        
        # Volume
        if room.floor_area_sqm > 0 and room.ceiling_height_m > 0:
            room.volume_m3 = room.floor_area_sqm * room.ceiling_height_m
        
        # Wall perimeter (from floor boundary)
        if len(floor_points) > 0 and HAS_SCIPY:
            # Project floor to 2D
            floor_2d = floor_points[:, [0, 2]]  # X, Z
            
            try:
                hull = ConvexHull(floor_2d)
                room.perimeter_m = float(hull.area)  # In 2D, 'area' is perimeter
                
                # Extract wall lengths
                for i in range(len(hull.vertices)):
                    p1 = floor_2d[hull.vertices[i]]
                    p2 = floor_2d[hull.vertices[(i + 1) % len(hull.vertices)]]
                    length = np.linalg.norm(p2 - p1)
                    room.wall_lengths_m.append(float(length))
            except:
                pass
        
        return room
    
    def extract_cabinet_measurements(self) -> List[CabinetMeasurement]:
        """Extract measurements for all cabinets."""
        cabinets = []
        
        # Find connected components of cabinet triangles
        components = cluster_connected_components(
            self.triangles, self.labels, 'cabinet'
        )
        
        for comp_idx, component in enumerate(components):
            if len(component) < 10:  # Skip tiny fragments
                continue
            
            # Get component vertices
            vertex_indices = set()
            for tri_idx in component:
                vertex_indices.update(self.triangles[tri_idx])
            
            points = self.vertices[list(vertex_indices)]
            
            if len(points) < 4:
                continue
            
            # Compute oriented bounding box
            center, extent, rotation = compute_oriented_bbox(points)
            
            # Sort extent to get width/height/depth
            sorted_extent = np.sort(extent)[::-1]
            
            # Classify cabinet type based on height above floor
            height_above_floor = center[1] - self.floor_height
            
            if height_above_floor > 1.2:
                cabinet_type = 'upper'
            elif sorted_extent[1] > 1.5:  # Tall cabinet
                cabinet_type = 'tall'
            else:
                cabinet_type = 'base'
            
            # Compute confidence
            conf = np.mean([self.confidences[i] for i in component])
            
            # Estimate accuracy based on confidence and size
            base_accuracy = 5.0  # mm
            accuracy = base_accuracy / max(0.5, conf)
            
            cabinet = CabinetMeasurement(
                id=f"cabinet_{comp_idx + 1}",
                type=cabinet_type,
                width_m=float(sorted_extent[0]),
                height_m=float(sorted_extent[1]),
                depth_m=float(sorted_extent[2]),
                location=center.tolist(),
                confidence=float(conf),
                accuracy_estimate_mm=float(accuracy),
            )
            
            cabinets.append(cabinet)
        
        return cabinets
    
    def extract_door_measurements(self) -> List[DoorMeasurement]:
        """Extract door measurements."""
        doors = []
        
        components = cluster_connected_components(
            self.triangles, self.labels, 'door'
        )
        
        for comp_idx, component in enumerate(components):
            if len(component) < 5:
                continue
            
            vertex_indices = set()
            for tri_idx in component:
                vertex_indices.update(self.triangles[tri_idx])
            
            points = self.vertices[list(vertex_indices)]
            
            if len(points) < 4:
                continue
            
            center, extent, _ = compute_oriented_bbox(points)
            
            # Door is vertical, so height is the largest vertical extent
            y_extent = np.max(points[:, 1]) - np.min(points[:, 1])
            
            # Width is the horizontal extent
            xz_extent = np.max(extent[[0, 2]] if len(extent) > 2 else extent[:2])
            
            # Classify as exterior if wider than typical interior
            is_exterior = xz_extent > 0.85
            
            conf = np.mean([self.confidences[i] for i in component])
            
            door = DoorMeasurement(
                id=f"door_{comp_idx + 1}",
                width_m=float(xz_extent),
                height_m=float(y_extent),
                location=center.tolist(),
                is_exterior=is_exterior,
                confidence=float(conf),
                accuracy_estimate_cm=1.0,
            )
            
            doors.append(door)
        
        return doors
    
    def extract_window_measurements(self) -> List[WindowMeasurement]:
        """Extract window measurements."""
        windows = []
        
        components = cluster_connected_components(
            self.triangles, self.labels, 'window'
        )
        
        for comp_idx, component in enumerate(components):
            if len(component) < 5:
                continue
            
            vertex_indices = set()
            for tri_idx in component:
                vertex_indices.update(self.triangles[tri_idx])
            
            points = self.vertices[list(vertex_indices)]
            
            if len(points) < 4:
                continue
            
            center, extent, _ = compute_oriented_bbox(points)
            
            # Window dimensions
            y_min = np.min(points[:, 1])
            y_max = np.max(points[:, 1])
            height = y_max - y_min
            
            # Width is horizontal extent
            width = np.max(extent[[0, 2]] if len(extent) > 2 else extent[:2])
            
            # Sill height
            sill_height = y_min - self.floor_height
            
            conf = np.mean([self.confidences[i] for i in component])
            
            window = WindowMeasurement(
                id=f"window_{comp_idx + 1}",
                width_m=float(width),
                height_m=float(height),
                sill_height_m=float(sill_height),
                location=center.tolist(),
                confidence=float(conf),
                accuracy_estimate_cm=2.0,
            )
            
            windows.append(window)
        
        return windows
    
    def extract_counter_measurements(self) -> List[CounterMeasurement]:
        """Extract counter/countertop measurements."""
        counters = []
        
        components = cluster_connected_components(
            self.triangles, self.labels, 'counter'
        )
        
        for comp_idx, component in enumerate(components):
            if len(component) < 5:
                continue
            
            vertex_indices = set()
            tri_areas = []
            for tri_idx in component:
                vertex_indices.update(self.triangles[tri_idx])
                tri_areas.append(self.triangle_areas[tri_idx])
            
            points = self.vertices[list(vertex_indices)]
            
            if len(points) < 4:
                continue
            
            center, extent, _ = compute_oriented_bbox(points)
            
            # Counter is horizontal, so find the horizontal extent
            # Height above floor
            height = np.median(points[:, 1]) - self.floor_height
            
            # Surface area
            area = sum(tri_areas)
            
            # Length and depth from extent (largest horizontal = length)
            horizontal_extents = [extent[0], extent[2]] if len(extent) > 2 else list(extent[:2])
            horizontal_extents.sort(reverse=True)
            length = horizontal_extents[0] if horizontal_extents else 0
            depth = horizontal_extents[1] if len(horizontal_extents) > 1 else 0
            
            conf = np.mean([self.confidences[i] for i in component])
            
            counter = CounterMeasurement(
                id=f"counter_{comp_idx + 1}",
                length_m=float(length),
                depth_m=float(depth),
                height_m=float(height),
                area_sqm=float(area),
                location=center.tolist(),
                confidence=float(conf),
                accuracy_estimate_cm=1.0,
            )
            
            counters.append(counter)
        
        return counters
    
    def extract_appliance_measurements(self) -> List[ApplianceMeasurement]:
        """Extract appliance measurements."""
        appliances = []
        
        components = cluster_connected_components(
            self.triangles, self.labels, 'appliance'
        )
        
        for comp_idx, component in enumerate(components):
            if len(component) < 5:
                continue
            
            vertex_indices = set()
            for tri_idx in component:
                vertex_indices.update(self.triangles[tri_idx])
            
            points = self.vertices[list(vertex_indices)]
            
            if len(points) < 4:
                continue
            
            center, extent, _ = compute_oriented_bbox(points)
            sorted_extent = np.sort(extent)[::-1]
            
            conf = np.mean([self.confidences[i] for i in component])
            
            # Try to classify appliance type by size
            appliance_type = 'unknown'
            if sorted_extent[1] > 1.5:  # Tall
                appliance_type = 'refrigerator'
            elif 0.5 < sorted_extent[0] < 0.8 and sorted_extent[1] < 0.5:
                appliance_type = 'dishwasher'
            elif 0.55 < sorted_extent[0] < 0.75:
                appliance_type = 'range'
            
            appliance = ApplianceMeasurement(
                id=f"appliance_{comp_idx + 1}",
                type=appliance_type,
                width_m=float(sorted_extent[0]),
                height_m=float(sorted_extent[1]),
                depth_m=float(sorted_extent[2]),
                location=center.tolist(),
                confidence=float(conf),
            )
            
            appliances.append(appliance)
        
        return appliances
    
    def extract_all(self) -> PropertyMeasurements:
        """Extract all measurements."""
        measurements = PropertyMeasurements(
            room=self.extract_room_measurements(),
            cabinets=self.extract_cabinet_measurements(),
            doors=self.extract_door_measurements(),
            windows=self.extract_window_measurements(),
            counters=self.extract_counter_measurements(),
            appliances=self.extract_appliance_measurements(),
        )
        
        measurements.metadata = {
            'total_triangles': len(self.triangles),
            'labeled_triangles': sum(1 for l in self.labels if l != 'unknown'),
            'floor_height_reference': float(self.floor_height),
            'extraction_timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
        }
        
        return measurements


# =============================================================================
# MAIN
# =============================================================================

def run_measurement_export(
    mesh_path: Path,
    labels_path: Path,
    output_path: Path
) -> Dict[str, Any]:
    """
    Run measurement extraction.
    
    Args:
        mesh_path: Path to labeled mesh
        labels_path: Path to triangle_labels.json
        output_path: Output measurements.json path
    
    Returns:
        Measurements dict
    """
    mesh_path = Path(mesh_path)
    labels_path = Path(labels_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    start_time = time.time()
    
    # Load mesh
    print(f"[Measure] Loading mesh: {mesh_path}")
    mesh = o3d.io.read_triangle_mesh(str(mesh_path))
    print(f"[Measure] Mesh: {len(mesh.vertices):,} vertices, {len(mesh.triangles):,} triangles")
    
    # Load labels
    print(f"[Measure] Loading labels: {labels_path}")
    with open(labels_path, 'r') as f:
        labels_data = json.load(f)
    
    labels = labels_data['labels']
    confidences = labels_data.get('confidences', [1.0] * len(labels))
    
    print(f"[Measure] Labels: {len(labels)} triangles labeled")
    
    # Extract measurements
    extractor = MeasurementExtractor(mesh, labels, confidences)
    measurements = extractor.extract_all()
    
    # Convert to dict
    def dataclass_to_dict(obj):
        if hasattr(obj, '__dataclass_fields__'):
            return {k: dataclass_to_dict(v) for k, v in asdict(obj).items()}
        elif isinstance(obj, list):
            return [dataclass_to_dict(v) for v in obj]
        elif isinstance(obj, dict):
            return {k: dataclass_to_dict(v) for k, v in obj.items()}
        else:
            return obj
    
    measurements_dict = dataclass_to_dict(measurements)
    measurements_dict['processing_time'] = time.time() - start_time
    
    # Save
    with open(output_path, 'w') as f:
        json.dump(measurements_dict, f, indent=2)
    
    print(f"[Measure] Saved measurements: {output_path}")
    
    # Print summary
    print(f"\n[Measure] ✅ Extraction complete in {measurements_dict['processing_time']:.1f}s")
    print(f"\n[Measure] === ROOM ===")
    room = measurements.room
    print(f"[Measure]   Floor area: {room.floor_area_sqm:.2f} m² ({room.floor_area_sqm * 10.764:.1f} ft²)")
    print(f"[Measure]   Ceiling height: {room.ceiling_height_m:.2f} m ({room.ceiling_height_m * 3.281:.1f} ft)")
    print(f"[Measure]   Volume: {room.volume_m3:.2f} m³")
    
    if measurements.cabinets:
        print(f"\n[Measure] === CABINETS ({len(measurements.cabinets)}) ===")
        for cab in measurements.cabinets[:5]:
            print(f"[Measure]   {cab.id} ({cab.type}): "
                  f"{cab.width_m*100:.1f}×{cab.height_m*100:.1f}×{cab.depth_m*100:.1f} cm "
                  f"(±{cab.accuracy_estimate_mm:.1f}mm, conf: {cab.confidence:.2f})")
    
    if measurements.doors:
        print(f"\n[Measure] === DOORS ({len(measurements.doors)}) ===")
        for door in measurements.doors[:5]:
            ext = " (exterior)" if door.is_exterior else ""
            print(f"[Measure]   {door.id}: {door.width_m*100:.1f}×{door.height_m*100:.1f} cm{ext}")
    
    if measurements.windows:
        print(f"\n[Measure] === WINDOWS ({len(measurements.windows)}) ===")
        for win in measurements.windows[:5]:
            print(f"[Measure]   {win.id}: {win.width_m*100:.1f}×{win.height_m*100:.1f} cm, "
                  f"sill: {win.sill_height_m*100:.1f} cm")
    
    if measurements.counters:
        print(f"\n[Measure] === COUNTERS ({len(measurements.counters)}) ===")
        for counter in measurements.counters[:5]:
            print(f"[Measure]   {counter.id}: {counter.length_m:.2f}m length, "
                  f"{counter.area_sqm:.2f} m² surface")
    
    return measurements_dict


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description='Extract measurements from labeled mesh (Pipeline v2)'
    )
    parser.add_argument('mesh_path', type=Path, help='Labeled mesh file')
    parser.add_argument('labels_path', type=Path, help='Triangle labels JSON')
    parser.add_argument('output_path', type=Path, help='Output measurements JSON')
    
    args = parser.parse_args()
    
    run_measurement_export(
        args.mesh_path,
        args.labels_path,
        args.output_path
    )


if __name__ == '__main__':
    main()
