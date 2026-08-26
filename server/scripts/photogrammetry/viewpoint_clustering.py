#!/usr/bin/env python3
"""
Viewpoint Clustering Module

Clusters camera positions into navigation viewpoints for virtual walkthrough.
This reduces hundreds of camera poses into ~5-15 key viewpoints connected
by navigable paths.

Algorithm:
1. Cluster camera positions using DBSCAN (density-based)
2. Select best camera per cluster (highest visibility)
3. Build navigation graph between viewpoints
4. Generate transition paths for smooth navigation
"""

import json
import numpy as np
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any, Set
from dataclasses import dataclass, field
from collections import defaultdict

try:
    from sklearn.cluster import DBSCAN
    from scipy.spatial import Delaunay
    from scipy.spatial.distance import cdist
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    print("[ViewpointClustering] Warning: scipy/sklearn not available")


@dataclass
class Viewpoint:
    """A navigation viewpoint"""
    id: str
    position: np.ndarray  # 3D position
    orientation: np.ndarray  # Quaternion (wxyz)
    source_camera: str  # Original camera ID
    cluster_cameras: List[str]  # All cameras in this cluster
    
    def to_dict(self) -> Dict:
        return {
            'id': self.id,
            'position': self.position.tolist(),
            'orientation': self.orientation.tolist(),
            'source_camera': self.source_camera,
            'cluster_cameras': self.cluster_cameras,
        }


@dataclass
class NavigationEdge:
    """Edge between two viewpoints"""
    from_id: str
    to_id: str
    distance: float
    direction: np.ndarray  # Unit vector from -> to
    traversable: bool = True
    
    def to_dict(self) -> Dict:
        return {
            'from': self.from_id,
            'to': self.to_id,
            'distance': self.distance,
            'direction': self.direction.tolist(),
            'traversable': self.traversable,
        }


@dataclass
class NavigationGraph:
    """Graph of viewpoints and connections"""
    viewpoints: Dict[str, Viewpoint]
    edges: List[NavigationEdge]
    start_viewpoint: str = ""
    
    def to_dict(self) -> Dict:
        return {
            'viewpoints': {k: v.to_dict() for k, v in self.viewpoints.items()},
            'edges': [e.to_dict() for e in self.edges],
            'start_viewpoint': self.start_viewpoint,
            'num_viewpoints': len(self.viewpoints),
        }
    
    def save(self, path: Path):
        with open(path, 'w') as f:
            json.dump(self.to_dict(), f, indent=2)
    
    @classmethod
    def load(cls, path: Path) -> 'NavigationGraph':
        with open(path) as f:
            data = json.load(f)
        
        viewpoints = {}
        for k, v in data['viewpoints'].items():
            viewpoints[k] = Viewpoint(
                id=v['id'],
                position=np.array(v['position']),
                orientation=np.array(v['orientation']),
                source_camera=v['source_camera'],
                cluster_cameras=v['cluster_cameras'],
            )
        
        edges = [
            NavigationEdge(
                from_id=e['from'],
                to_id=e['to'],
                distance=e['distance'],
                direction=np.array(e['direction']),
                traversable=e.get('traversable', True),
            )
            for e in data['edges']
        ]
        
        return cls(
            viewpoints=viewpoints,
            edges=edges,
            start_viewpoint=data.get('start_viewpoint', ''),
        )


class ViewpointClusterer:
    """Cluster camera positions into navigation viewpoints"""
    
    def __init__(
        self,
        cluster_radius: float = 0.5,
        min_samples: int = 2,
        max_viewpoints: int = 20,
        max_edge_distance: float = 3.0,
    ):
        """
        Args:
            cluster_radius: DBSCAN eps parameter (meters)
            min_samples: Minimum cameras per cluster
            max_viewpoints: Maximum number of viewpoints
            max_edge_distance: Maximum edge length (meters)
        """
        self.cluster_radius = cluster_radius
        self.min_samples = min_samples
        self.max_viewpoints = max_viewpoints
        self.max_edge_distance = max_edge_distance
        
        print(f"[ViewpointClustering] Initialized with radius={cluster_radius}m")
    
    def run(
        self,
        cameras: Dict,
        mesh_path: Path = None,
        output_dir: Path = None,
    ) -> Dict[str, Any]:
        """
        Create viewpoint navigation graph from cameras.
        
        Args:
            cameras: Dict of camera_id -> Camera objects
            mesh_path: Optional mesh for visibility checking
            output_dir: Directory for output files
        
        Returns:
            Dict with num_viewpoints, navigation_path
        """
        print(f"[ViewpointClustering] Processing {len(cameras)} cameras...")
        
        # Extract camera positions and orientations
        positions = []
        orientations = []
        camera_ids = []
        
        for cam_id, camera in cameras.items():
            if hasattr(camera, 'position'):
                pos = camera.position
                quat = camera.quaternion
            else:
                pos = camera.get('position', [0, 0, 0])
                quat = camera.get('quaternion', [1, 0, 0, 0])
            
            positions.append(pos)
            orientations.append(quat)
            camera_ids.append(cam_id)
        
        positions = np.array(positions)
        orientations = np.array(orientations)
        
        # Cluster positions
        viewpoints = self._cluster_viewpoints(
            positions, orientations, camera_ids
        )
        
        print(f"[ViewpointClustering] Created {len(viewpoints)} viewpoints")
        
        # Build navigation graph
        edges = self._build_navigation_graph(viewpoints, mesh_path)
        
        print(f"[ViewpointClustering] Created {len(edges)} navigation edges")
        
        # Create graph
        nav_graph = NavigationGraph(
            viewpoints=viewpoints,
            edges=edges,
            start_viewpoint=list(viewpoints.keys())[0] if viewpoints else "",
        )
        
        # Save if output directory specified
        if output_dir:
            output_dir = Path(output_dir)
            output_dir.mkdir(parents=True, exist_ok=True)
            
            nav_path = output_dir / "navigation.json"
            nav_graph.save(nav_path)
        else:
            nav_path = None
        
        return {
            'num_viewpoints': len(viewpoints),
            'num_edges': len(edges),
            'navigation_path': nav_path,
            'graph': nav_graph,
        }
    
    def _cluster_viewpoints(
        self,
        positions: np.ndarray,
        orientations: np.ndarray,
        camera_ids: List[str],
    ) -> Dict[str, Viewpoint]:
        """Cluster camera positions into viewpoints"""
        
        if not HAS_SCIPY:
            # Fallback: simple grid-based clustering
            return self._cluster_simple(positions, orientations, camera_ids)
        
        # DBSCAN clustering
        clustering = DBSCAN(
            eps=self.cluster_radius,
            min_samples=self.min_samples,
        ).fit(positions)
        
        labels = clustering.labels_
        unique_labels = set(labels)
        
        viewpoints = {}
        
        for label in unique_labels:
            if label == -1:  # Noise
                continue
            
            mask = labels == label
            cluster_positions = positions[mask]
            cluster_orientations = orientations[mask]
            cluster_cameras = [camera_ids[i] for i in np.where(mask)[0]]
            
            # Select best camera (closest to centroid)
            centroid = cluster_positions.mean(axis=0)
            distances = np.linalg.norm(cluster_positions - centroid, axis=1)
            best_idx = np.argmin(distances)
            
            viewpoint_id = f"vp_{label}"
            
            viewpoints[viewpoint_id] = Viewpoint(
                id=viewpoint_id,
                position=cluster_positions[best_idx],
                orientation=cluster_orientations[best_idx],
                source_camera=cluster_cameras[best_idx],
                cluster_cameras=cluster_cameras,
            )
        
        # Handle noise points as individual viewpoints if needed
        noise_mask = labels == -1
        if noise_mask.any() and len(viewpoints) < self.max_viewpoints:
            noise_positions = positions[noise_mask]
            noise_orientations = orientations[noise_mask]
            noise_cameras = [camera_ids[i] for i in np.where(noise_mask)[0]]
            
            for i, (pos, ori, cam) in enumerate(zip(
                noise_positions, noise_orientations, noise_cameras
            )):
                if len(viewpoints) >= self.max_viewpoints:
                    break
                
                viewpoint_id = f"vp_solo_{i}"
                viewpoints[viewpoint_id] = Viewpoint(
                    id=viewpoint_id,
                    position=pos,
                    orientation=ori,
                    source_camera=cam,
                    cluster_cameras=[cam],
                )
        
        # Limit to max viewpoints
        if len(viewpoints) > self.max_viewpoints:
            # Keep the ones with most cameras
            sorted_vps = sorted(
                viewpoints.items(),
                key=lambda x: len(x[1].cluster_cameras),
                reverse=True
            )
            viewpoints = dict(sorted_vps[:self.max_viewpoints])
        
        return viewpoints
    
    def _cluster_simple(
        self,
        positions: np.ndarray,
        orientations: np.ndarray,
        camera_ids: List[str],
    ) -> Dict[str, Viewpoint]:
        """Simple grid-based clustering fallback"""
        
        # Divide space into grid cells
        cell_size = self.cluster_radius * 2
        
        cells = defaultdict(list)
        
        for i, pos in enumerate(positions):
            cell = tuple((pos / cell_size).astype(int))
            cells[cell].append(i)
        
        viewpoints = {}
        
        for cell_idx, (cell, indices) in enumerate(cells.items()):
            if len(viewpoints) >= self.max_viewpoints:
                break
            
            # Get best camera in cell
            cell_positions = positions[indices]
            centroid = cell_positions.mean(axis=0)
            distances = np.linalg.norm(cell_positions - centroid, axis=1)
            best_local_idx = np.argmin(distances)
            best_idx = indices[best_local_idx]
            
            viewpoint_id = f"vp_{cell_idx}"
            
            viewpoints[viewpoint_id] = Viewpoint(
                id=viewpoint_id,
                position=positions[best_idx],
                orientation=orientations[best_idx],
                source_camera=camera_ids[best_idx],
                cluster_cameras=[camera_ids[i] for i in indices],
            )
        
        return viewpoints
    
    def _build_navigation_graph(
        self,
        viewpoints: Dict[str, Viewpoint],
        mesh_path: Path = None,
    ) -> List[NavigationEdge]:
        """Build navigation edges between viewpoints"""
        
        if len(viewpoints) < 2:
            return []
        
        vp_ids = list(viewpoints.keys())
        positions = np.array([viewpoints[vp].position for vp in vp_ids])
        
        edges = []
        
        if HAS_SCIPY and len(viewpoints) >= 4:
            # Use Delaunay triangulation for natural connectivity
            try:
                tri = Delaunay(positions[:, :2])  # Project to floor plane
                
                for simplex in tri.simplices:
                    for i in range(3):
                        v1 = simplex[i]
                        v2 = simplex[(i + 1) % 3]
                        
                        if v1 < v2:  # Avoid duplicates
                            self._add_edge(
                                edges, vp_ids[v1], vp_ids[v2],
                                viewpoints, mesh_path
                            )
            except Exception:
                # Fall back to nearest neighbor
                self._add_nearest_neighbor_edges(edges, vp_ids, viewpoints, mesh_path)
        else:
            self._add_nearest_neighbor_edges(edges, vp_ids, viewpoints, mesh_path)
        
        return edges
    
    def _add_edge(
        self,
        edges: List[NavigationEdge],
        vp1_id: str,
        vp2_id: str,
        viewpoints: Dict[str, Viewpoint],
        mesh_path: Path = None,
    ):
        """Add an edge if it's valid"""
        
        vp1 = viewpoints[vp1_id]
        vp2 = viewpoints[vp2_id]
        
        diff = vp2.position - vp1.position
        distance = np.linalg.norm(diff)
        
        if distance > self.max_edge_distance:
            return
        
        if distance < 1e-6:
            return
        
        direction = diff / distance
        
        # Check if path is traversable (optional mesh collision check)
        traversable = True
        if mesh_path:
            traversable = self._check_path_traversable(
                vp1.position, vp2.position, mesh_path
            )
        
        edges.append(NavigationEdge(
            from_id=vp1_id,
            to_id=vp2_id,
            distance=distance,
            direction=direction,
            traversable=traversable,
        ))
        
        # Add reverse edge
        edges.append(NavigationEdge(
            from_id=vp2_id,
            to_id=vp1_id,
            distance=distance,
            direction=-direction,
            traversable=traversable,
        ))
    
    def _add_nearest_neighbor_edges(
        self,
        edges: List[NavigationEdge],
        vp_ids: List[str],
        viewpoints: Dict[str, Viewpoint],
        mesh_path: Path = None,
    ):
        """Add edges to k nearest neighbors"""
        
        k = min(3, len(vp_ids) - 1)
        positions = np.array([viewpoints[vp].position for vp in vp_ids])
        
        # Compute all pairwise distances
        distances = cdist(positions, positions) if HAS_SCIPY else self._pairwise_distances(positions)
        
        added = set()
        
        for i, vp1_id in enumerate(vp_ids):
            # Get k nearest
            nearest = np.argsort(distances[i])[1:k+1]  # Exclude self
            
            for j in nearest:
                vp2_id = vp_ids[j]
                edge_key = tuple(sorted([vp1_id, vp2_id]))
                
                if edge_key not in added:
                    added.add(edge_key)
                    self._add_edge(edges, vp1_id, vp2_id, viewpoints, mesh_path)
    
    def _pairwise_distances(self, positions: np.ndarray) -> np.ndarray:
        """Compute pairwise distances without scipy"""
        n = len(positions)
        distances = np.zeros((n, n))
        
        for i in range(n):
            for j in range(i + 1, n):
                d = np.linalg.norm(positions[i] - positions[j])
                distances[i, j] = d
                distances[j, i] = d
        
        return distances
    
    def _check_path_traversable(
        self,
        start: np.ndarray,
        end: np.ndarray,
        mesh_path: Path,
    ) -> bool:
        """Check if path between viewpoints is traversable (no obstacles)"""
        
        # This would use ray casting against the mesh
        # For now, assume all paths are traversable
        return True


def generate_arrow_directions(
    current_viewpoint: Viewpoint,
    graph: NavigationGraph,
) -> List[Dict]:
    """
    Generate arrow directions for navigation UI.
    Returns list of {direction, target_viewpoint, angle} for each connected viewpoint.
    """
    
    arrows = []
    
    for edge in graph.edges:
        if edge.from_id == current_viewpoint.id and edge.traversable:
            target = graph.viewpoints[edge.to_id]
            
            # Calculate angle from current orientation
            # Assuming orientation is quaternion (wxyz)
            forward = quaternion_to_forward(current_viewpoint.orientation)
            angle = np.arctan2(edge.direction[0], edge.direction[2])
            current_angle = np.arctan2(forward[0], forward[2])
            relative_angle = angle - current_angle
            
            arrows.append({
                'target_viewpoint': edge.to_id,
                'direction': edge.direction.tolist(),
                'distance': edge.distance,
                'angle_degrees': np.degrees(relative_angle),
            })
    
    return arrows


def quaternion_to_forward(q: np.ndarray) -> np.ndarray:
    """Convert quaternion to forward vector"""
    w, x, y, z = q
    
    forward = np.array([
        2 * (x * z + w * y),
        2 * (y * z - w * x),
        1 - 2 * (x * x + y * y)
    ])
    
    return forward / np.linalg.norm(forward)


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Cluster camera viewpoints')
    parser.add_argument('cameras', help='JSON file with camera poses')
    parser.add_argument('--output', '-o', default='./navigation_output')
    parser.add_argument('--radius', type=float, default=0.5)
    parser.add_argument('--mesh', help='Optional mesh for visibility')
    
    args = parser.parse_args()
    
    with open(args.cameras) as f:
        cameras = json.load(f)
    
    clusterer = ViewpointClusterer(cluster_radius=args.radius)
    
    result = clusterer.run(
        cameras,
        mesh_path=Path(args.mesh) if args.mesh else None,
        output_dir=Path(args.output),
    )
    
    print(f"\nViewpoint Clustering Results:")
    print(f"  Viewpoints: {result['num_viewpoints']}")
    print(f"  Edges: {result['num_edges']}")
    print(f"  Output: {result['navigation_path']}")
