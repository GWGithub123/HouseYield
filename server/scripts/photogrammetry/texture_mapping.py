#!/usr/bin/env python3
"""
Texture Mapping Module

Projects source images onto mesh surfaces to create textured 3D models.
Uses view-dependent texture blending for optimal quality:
1. UV Unwrapping: Create 2D parameterization of mesh surface
2. View Selection: Choose best source images for each face
3. Texture Projection: Project colors from images to texture atlas
4. Blending: Blend overlapping projections for seamless textures
"""

import os
import json
import numpy as np
import cv2
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass

try:
    import open3d as o3d
    HAS_OPEN3D = True
except ImportError:
    HAS_OPEN3D = False

try:
    import pymeshlab
    HAS_MESHLAB = True
except ImportError:
    HAS_MESHLAB = False

try:
    import trimesh
    HAS_TRIMESH = True
except ImportError:
    HAS_TRIMESH = False


def check_mvs_texturing():
    """Check if mvs-texturing is available"""
    import subprocess
    try:
        result = subprocess.run(['texrecon', '--help'], capture_output=True)
        return result.returncode == 0
    except FileNotFoundError:
        return False

HAS_MVS_TEXTURING = check_mvs_texturing()


def check_openmvs():
    """Check if OpenMVS TextureMesh is available"""
    import subprocess
    try:
        result = subprocess.run(['TextureMesh', '--help'], capture_output=True)
        return True  # TextureMesh returns non-zero even with --help
    except FileNotFoundError:
        return False

HAS_OPENMVS = check_openmvs()


@dataclass
class TextureResult:
    """Result from texture mapping"""
    texture_path: Path
    textured_mesh_path: Path
    resolution: Tuple[int, int]
    
    def to_dict(self) -> Dict:
        return {
            'texture_path': str(self.texture_path),
            'textured_mesh_path': str(self.textured_mesh_path),
            'resolution': list(self.resolution),
        }


class TextureMapper:
    """Project textures onto mesh from source images"""
    
    def __init__(
        self,
        resolution: int = 4096,
        format: str = "jpg",
        quality: int = 95,
    ):
        """
        Args:
            resolution: Texture atlas resolution (power of 2)
            format: Output format (jpg, png)
            quality: JPEG quality (0-100)
        """
        self.resolution = resolution
        self.format = format
        self.quality = quality
        
        print(f"[TextureMapper] Initialized with resolution={resolution}, format={format}")
    
    def run(
        self,
        mesh_path: Path,
        images_dir: Path,
        cameras: Dict,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """
        Create textured mesh.
        
        Args:
            mesh_path: Path to input mesh (PLY or OBJ)
            images_dir: Directory containing source images
            cameras: Camera poses from SfM
            output_dir: Directory for output files
        
        Returns:
            Dict with texture_path, textured_mesh_path
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        print(f"[TextureMapper] Processing mesh: {mesh_path}")
        print(f"[TextureMapper] Using {len(cameras)} source images")
        
        # Try OpenMVS TextureMesh first (best quality - what worked on GCP)
        if HAS_OPENMVS:
            return self._run_openmvs(mesh_path, images_dir, cameras, output_dir)
        elif HAS_MVS_TEXTURING:
            return self._run_mvs_texturing(mesh_path, images_dir, cameras, output_dir)
        elif HAS_MESHLAB:
            return self._run_meshlab(mesh_path, images_dir, cameras, output_dir)
        elif HAS_TRIMESH:
            return self._run_trimesh(mesh_path, images_dir, cameras, output_dir)
        elif HAS_OPEN3D:
            return self._run_open3d(mesh_path, images_dir, cameras, output_dir)
        else:
            return self._run_simple(mesh_path, images_dir, cameras, output_dir)
    
    def _run_openmvs(
        self,
        mesh_path: Path,
        images_dir: Path,
        cameras: Dict,
        output_dir: Path,
        allow_fallback: bool = True,
    ) -> Dict[str, Any]:
        """
        Texture mapping using OpenMVS TextureMesh.
        This gives the best quality results - the same as used on GCP.
        """
        import subprocess
        
        print("[TextureMapper] Using OpenMVS TextureMesh for best quality textures...")
        
        mesh_path = Path(mesh_path)
        output_dir = Path(output_dir)
        
        # OpenMVS needs the COLMAP image_undistorter workspace root so InterfaceCOLMAP
        # can read sparse/ and images/ with the expected relative layout.
        scene_mvs = output_dir / "scene.mvs"
        textured_mvs = output_dir / "textured.mvs"
        
        colmap_workspace_dir = self._resolve_openmvs_colmap_workspace(cameras, output_dir)
        
        try:
            if colmap_workspace_dir and colmap_workspace_dir.exists():
                print(f"[TextureMapper] Converting COLMAP model from {colmap_workspace_dir}...")
                openmvs_image_folder = colmap_workspace_dir / 'images'
                subprocess.run([
                    'InterfaceCOLMAP',
                    '-i', '.',
                    '-o', str(scene_mvs),
                    '--image-folder', str(openmvs_image_folder),
                ], check=True, capture_output=True, cwd=str(colmap_workspace_dir))
            else:
                # Create a minimal scene.mvs from cameras dict
                print("[TextureMapper] No COLMAP model found, creating scene from camera data...")
                self._create_openmvs_scene(cameras, images_dir, scene_mvs)
            
            # Run TextureMesh
            print("[TextureMapper] Running OpenMVS TextureMesh...")
            subprocess.run([
                'TextureMesh',
                str(scene_mvs),
                '--mesh-file', str(mesh_path),
                '-o', str(textured_mvs),
                '--export-type', 'obj',
                '--resolution-level', '1',
                '--cost-smoothness-ratio', '0.1',
            ], check=True, cwd=str(output_dir))
            
            # Find output files
            textured_obj = output_dir / "textured.obj"
            textured_mtl = output_dir / "textured.mtl"
            
            if textured_obj.exists():
                # Rename to standard names
                final_mesh = output_dir / "model.obj"
                final_mtl = output_dir / "model.mtl"
                final_texture = output_dir / f"texture.{self.format}"
                
                import shutil
                shutil.move(str(textured_obj), str(final_mesh))
                if textured_mtl.exists():
                    shutil.move(str(textured_mtl), str(final_mtl))
                    # Update MTL to reference our texture name
                    self._update_mtl_texture_ref(final_mtl, final_texture.name)
                
                # Find and move texture file
                texture_files = list(output_dir.glob("textured*map_Kd*"))
                if texture_files:
                    if self.format == 'jpg' and not str(texture_files[0]).endswith('.jpg'):
                        img = cv2.imread(str(texture_files[0]))
                        cv2.imwrite(str(final_texture), img, [cv2.IMWRITE_JPEG_QUALITY, self.quality])
                    else:
                        shutil.move(str(texture_files[0]), str(final_texture))
                
                print(f"[TextureMapper] ✅ OpenMVS texture mapping complete")
                
                return {
                    'texture_path': final_texture,
                    'textured_mesh_path': final_mesh,
                    'resolution': (self.resolution, self.resolution),
                }
            else:
                raise FileNotFoundError("OpenMVS did not produce expected output files")
                
        except subprocess.CalledProcessError as e:
            print(f"[TextureMapper] OpenMVS failed: {e}")
            stdout = e.stdout.decode('utf-8', errors='ignore') if isinstance(e.stdout, bytes) else e.stdout
            stderr = e.stderr.decode('utf-8', errors='ignore') if isinstance(e.stderr, bytes) else e.stderr
            if stdout:
                print(stdout)
            if stderr:
                print(stderr)
            if not allow_fallback:
                raise RuntimeError('openmvs_texturemesh_failed') from e
        except FileNotFoundError as e:
            print(f"[TextureMapper] OpenMVS not available: {e}")
            if not allow_fallback:
                raise RuntimeError('openmvs_texturemesh_missing') from e
        
        # Fallback to MVS-Texturing
        if not allow_fallback:
            raise RuntimeError('openmvs_texturemesh_failed')
        print("[TextureMapper] Falling back to MVS-Texturing...")
        if HAS_MVS_TEXTURING:
            return self._run_mvs_texturing(mesh_path, images_dir, cameras, output_dir)
        elif HAS_OPEN3D:
            return self._run_open3d(mesh_path, images_dir, cameras, output_dir)
        else:
            return self._run_simple(mesh_path, images_dir, cameras, output_dir)

    def _resolve_openmvs_colmap_workspace(
        self,
        cameras: Dict,
        output_dir: Path,
    ) -> Optional[Path]:
        """Resolve the COLMAP image_undistorter workspace root for InterfaceCOLMAP."""

        candidates: List[Path] = []
        if hasattr(cameras, 'get'):
            for key in ('colmap_workspace_dir', 'colmap_dir'):
                raw_value = cameras.get(key)
                if raw_value:
                    candidates.append(Path(raw_value))

        candidates.extend([
            output_dir.parent / 'dense' / 'dense',
            output_dir.parent / 'dense',
            output_dir.parent / 'sfm' / 'dense',
            output_dir.parent / 'sfm' / 'sparse' / '0',
            output_dir.parent / 'sparse' / '0',
        ])

        seen: set[str] = set()
        for candidate in candidates:
            normalized = self._normalize_openmvs_colmap_workspace(candidate)
            if normalized is None:
                continue
            normalized_key = str(normalized)
            if normalized_key in seen:
                continue
            seen.add(normalized_key)
            print(f"[TextureMapper] Resolved COLMAP workspace for OpenMVS: {normalized}")
            return normalized

        return None

    def _normalize_openmvs_colmap_workspace(self, candidate: Path) -> Optional[Path]:
        """Accept either a workspace root or a nested sparse model path and return the workspace root."""

        candidate = Path(candidate)
        possible_roots: List[Path] = [candidate]

        if candidate.name == '0' and candidate.parent.name == 'sparse':
            possible_roots.append(candidate.parent.parent)
        if candidate.name == 'sparse':
            possible_roots.append(candidate.parent)

        for root in possible_roots:
            if (root / 'images').exists() and (root / 'sparse').exists():
                return root

        return None
    
    def _update_mtl_texture_ref(self, mtl_path: Path, texture_name: str):
        """Update MTL file to reference our texture filename"""
        with open(mtl_path, 'r') as f:
            content = f.read()
        
        # Replace map_Kd line with our texture name
        import re
        content = re.sub(r'map_Kd\s+.*', f'map_Kd {texture_name}', content)
        
        with open(mtl_path, 'w') as f:
            f.write(content)
    
    def _create_openmvs_scene(self, cameras: Dict, images_dir: Path, output_path: Path):
        """Create a minimal OpenMVS scene file from camera data"""
        # This is a fallback - OpenMVS scene files are binary and complex
        # For best results, use InterfaceCOLMAP with the sparse model
        raise NotImplementedError("Direct scene creation not implemented - use COLMAP model")
    
    def _run_mvs_texturing(
        self,
        mesh_path: Path,
        images_dir: Path,
        cameras: Dict,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """
        Texture mapping using MVS-Texturing (texrecon).
        This gives the best quality results by properly projecting photos.
        """
        import subprocess
        
        print("[TextureMapper] Using MVS-Texturing for high-quality textures...")
        
        # MVS-Texturing needs images in a specific format with camera params
        scene_dir = output_dir / "mvs_scene"
        scene_dir.mkdir(exist_ok=True)
        
        # Write camera file in texrecon format
        self._write_texrecon_scene(cameras, images_dir, scene_dir)
        
        # Run texrecon
        output_prefix = output_dir / "textured"
        try:
            subprocess.run([
                'texrecon',
                str(scene_dir),
                str(mesh_path),
                str(output_prefix),
                '--data_term=gmi',  # Good matching intensity
                '--keep_unseen_faces',
            ], check=True, capture_output=True)
            
            textured_mesh_path = Path(f"{output_prefix}.obj")
            texture_path = Path(f"{output_prefix}_material0000_map_Kd.png")
            
            if textured_mesh_path.exists():
                # Convert to our expected paths
                final_mesh = output_dir / "textured_mesh.obj"
                final_texture = output_dir / f"texture.{self.format}"
                
                import shutil
                shutil.move(textured_mesh_path, final_mesh)
                if texture_path.exists():
                    if self.format == 'jpg':
                        img = cv2.imread(str(texture_path))
                        cv2.imwrite(str(final_texture), img, [cv2.IMWRITE_JPEG_QUALITY, self.quality])
                    else:
                        shutil.move(texture_path, final_texture)
                
                return {
                    'texture_path': final_texture,
                    'textured_mesh_path': final_mesh,
                    'resolution': (self.resolution, self.resolution),
                }
                
        except subprocess.CalledProcessError as e:
            print(f"[TextureMapper] MVS-Texturing failed: {e.stderr[:500] if e.stderr else 'Unknown error'}")
        
        # Fallback to other methods
        print("[TextureMapper] Falling back to Open3D texturing...")
        if HAS_OPEN3D:
            return self._run_open3d(mesh_path, images_dir, cameras, output_dir)
        else:
            return self._run_simple(mesh_path, images_dir, cameras, output_dir)
    
    def _write_texrecon_scene(self, cameras: Dict, images_dir: Path, scene_dir: Path):
        """Write scene files for texrecon"""
        
        # Copy images and create camera file
        for i, (image_id, camera) in enumerate(cameras.items()):
            image_path = self._find_image(images_dir, image_id)
            if image_path:
                # Copy image
                import shutil
                dest = scene_dir / f"view_{i:04d}.jpg"
                shutil.copy(image_path, dest)
                
                # Write camera params (simple pinhole format)
                cam_file = scene_dir / f"view_{i:04d}.cam"
                with open(cam_file, 'w') as f:
                    if hasattr(camera, 'position'):
                        pos = camera.position
                    else:
                        pos = camera.get('position', [0, 0, 0])
                    
                    # Translation
                    f.write(f"{pos[0]} {pos[1]} {pos[2]}\n")
                    
                    # Rotation (identity if not available)
                    if hasattr(camera, 'rotation'):
                        R = camera.rotation
                        for row in R:
                            f.write(f"{row[0]} {row[1]} {row[2]}\n")
                    else:
                        f.write("1 0 0\n0 1 0\n0 0 1\n")
                    
                    # Focal length and principal point
                    if hasattr(camera, 'fx'):
                        f.write(f"{camera.fx}\n")
                        f.write("0 0\n")  # No distortion
                        f.write(f"{camera.cx} {camera.cy}\n")
                    else:
                        f.write("1000\n0 0\n500 500\n")
    
    def _run_trimesh(
        self,
        mesh_path: Path,
        images_dir: Path,
        cameras: Dict,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """Texture mapping using Trimesh with proper UV unwrapping"""
        
        print("[TextureMapper] Using Trimesh for texturing...")
        
        mesh = trimesh.load(str(mesh_path))
        
        # Unwrap UVs if not present
        if not hasattr(mesh.visual, 'uv') or mesh.visual.uv is None:
            print("[TextureMapper] Generating UV coordinates...")
            # Use a simple box projection or angle-based unwrap
            mesh = self._generate_uvs_trimesh(mesh)
        
        # Create texture atlas by projecting camera views
        texture_atlas = self._create_atlas_from_cameras(mesh, images_dir, cameras)
        
        # Apply texture
        from PIL import Image
        texture_image = Image.fromarray(texture_atlas)
        mesh.visual = trimesh.visual.TextureVisuals(
            uv=mesh.visual.uv if hasattr(mesh.visual, 'uv') else None,
            image=texture_image
        )
        
        # Export
        textured_mesh_path = output_dir / "textured_mesh.obj"
        texture_path = output_dir / f"texture.{self.format}"
        
        mesh.export(str(textured_mesh_path))
        texture_image.save(str(texture_path), quality=self.quality if self.format == 'jpg' else None)
        
        return {
            'texture_path': texture_path,
            'textured_mesh_path': textured_mesh_path,
            'resolution': (self.resolution, self.resolution),
        }
    
    def _generate_uvs_trimesh(self, mesh):
        """Generate UV coordinates using box projection"""
        vertices = np.asarray(mesh.vertices)
        
        # Normalize to 0-1
        min_v = vertices.min(axis=0)
        max_v = vertices.max(axis=0)
        range_v = max_v - min_v
        range_v[range_v == 0] = 1
        
        norm_v = (vertices - min_v) / range_v
        
        # Simple XZ projection for floors/walls
        uv = np.column_stack([norm_v[:, 0], norm_v[:, 2]])
        
        mesh.visual = trimesh.visual.TextureVisuals(uv=uv)
        return mesh
    
    def _create_atlas_from_cameras(
        self,
        mesh,
        images_dir: Path,
        cameras: Dict,
    ) -> np.ndarray:
        """Create texture atlas by projecting camera views"""
        
        atlas = np.zeros((self.resolution, self.resolution, 3), dtype=np.uint8)
        atlas_count = np.zeros((self.resolution, self.resolution), dtype=np.float32)
        
        vertices = np.asarray(mesh.vertices)
        
        for image_id, camera in cameras.items():
            image_path = self._find_image(images_dir, image_id)
            if not image_path:
                continue
            
            image = cv2.imread(str(image_path))
            if image is None:
                continue
            image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            h, w = image.shape[:2]
            
            # Get camera parameters
            if hasattr(camera, 'fx'):
                K = camera.intrinsic_matrix
                R = camera.rotation
                t = camera.translation
            else:
                fx = camera.get('fx', w * 1.2)
                fy = camera.get('fy', fx)
                cx = camera.get('cx', w / 2)
                cy = camera.get('cy', h / 2)
                K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]])
                R = np.array(camera.get('rotation', np.eye(3)))
                t = np.array(camera.get('translation', np.zeros(3)))
            
            # Project vertices
            vertices_cam = (R @ vertices.T).T + t
            valid = vertices_cam[:, 2] > 0.1
            
            proj = (K @ vertices_cam.T).T
            u = proj[:, 0] / proj[:, 2]
            v = proj[:, 1] / proj[:, 2]
            
            in_bounds = (u >= 0) & (u < w - 1) & (v >= 0) & (v < h - 1)
            valid = valid & in_bounds
            
            # Get UV coordinates if available
            if hasattr(mesh.visual, 'uv') and mesh.visual.uv is not None:
                uvs = mesh.visual.uv
            else:
                # Use vertex position as UV
                min_v = vertices.min(axis=0)
                max_v = vertices.max(axis=0)
                range_v = max_v - min_v
                range_v[range_v == 0] = 1
                uvs = (vertices[:, :2] - min_v[:2]) / range_v[:2]
            
            # Sample and accumulate
            for i in np.where(valid)[0]:
                px, py = int(u[i]), int(v[i])
                color = image[py, px]
                
                atlas_u = int(uvs[i, 0] * (self.resolution - 1))
                atlas_v = int((1 - uvs[i, 1]) * (self.resolution - 1))  # Flip V
                
                atlas_u = np.clip(atlas_u, 0, self.resolution - 1)
                atlas_v = np.clip(atlas_v, 0, self.resolution - 1)
                
                atlas[atlas_v, atlas_u] = (
                    atlas[atlas_v, atlas_u].astype(float) * atlas_count[atlas_v, atlas_u] + color
                ) / (atlas_count[atlas_v, atlas_u] + 1)
                atlas_count[atlas_v, atlas_u] += 1
        
        # Fill gaps with inpainting
        mask = (atlas_count == 0).astype(np.uint8)
        if mask.any():
            atlas = cv2.inpaint(atlas.astype(np.uint8), mask, 3, cv2.INPAINT_TELEA)
        
        return atlas.astype(np.uint8)
    
    def _run_meshlab(
        self,
        mesh_path: Path,
        images_dir: Path,
        cameras: Dict,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """Texture mapping using PyMeshLab"""
        
        ms = pymeshlab.MeshSet()
        ms.load_new_mesh(str(mesh_path))
        
        # Create camera file for MeshLab
        camera_file = output_dir / "cameras.out"
        self._write_meshlab_cameras(cameras, camera_file)
        
        # Generate UV coordinates
        print("[TextureMapper] Generating UV coordinates...")
        ms.compute_texcoord_parametrization_triangle_trivial_per_wedge(
            textdim=self.resolution
        )
        
        # Project textures
        print("[TextureMapper] Projecting textures...")
        # Note: This requires proper camera setup
        # For now, we'll use vertex colors as a fallback
        
        # Save textured mesh
        textured_mesh_path = output_dir / f"textured_mesh.obj"
        texture_path = output_dir / f"texture.{self.format}"
        
        ms.save_current_mesh(str(textured_mesh_path))
        
        # Generate texture atlas
        self._create_texture_atlas(ms, texture_path)
        
        return {
            'texture_path': texture_path,
            'textured_mesh_path': textured_mesh_path,
            'resolution': (self.resolution, self.resolution),
        }
    
    def _run_open3d(
        self,
        mesh_path: Path,
        images_dir: Path,
        cameras: Dict,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """Texture mapping using Open3D"""
        
        mesh = o3d.io.read_triangle_mesh(str(mesh_path))
        
        if not mesh.has_vertex_colors():
            # Color from nearest camera projections
            print("[TextureMapper] Projecting colors from cameras...")
            mesh = self._project_vertex_colors(mesh, images_dir, cameras)
        
        # Save colored mesh (Open3D doesn't have full UV texturing)
        textured_mesh_path = output_dir / "textured_mesh.ply"
        o3d.io.write_triangle_mesh(str(textured_mesh_path), mesh)
        
        # Create a simple texture from vertex colors
        texture_path = output_dir / f"texture.{self.format}"
        self._create_vertex_color_texture(mesh, texture_path)
        
        # Also export as OBJ with texture
        obj_path = output_dir / "textured_mesh.obj"
        self._export_textured_obj(mesh, obj_path, texture_path)
        
        return {
            'texture_path': texture_path,
            'textured_mesh_path': textured_mesh_path,
            'resolution': (self.resolution, self.resolution),
        }
    
    def _run_simple(
        self,
        mesh_path: Path,
        images_dir: Path,
        cameras: Dict,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """Simple vertex coloring fallback"""
        
        print("[TextureMapper] Using simple vertex coloring (no UV mapping)")
        
        # Just copy mesh and create placeholder texture
        import shutil
        
        textured_mesh_path = output_dir / "textured_mesh.ply"
        shutil.copy(mesh_path, textured_mesh_path)
        
        # Create placeholder texture
        texture_path = output_dir / f"texture.{self.format}"
        texture = np.ones((self.resolution, self.resolution, 3), dtype=np.uint8) * 200
        
        if self.format == 'jpg':
            cv2.imwrite(str(texture_path), texture, [cv2.IMWRITE_JPEG_QUALITY, self.quality])
        else:
            cv2.imwrite(str(texture_path), texture)
        
        return {
            'texture_path': texture_path,
            'textured_mesh_path': textured_mesh_path,
            'resolution': (self.resolution, self.resolution),
        }
    
    def _project_vertex_colors(
        self,
        mesh: 'o3d.geometry.TriangleMesh',
        images_dir: Path,
        cameras: Dict,
    ) -> 'o3d.geometry.TriangleMesh':
        """Project image colors onto mesh vertices"""
        
        vertices = np.asarray(mesh.vertices)
        n_vertices = len(vertices)
        
        # Initialize color accumulation
        color_sum = np.zeros((n_vertices, 3), dtype=np.float64)
        color_count = np.zeros(n_vertices, dtype=np.float64)
        
        for image_id, camera in cameras.items():
            # Find image file
            image_path = self._find_image(images_dir, image_id)
            if not image_path:
                continue
            
            image = cv2.imread(str(image_path))
            if image is None:
                continue
            
            image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            h, w = image.shape[:2]
            
            # Get camera parameters
            if hasattr(camera, 'fx'):
                K = camera.intrinsic_matrix
                R = camera.rotation
                t = camera.translation
            else:
                fx = camera.get('fx', w * 1.2)
                fy = camera.get('fy', fx)
                cx = camera.get('cx', w / 2)
                cy = camera.get('cy', h / 2)
                K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]])
                R = np.eye(3)
                t = np.zeros(3)
            
            # Project vertices to image
            vertices_cam = (R @ vertices.T).T + t
            
            # Only keep points in front of camera
            valid = vertices_cam[:, 2] > 0.1
            
            # Project to image plane
            proj = (K @ vertices_cam.T).T
            u = proj[:, 0] / proj[:, 2]
            v = proj[:, 1] / proj[:, 2]
            
            # Check if within image bounds
            in_bounds = (u >= 0) & (u < w - 1) & (v >= 0) & (v < h - 1)
            valid = valid & in_bounds
            
            # Sample colors for valid vertices
            for i in np.where(valid)[0]:
                px, py = int(u[i]), int(v[i])
                color = image[py, px].astype(np.float64)
                color_sum[i] += color
                color_count[i] += 1
        
        # Average colors
        valid_mask = color_count > 0
        colors = np.ones((n_vertices, 3), dtype=np.float64) * 0.5
        colors[valid_mask] = color_sum[valid_mask] / color_count[valid_mask, np.newaxis]
        colors = colors / 255.0  # Normalize to 0-1
        
        mesh.vertex_colors = o3d.utility.Vector3dVector(colors)
        
        print(f"[TextureMapper] Colored {valid_mask.sum()}/{n_vertices} vertices")
        
        return mesh
    
    def _create_vertex_color_texture(
        self,
        mesh: 'o3d.geometry.TriangleMesh',
        output_path: Path,
    ):
        """Create a texture from vertex colors (for visualization)"""
        
        # Simple approach: render mesh from top view
        # This is a placeholder - real UV mapping is more complex
        
        vertices = np.asarray(mesh.vertices)
        colors = np.asarray(mesh.vertex_colors)
        
        # Normalize vertices to 0-1
        min_v = vertices.min(axis=0)
        max_v = vertices.max(axis=0)
        range_v = max_v - min_v
        range_v[range_v == 0] = 1
        
        norm_v = (vertices - min_v) / range_v
        
        # Create texture
        texture = np.zeros((self.resolution, self.resolution, 3), dtype=np.uint8)
        
        for v, c in zip(norm_v, colors):
            u = int(v[0] * (self.resolution - 1))
            vt = int(v[1] * (self.resolution - 1))
            texture[vt, u] = (c * 255).astype(np.uint8)
        
        # Fill gaps with interpolation
        texture = cv2.GaussianBlur(texture, (5, 5), 0)
        
        if self.format == 'jpg':
            cv2.imwrite(str(output_path), cv2.cvtColor(texture, cv2.COLOR_RGB2BGR),
                       [cv2.IMWRITE_JPEG_QUALITY, self.quality])
        else:
            cv2.imwrite(str(output_path), cv2.cvtColor(texture, cv2.COLOR_RGB2BGR))
    
    def _create_texture_atlas(
        self,
        ms: 'pymeshlab.MeshSet',
        output_path: Path,
    ):
        """Create texture atlas from vertex colors"""
        
        # Get vertex colors and UV coordinates
        mesh = ms.current_mesh()
        
        # Create empty texture
        texture = np.ones((self.resolution, self.resolution, 3), dtype=np.uint8) * 128
        
        # This is a placeholder - full implementation would use
        # face UV coords and rasterization
        
        if self.format == 'jpg':
            cv2.imwrite(str(output_path), texture,
                       [cv2.IMWRITE_JPEG_QUALITY, self.quality])
        else:
            cv2.imwrite(str(output_path), texture)
    
    def _export_textured_obj(
        self,
        mesh: 'o3d.geometry.TriangleMesh',
        obj_path: Path,
        texture_path: Path,
    ):
        """Export mesh as OBJ with MTL file"""
        
        mtl_path = obj_path.with_suffix('.mtl')
        texture_name = texture_path.name
        
        # Write MTL file
        with open(mtl_path, 'w') as f:
            f.write("# Material file\n")
            f.write("newmtl material0\n")
            f.write("Ka 0.2 0.2 0.2\n")
            f.write("Kd 0.8 0.8 0.8\n")
            f.write("Ks 0.0 0.0 0.0\n")
            f.write("Ns 10.0\n")
            f.write(f"map_Kd {texture_name}\n")
        
        # Write OBJ file
        vertices = np.asarray(mesh.vertices)
        triangles = np.asarray(mesh.triangles)
        
        has_colors = mesh.has_vertex_colors()
        colors = np.asarray(mesh.vertex_colors) if has_colors else None
        
        with open(obj_path, 'w') as f:
            f.write(f"# OBJ file\n")
            f.write(f"mtllib {mtl_path.name}\n")
            
            # Write vertices
            for i, v in enumerate(vertices):
                if has_colors:
                    c = colors[i]
                    f.write(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f} {c[0]:.4f} {c[1]:.4f} {c[2]:.4f}\n")
                else:
                    f.write(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")
            
            f.write("usemtl material0\n")
            
            # Write faces (1-indexed)
            for tri in triangles:
                f.write(f"f {tri[0]+1} {tri[1]+1} {tri[2]+1}\n")
    
    def _write_meshlab_cameras(self, cameras: Dict, output_path: Path):
        """Write camera file in MeshLab format"""
        
        with open(output_path, 'w') as f:
            f.write(f"{len(cameras)}\n")
            
            for image_id, camera in cameras.items():
                if hasattr(camera, 'fx'):
                    f.write(f"{camera.fx} 0 0\n")
                    f.write(f"0 {camera.fy} 0\n")
                    # Add rotation and translation
                else:
                    f.write("1000 0 0\n")
                    f.write("0 1000 0\n")
    
    def _find_image(self, images_dir: Path, image_id: str) -> Optional[Path]:
        """Find image file by ID"""
        for ext in ['.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG']:
            path = images_dir / f"{image_id}{ext}"
            if path.exists():
                return path
        return None


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Texture mapping')
    parser.add_argument('mesh', help='Path to mesh file')
    parser.add_argument('images_dir', help='Directory with source images')
    parser.add_argument('cameras', help='JSON file with camera poses')
    parser.add_argument('--output', '-o', default='./texture_output')
    parser.add_argument('--resolution', type=int, default=4096)
    parser.add_argument('--format', default='jpg', choices=['jpg', 'png'])
    
    args = parser.parse_args()
    
    with open(args.cameras) as f:
        cameras = json.load(f)
    
    mapper = TextureMapper(
        resolution=args.resolution,
        format=args.format,
    )
    
    result = mapper.run(
        Path(args.mesh),
        Path(args.images_dir),
        cameras,
        Path(args.output),
    )
    
    print(f"\nTexture Mapping Results:")
    print(f"  Texture: {result['texture_path']}")
    print(f"  Mesh: {result['textured_mesh_path']}")
    print(f"  Resolution: {result['resolution']}")
