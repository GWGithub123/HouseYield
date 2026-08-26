#!/usr/bin/env python3
"""
Mesh Generation Module

Creates a triangulated surface mesh from dense point clouds.
Supports multiple algorithms:
1. Screened Poisson Surface Reconstruction (best quality)
2. Ball Pivoting Algorithm (preserves sharp edges)
3. Marching Cubes (for volumetric data)

The Poisson method is recommended for room scans as it:
- Creates watertight meshes
- Handles noise well
- Produces smooth surfaces
"""

import os
import json
import numpy as np
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass
import subprocess
import shutil

try:
    import open3d as o3d
    HAS_OPEN3D = True
except ImportError:
    HAS_OPEN3D = False
    print("[MeshGeneration] Warning: Open3D not available")

try:
    import pymeshlab
    HAS_MESHLAB = True
except ImportError:
    HAS_MESHLAB = False

# Check for PoissonRecon (standalone Screened Poisson Reconstruction)
HAS_POISSONRECON = shutil.which('PoissonRecon') is not None


@dataclass
class MeshResult:
    """Result from mesh generation"""
    num_vertices: int
    num_faces: int
    mesh_path: Path
    dimensions: Dict[str, float]
    
    def to_dict(self) -> Dict:
        return {
            'num_vertices': self.num_vertices,
            'num_faces': self.num_faces,
            'mesh_path': str(self.mesh_path),
            'dimensions': self.dimensions,
        }


class MeshGenerator:
    """Generate mesh from point cloud"""
    
    def __init__(
        self,
        method: str = "poisson",
        depth: int = 10,
        target_triangles: int = 500000,
        clean_mesh: bool = True,
    ):
        """
        Args:
            method: 'poisson' or 'ball_pivoting'
            depth: Octree depth for Poisson (8-12, higher = more detail)
            target_triangles: Target triangle count after simplification
            clean_mesh: Whether to clean mesh (remove noise, fill holes)
        """
        self.method = method
        self.depth = depth
        self.target_triangles = target_triangles
        self.clean_mesh = clean_mesh
        
        if not HAS_OPEN3D and not HAS_MESHLAB:
            raise ImportError("Neither Open3D nor PyMeshLab available for mesh generation")
        
        print(f"[MeshGeneration] Initialized with method={method}, depth={depth}")
    
    def run(
        self,
        point_cloud_path: Path,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """
        Generate mesh from point cloud.
        
        Args:
            point_cloud_path: Path to PLY point cloud
            output_dir: Directory for output files
        
        Returns:
            Dict with num_vertices, num_faces, mesh_path, dimensions
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        print(f"[MeshGeneration] Loading point cloud from {point_cloud_path}...")
        
        # Prefer PoissonRecon (standalone) - gives best results, same as manual process
        if self.method == "poisson":
            if not HAS_POISSONRECON:
                raise RuntimeError("PoissonRecon is required for poisson mesh generation")
            try:
                return self._run_poissonrecon(point_cloud_path, output_dir)
            except Exception as e:
                raise RuntimeError(f"PoissonRecon failed: {e}") from e
        
        if HAS_OPEN3D:
            return self._run_open3d(point_cloud_path, output_dir)
        elif HAS_MESHLAB:
            return self._run_meshlab(point_cloud_path, output_dir)
        else:
            raise RuntimeError("No mesh generation backend available")
    
    def _run_poissonrecon(
        self,
        point_cloud_path: Path,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """
        Generate mesh using standalone PoissonRecon (Screened Poisson Reconstruction).
        This gives the best results - same as the manual GCP process.
        """
        print("[MeshGeneration] Using PoissonRecon for best quality mesh...")
        
        mesh_raw = output_dir / "meshed_poisson_raw.ply"
        mesh_ply = output_dir / "meshed_poisson.ply"
        poisson_input = self._prepare_poissonrecon_input(point_cloud_path, output_dir)
        
        # Run Screened Poisson Reconstruction
        subprocess.run([
            'PoissonRecon',
            '--in', str(poisson_input),
            '--out', str(mesh_raw),
            '--depth', str(self.depth),
            '--pointWeight', '1',
            '--density',
            '--colors', '32',
        ], check=True)
        
        # Trim low-confidence regions (trim=4: relaxed to keep Poisson-filled wall/mirror areas)
        if shutil.which('SurfaceTrimmer'):
            subprocess.run([
                'SurfaceTrimmer',
                '--in', str(mesh_raw),
                '--out', str(mesh_ply),
                '--trim', '4',
            ], check=True)
        else:
            # No trimmer, use raw mesh
            mesh_ply = mesh_raw
        
        # Load mesh to get stats
        if HAS_OPEN3D:
            mesh = o3d.io.read_triangle_mesh(str(mesh_ply))
            num_vertices = len(mesh.vertices)
            num_faces = len(mesh.triangles)
            
            # Calculate dimensions
            dimensions = self._calculate_dimensions(mesh)
            
            # Also save as OBJ for compatibility
            obj_path = output_dir / "mesh.obj"
            o3d.io.write_triangle_mesh(str(obj_path), mesh)
        else:
            # Count from PLY header
            num_vertices = 0
            num_faces = 0
            with open(mesh_ply, 'rb') as f:
                for line in f:
                    if line.startswith(b'element vertex'):
                        num_vertices = int(line.split()[2])
                    elif line.startswith(b'element face'):
                        num_faces = int(line.split()[2])
                    elif line.startswith(b'end_header'):
                        break
            dimensions = {}
        
        print(f"[MeshGeneration] PoissonRecon complete: {num_vertices:,} vertices, {num_faces:,} faces")
        
        return {
            'num_vertices': num_vertices,
            'num_faces': num_faces,
            'mesh_path': mesh_ply,
            'dimensions': dimensions,
        }

    def _prepare_poissonrecon_input(
        self,
        point_cloud_path: Path,
        output_dir: Path,
    ) -> Path:
        """Ensure the standalone PoissonRecon input has consistent normals."""

        if not HAS_OPEN3D:
            raise RuntimeError("Open3D is required to prepare PoissonRecon input")

        pcd = o3d.io.read_point_cloud(str(point_cloud_path))
        if len(pcd.points) == 0:
            raise ValueError(f"Point cloud is empty: {point_cloud_path}")

        if not pcd.has_normals():
            print("[MeshGeneration] Estimating normals for PoissonRecon input...")
            pcd.estimate_normals(
                search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.1, max_nn=30)
            )

        neighbor_count = min(30, len(pcd.points) - 1)
        if neighbor_count >= 3:
            print("[MeshGeneration] Orienting normals consistently for PoissonRecon...")
            pcd.orient_normals_consistent_tangent_plane(k=neighbor_count)

        prepared_point_cloud_path = output_dir / "poisson_input_with_normals.ply"
        o3d.io.write_point_cloud(str(prepared_point_cloud_path), pcd)
        return prepared_point_cloud_path
    
    def _run_open3d(
        self,
        point_cloud_path: Path,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """Generate mesh using Open3D"""
        
        # Load point cloud
        pcd = o3d.io.read_point_cloud(str(point_cloud_path))
        print(f"[MeshGeneration] Loaded {len(pcd.points)} points")
        
        if len(pcd.points) < 1000:
            raise ValueError(f"Insufficient points: {len(pcd.points)}")
        
        # Preprocessing
        pcd = self._preprocess_pointcloud(pcd)
        
        # Generate mesh
        if self.method == "poisson":
            mesh = self._poisson_reconstruction(pcd)
        elif self.method == "ball_pivoting":
            mesh = self._ball_pivoting(pcd)
        else:
            raise ValueError(f"Unknown method: {self.method}")
        
        # Post-processing
        if self.clean_mesh:
            mesh = self._clean_mesh(mesh)
        
        # Simplify if needed
        if len(mesh.triangles) > self.target_triangles:
            mesh = self._simplify_mesh(mesh, self.target_triangles)
        
        # Calculate dimensions
        dimensions = self._calculate_dimensions(mesh)
        
        # Save mesh
        mesh_path = output_dir / "mesh.ply"
        o3d.io.write_triangle_mesh(str(mesh_path), mesh)
        
        # Also save as OBJ for compatibility
        obj_path = output_dir / "mesh.obj"
        o3d.io.write_triangle_mesh(str(obj_path), mesh)
        
        print(f"[MeshGeneration] Generated mesh: {len(mesh.vertices)} vertices, "
              f"{len(mesh.triangles)} faces")
        
        return {
            'num_vertices': len(mesh.vertices),
            'num_faces': len(mesh.triangles),
            'mesh_path': mesh_path,
            'dimensions': dimensions,
        }
    
    def _run_meshlab(
        self,
        point_cloud_path: Path,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """Generate mesh using PyMeshLab"""
        
        ms = pymeshlab.MeshSet()
        ms.load_new_mesh(str(point_cloud_path))
        
        print(f"[MeshGeneration] Loaded {ms.current_mesh().vertex_number()} points")
        
        # Compute normals
        ms.compute_normal_for_point_clouds(k=30)
        
        # Poisson reconstruction
        if self.method == "poisson":
            ms.generate_surface_reconstruction_screened_poisson(depth=self.depth)
        else:
            # Ball pivoting
            ms.generate_surface_reconstruction_ball_pivoting()
        
        # Clean
        if self.clean_mesh:
            ms.meshing_remove_duplicate_faces()
            ms.meshing_remove_duplicate_vertices()
            ms.meshing_remove_unreferenced_vertices()
            
            # Remove small components
            ms.meshing_remove_connected_component_by_face_number(
                mincomponentsize=100
            )
        
        # Simplify
        current_faces = ms.current_mesh().face_number()
        if current_faces > self.target_triangles:
            ms.meshing_decimation_quadric_edge_collapse(
                targetfacenum=self.target_triangles
            )
        
        # Get dimensions
        bb = ms.current_mesh().bounding_box()
        dimensions = {
            'width': bb.dim_x(),
            'height': bb.dim_y(),
            'depth': bb.dim_z(),
            'min': [bb.min()[0], bb.min()[1], bb.min()[2]],
            'max': [bb.max()[0], bb.max()[1], bb.max()[2]],
        }
        
        # Save
        mesh_path = output_dir / "mesh.ply"
        ms.save_current_mesh(str(mesh_path))
        
        return {
            'num_vertices': ms.current_mesh().vertex_number(),
            'num_faces': ms.current_mesh().face_number(),
            'mesh_path': mesh_path,
            'dimensions': dimensions,
        }
    
    def _preprocess_pointcloud(self, pcd: 'o3d.geometry.PointCloud') -> 'o3d.geometry.PointCloud':
        """Preprocess point cloud for meshing"""
        
        # Remove statistical outliers
        pcd, _ = pcd.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
        print(f"[MeshGeneration] After outlier removal: {len(pcd.points)} points")
        
        # Estimate normals if not present
        if not pcd.has_normals():
            print("[MeshGeneration] Estimating normals...")
            pcd.estimate_normals(
                search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.1, max_nn=30)
            )
            
            # Orient normals consistently
            pcd.orient_normals_consistent_tangent_plane(k=30)
        
        return pcd
    
    def _poisson_reconstruction(self, pcd: 'o3d.geometry.PointCloud') -> 'o3d.geometry.TriangleMesh':
        """Screened Poisson Surface Reconstruction"""
        
        print(f"[MeshGeneration] Running Poisson reconstruction (depth={self.depth})...")
        
        mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
            pcd,
            depth=self.depth,
            width=0,
            scale=1.1,
            linear_fit=False,
        )
        
        # Remove low-density vertices (outlier regions)
        densities = np.asarray(densities)
        density_threshold = np.quantile(densities, 0.01)
        vertices_to_remove = densities < density_threshold
        mesh.remove_vertices_by_mask(vertices_to_remove)
        
        return mesh
    
    def _ball_pivoting(self, pcd: 'o3d.geometry.PointCloud') -> 'o3d.geometry.TriangleMesh':
        """Ball Pivoting Algorithm"""
        
        # Estimate ball radii based on point spacing
        distances = pcd.compute_nearest_neighbor_distance()
        avg_dist = np.mean(distances)
        radii = [avg_dist * 2, avg_dist * 4, avg_dist * 8]
        
        print(f"[MeshGeneration] Running Ball Pivoting (radii={radii})...")
        
        mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(
            pcd,
            o3d.utility.DoubleVector(radii)
        )
        
        return mesh
    
    def _clean_mesh(self, mesh: 'o3d.geometry.TriangleMesh') -> 'o3d.geometry.TriangleMesh':
        """Clean mesh: remove duplicates, non-manifold edges, etc."""
        
        print("[MeshGeneration] Cleaning mesh...")
        
        # Remove degenerate triangles
        mesh.remove_degenerate_triangles()
        
        # Remove duplicates
        mesh.remove_duplicated_triangles()
        mesh.remove_duplicated_vertices()
        
        # Remove non-manifold edges
        mesh.remove_non_manifold_edges()
        
        # Remove unreferenced vertices
        mesh.remove_unreferenced_vertices()
        
        # Smooth
        mesh = mesh.filter_smooth_laplacian(number_of_iterations=3)
        
        # Recompute normals
        mesh.compute_vertex_normals()
        
        return mesh
    
    def _simplify_mesh(
        self, 
        mesh: 'o3d.geometry.TriangleMesh',
        target_triangles: int,
    ) -> 'o3d.geometry.TriangleMesh':
        """Simplify mesh using quadric decimation"""
        
        print(f"[MeshGeneration] Simplifying from {len(mesh.triangles)} to {target_triangles} triangles...")
        
        mesh = mesh.simplify_quadric_decimation(target_number_of_triangles=target_triangles)
        mesh.compute_vertex_normals()
        
        return mesh
    
    def _calculate_dimensions(self, mesh: 'o3d.geometry.TriangleMesh') -> Dict[str, float]:
        """Calculate mesh bounding box dimensions"""
        
        bbox = mesh.get_axis_aligned_bounding_box()
        extent = bbox.get_extent()
        center = bbox.get_center()
        
        return {
            'width': float(extent[0]),
            'height': float(extent[1]),
            'depth': float(extent[2]),
            'center': [float(c) for c in center],
            'min': [float(c) for c in bbox.min_bound],
            'max': [float(c) for c in bbox.max_bound],
            'volume': float(extent[0] * extent[1] * extent[2]),
        }


class MeshSegmentation:
    """Segment mesh into individual objects"""
    
    def __init__(self):
        if not HAS_OPEN3D:
            raise ImportError("Open3D required for mesh segmentation")
    
    def segment_by_connectivity(
        self,
        mesh: 'o3d.geometry.TriangleMesh',
        min_triangles: int = 100,
    ) -> List['o3d.geometry.TriangleMesh']:
        """Segment mesh by connected components"""
        
        # Get connected components
        triangle_clusters, cluster_n_triangles, cluster_area = (
            mesh.cluster_connected_triangles()
        )
        
        triangle_clusters = np.asarray(triangle_clusters)
        cluster_n_triangles = np.asarray(cluster_n_triangles)
        
        # Filter small components
        large_clusters = cluster_n_triangles >= min_triangles
        
        segments = []
        for cluster_id in np.where(large_clusters)[0]:
            mask = triangle_clusters == cluster_id
            segment = mesh.select_by_index(np.where(mask)[0])
            segments.append(segment)
        
        return segments
    
    def segment_by_plane(
        self,
        mesh: 'o3d.geometry.TriangleMesh',
        distance_threshold: float = 0.02,
    ) -> Tuple['o3d.geometry.TriangleMesh', List['o3d.geometry.TriangleMesh']]:
        """
        Segment mesh into planar (walls/floor/ceiling) and non-planar (furniture) regions.
        """
        
        # Convert to point cloud for plane segmentation
        pcd = mesh.sample_points_uniformly(number_of_points=100000)
        
        planes = []
        non_planar_indices = set(range(len(pcd.points)))
        
        remaining_pcd = pcd
        
        for _ in range(10):  # Find up to 10 planes
            if len(remaining_pcd.points) < 1000:
                break
            
            plane_model, inliers = remaining_pcd.segment_plane(
                distance_threshold=distance_threshold,
                ransac_n=3,
                num_iterations=1000,
            )
            
            if len(inliers) < 500:  # Minimum plane size
                break
            
            # Extract plane
            plane = remaining_pcd.select_by_index(inliers)
            planes.append(plane)
            
            # Remove plane points
            remaining_pcd = remaining_pcd.select_by_index(inliers, invert=True)
        
        # Non-planar is what remains
        non_planar = remaining_pcd
        
        return planes, non_planar


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Generate mesh from point cloud')
    parser.add_argument('point_cloud', help='Path to PLY point cloud')
    parser.add_argument('--output', '-o', default='./mesh_output')
    parser.add_argument('--method', default='poisson', choices=['poisson', 'ball_pivoting'])
    parser.add_argument('--depth', type=int, default=10)
    parser.add_argument('--target-triangles', type=int, default=500000)
    
    args = parser.parse_args()
    
    generator = MeshGenerator(
        method=args.method,
        depth=args.depth,
        target_triangles=args.target_triangles,
    )
    
    result = generator.run(
        Path(args.point_cloud),
        Path(args.output),
    )
    
    print(f"\nMesh Generation Results:")
    print(f"  Vertices: {result['num_vertices']}")
    print(f"  Faces: {result['num_faces']}")
    print(f"  Dimensions: {result['dimensions']}")
    print(f"  Output: {result['mesh_path']}")
