#!/usr/bin/env python3
"""
Mesh Export Module

Exports processed meshes to various formats for use in different contexts:
- GLB/GLTF: Web-compatible 3D format (Three.js, Babylon.js)
- OBJ: Universal 3D format with MTL materials
- PLY: Point cloud and mesh format
- STL: 3D printing format
- USD: Universal Scene Description (AR/VR)

GLB is recommended for web viewers as it:
- Is binary (smaller file size)
- Embeds textures
- Has wide browser support via Three.js
"""

import os
import json
import shutil
import struct
import base64
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass
import numpy as np

try:
    import open3d as o3d
    HAS_OPEN3D = True
except ImportError:
    HAS_OPEN3D = False

try:
    import trimesh
    HAS_TRIMESH = True
except ImportError:
    HAS_TRIMESH = False


@dataclass
class ExportResult:
    """Result from mesh export"""
    format: str
    path: Path
    file_size: int
    
    def to_dict(self) -> Dict:
        return {
            'format': self.format,
            'path': str(self.path),
            'file_size': self.file_size,
        }


class MeshExporter:
    """Export meshes to various formats"""
    
    SUPPORTED_FORMATS = ['glb', 'gltf', 'obj', 'ply', 'stl']
    
    def __init__(self, compress: bool = True):
        """
        Args:
            compress: Whether to apply compression where supported
        """
        self.compress = compress
        
        print(f"[MeshExporter] Initialized with compression={compress}")
    
    def export_all(
        self,
        mesh_path: Path,
        texture_path: Path = None,
        formats: List[str] = None,
        output_dir: Path = None,
    ) -> Dict[str, Path]:
        """
        Export mesh to multiple formats.
        
        Args:
            mesh_path: Path to input mesh
            texture_path: Path to texture image (optional)
            formats: List of output formats
            output_dir: Output directory
        
        Returns:
            Dict of format -> output path
        """
        if formats is None:
            formats = ['glb']
        
        if output_dir is None:
            output_dir = mesh_path.parent
        
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        results = {}
        
        for fmt in formats:
            fmt = fmt.lower()
            if fmt not in self.SUPPORTED_FORMATS:
                print(f"[MeshExporter] Warning: Unsupported format '{fmt}'")
                continue
            
            try:
                output_path = output_dir / f"model.{fmt}"
                
                if fmt == 'glb':
                    self._export_glb(mesh_path, texture_path, output_path)
                elif fmt == 'gltf':
                    self._export_gltf(mesh_path, texture_path, output_path)
                elif fmt == 'obj':
                    self._export_obj(mesh_path, texture_path, output_path)
                elif fmt == 'ply':
                    self._export_ply(mesh_path, output_path)
                elif fmt == 'stl':
                    self._export_stl(mesh_path, output_path)
                
                results[fmt] = output_path
                
                file_size = output_path.stat().st_size
                print(f"[MeshExporter] Exported {fmt}: {file_size / 1024 / 1024:.1f} MB")
                
            except Exception as e:
                print(f"[MeshExporter] Error exporting {fmt}: {e}")
        
        return results
    
    def _export_glb(
        self,
        mesh_path: Path,
        texture_path: Path,
        output_path: Path,
    ):
        """Export to GLB (binary GLTF)"""
        
        if HAS_TRIMESH:
            self._export_glb_trimesh(mesh_path, texture_path, output_path)
        elif HAS_OPEN3D:
            self._export_glb_open3d(mesh_path, texture_path, output_path)
        else:
            self._export_glb_manual(mesh_path, texture_path, output_path)
    
    def _export_glb_trimesh(
        self,
        mesh_path: Path,
        texture_path: Path,
        output_path: Path,
    ):
        """Export GLB using trimesh with proper texture handling"""
        
        mesh = trimesh.load(str(mesh_path), force='mesh')
        
        # Apply texture if available
        if texture_path and Path(texture_path).exists():
            from PIL import Image
            texture = Image.open(texture_path)
            
            # Generate UVs if not present
            if not hasattr(mesh.visual, 'uv') or mesh.visual.uv is None:
                print("[MeshExporter] Generating UV coordinates for texture...")
                vertices = np.asarray(mesh.vertices)
                
                # Normalize to 0-1 using XZ plane (good for rooms)
                min_v = vertices.min(axis=0)
                max_v = vertices.max(axis=0)
                range_v = max_v - min_v
                range_v[range_v == 0] = 1
                
                norm_v = (vertices - min_v) / range_v
                uv = np.column_stack([norm_v[:, 0], norm_v[:, 2]])
                
                mesh.visual = trimesh.visual.TextureVisuals(
                    uv=uv,
                    image=texture
                )
            else:
                mesh.visual = trimesh.visual.TextureVisuals(
                    uv=mesh.visual.uv,
                    image=texture
                )
            
            print(f"[MeshExporter] Applied texture: {texture.size}")
        
        # Export as GLB
        mesh.export(str(output_path), file_type='glb')
        print(f"[MeshExporter] Exported GLB with texture: {output_path}")
    
    def _export_glb_open3d(
        self,
        mesh_path: Path,
        texture_path: Path,
        output_path: Path,
    ):
        """Export GLB using Open3D (limited support)"""
        
        mesh = o3d.io.read_triangle_mesh(str(mesh_path))
        
        # Open3D doesn't directly export GLB, so we use the manual method
        self._export_glb_manual(mesh_path, texture_path, output_path)
    
    def _export_glb_manual(
        self,
        mesh_path: Path,
        texture_path: Path,
        output_path: Path,
    ):
        """Export GLB manually (fallback)"""
        
        # Load mesh
        vertices, faces, colors = self._load_mesh(mesh_path)
        
        if vertices is None:
            raise ValueError(f"Could not load mesh: {mesh_path}")
        
        # Build GLTF structure
        gltf = self._build_gltf(vertices, faces, colors, texture_path)
        
        # Write GLB
        self._write_glb(gltf, output_path)
    
    def _load_mesh(
        self,
        mesh_path: Path,
    ) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[np.ndarray]]:
        """Load mesh from file"""
        
        mesh_path = Path(mesh_path)
        
        if HAS_OPEN3D:
            mesh = o3d.io.read_triangle_mesh(str(mesh_path))
            vertices = np.asarray(mesh.vertices).astype(np.float32)
            faces = np.asarray(mesh.triangles).astype(np.uint32)
            colors = np.asarray(mesh.vertex_colors).astype(np.float32) if mesh.has_vertex_colors() else None
            return vertices, faces, colors
        
        elif HAS_TRIMESH:
            mesh = trimesh.load(str(mesh_path))
            vertices = mesh.vertices.astype(np.float32)
            faces = mesh.faces.astype(np.uint32)
            colors = mesh.visual.vertex_colors[:, :3] / 255.0 if hasattr(mesh.visual, 'vertex_colors') else None
            return vertices, faces, colors
        
        else:
            # Manual PLY/OBJ parsing
            if mesh_path.suffix.lower() == '.ply':
                return self._parse_ply(mesh_path)
            elif mesh_path.suffix.lower() == '.obj':
                return self._parse_obj(mesh_path)
        
        return None, None, None
    
    def _parse_ply(
        self,
        path: Path,
    ) -> Tuple[np.ndarray, np.ndarray, Optional[np.ndarray]]:
        """Parse PLY file manually"""
        
        vertices = []
        faces = []
        colors = []
        has_colors = False
        num_vertices = 0
        num_faces = 0
        in_header = True
        vertex_props = []
        
        with open(path, 'r') as f:
            for line in f:
                line = line.strip()
                
                if in_header:
                    if line.startswith('element vertex'):
                        num_vertices = int(line.split()[-1])
                    elif line.startswith('element face'):
                        num_faces = int(line.split()[-1])
                    elif line.startswith('property'):
                        parts = line.split()
                        if len(parts) >= 3:
                            vertex_props.append(parts[-1])
                            if parts[-1] in ['red', 'green', 'blue']:
                                has_colors = True
                    elif line == 'end_header':
                        in_header = False
                else:
                    # Parse data
                    parts = line.split()
                    
                    if len(vertices) < num_vertices:
                        x, y, z = float(parts[0]), float(parts[1]), float(parts[2])
                        vertices.append([x, y, z])
                        
                        if has_colors:
                            r = float(parts[3]) / 255 if float(parts[3]) > 1 else float(parts[3])
                            g = float(parts[4]) / 255 if float(parts[4]) > 1 else float(parts[4])
                            b = float(parts[5]) / 255 if float(parts[5]) > 1 else float(parts[5])
                            colors.append([r, g, b])
                    else:
                        # Face
                        n = int(parts[0])
                        if n >= 3:
                            face_indices = [int(parts[i + 1]) for i in range(n)]
                            # Triangulate if needed
                            for i in range(1, n - 1):
                                faces.append([face_indices[0], face_indices[i], face_indices[i + 1]])
        
        return (
            np.array(vertices, dtype=np.float32),
            np.array(faces, dtype=np.uint32),
            np.array(colors, dtype=np.float32) if colors else None,
        )
    
    def _parse_obj(
        self,
        path: Path,
    ) -> Tuple[np.ndarray, np.ndarray, Optional[np.ndarray]]:
        """Parse OBJ file manually"""
        
        vertices = []
        faces = []
        
        with open(path, 'r') as f:
            for line in f:
                line = line.strip()
                if line.startswith('v '):
                    parts = line.split()
                    vertices.append([float(parts[1]), float(parts[2]), float(parts[3])])
                elif line.startswith('f '):
                    parts = line.split()[1:]
                    # Handle v, v/vt, v/vt/vn formats
                    face = [int(p.split('/')[0]) - 1 for p in parts]
                    # Triangulate
                    for i in range(1, len(face) - 1):
                        faces.append([face[0], face[i], face[i + 1]])
        
        return (
            np.array(vertices, dtype=np.float32),
            np.array(faces, dtype=np.uint32),
            None,
        )
    
    def _build_gltf(
        self,
        vertices: np.ndarray,
        faces: np.ndarray,
        colors: Optional[np.ndarray],
        texture_path: Path = None,
    ) -> Dict:
        """Build GLTF JSON structure"""
        
        # Compute bounds
        min_pos = vertices.min(axis=0).tolist()
        max_pos = vertices.max(axis=0).tolist()
        
        # Build buffer data
        buffer_data = bytearray()
        
        # Positions
        pos_bytes = vertices.tobytes()
        pos_offset = len(buffer_data)
        buffer_data.extend(pos_bytes)
        
        # Indices
        indices_bytes = faces.flatten().tobytes()
        indices_offset = len(buffer_data)
        buffer_data.extend(indices_bytes)
        
        # Colors (if available)
        color_accessor = None
        if colors is not None:
            color_bytes = colors.astype(np.float32).tobytes()
            color_offset = len(buffer_data)
            buffer_data.extend(color_bytes)
            color_accessor = 2
        
        # Build GLTF structure
        gltf = {
            "asset": {"version": "2.0", "generator": "PropertyPro Photogrammetry"},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0}],
            "meshes": [{
                "primitives": [{
                    "attributes": {"POSITION": 0},
                    "indices": 1,
                    "mode": 4,  # TRIANGLES
                }]
            }],
            "accessors": [
                {
                    "bufferView": 0,
                    "componentType": 5126,  # FLOAT
                    "count": len(vertices),
                    "type": "VEC3",
                    "min": min_pos,
                    "max": max_pos,
                },
                {
                    "bufferView": 1,
                    "componentType": 5125,  # UNSIGNED_INT
                    "count": len(faces) * 3,
                    "type": "SCALAR",
                }
            ],
            "bufferViews": [
                {
                    "buffer": 0,
                    "byteOffset": pos_offset,
                    "byteLength": len(pos_bytes),
                    "target": 34962,  # ARRAY_BUFFER
                },
                {
                    "buffer": 0,
                    "byteOffset": indices_offset,
                    "byteLength": len(indices_bytes),
                    "target": 34963,  # ELEMENT_ARRAY_BUFFER
                }
            ],
            "buffers": [{
                "byteLength": len(buffer_data)
            }],
        }
        
        # Add colors
        if colors is not None:
            gltf["meshes"][0]["primitives"][0]["attributes"]["COLOR_0"] = 2
            gltf["accessors"].append({
                "bufferView": 2,
                "componentType": 5126,
                "count": len(colors),
                "type": "VEC3",
            })
            gltf["bufferViews"].append({
                "buffer": 0,
                "byteOffset": color_offset,
                "byteLength": len(color_bytes),
                "target": 34962,
            })
        
        gltf["_buffer_data"] = buffer_data
        
        return gltf
    
    def _write_glb(self, gltf: Dict, output_path: Path):
        """Write GLB binary file"""
        
        buffer_data = gltf.pop("_buffer_data")
        
        # JSON chunk
        json_str = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
        # Pad to 4-byte alignment
        while len(json_str) % 4 != 0:
            json_str += b' '
        
        # BIN chunk
        while len(buffer_data) % 4 != 0:
            buffer_data.append(0)
        
        # Write GLB
        with open(output_path, 'wb') as f:
            # Header
            f.write(b'glTF')  # Magic
            f.write(struct.pack('<I', 2))  # Version
            total_length = 12 + 8 + len(json_str) + 8 + len(buffer_data)
            f.write(struct.pack('<I', total_length))  # Total length
            
            # JSON chunk
            f.write(struct.pack('<I', len(json_str)))  # Chunk length
            f.write(b'JSON')  # Chunk type
            f.write(json_str)
            
            # BIN chunk
            f.write(struct.pack('<I', len(buffer_data)))  # Chunk length
            f.write(b'BIN\x00')  # Chunk type
            f.write(buffer_data)
    
    def _export_gltf(
        self,
        mesh_path: Path,
        texture_path: Path,
        output_path: Path,
    ):
        """Export to GLTF (JSON + separate files)"""
        
        if HAS_TRIMESH:
            mesh = trimesh.load(str(mesh_path))
            mesh.export(str(output_path), file_type='gltf')
        else:
            # Fall back to GLB
            glb_path = output_path.with_suffix('.glb')
            self._export_glb(mesh_path, texture_path, glb_path)
            shutil.copy(glb_path, output_path)
    
    def _export_obj(
        self,
        mesh_path: Path,
        texture_path: Path,
        output_path: Path,
    ):
        """Export to OBJ format"""
        
        if HAS_OPEN3D:
            mesh = o3d.io.read_triangle_mesh(str(mesh_path))
            o3d.io.write_triangle_mesh(str(output_path), mesh)
        elif HAS_TRIMESH:
            mesh = trimesh.load(str(mesh_path))
            mesh.export(str(output_path), file_type='obj')
        else:
            shutil.copy(mesh_path, output_path)
    
    def _export_ply(
        self,
        mesh_path: Path,
        output_path: Path,
    ):
        """Export to PLY format"""
        
        if mesh_path.suffix.lower() == '.ply':
            shutil.copy(mesh_path, output_path)
        elif HAS_OPEN3D:
            mesh = o3d.io.read_triangle_mesh(str(mesh_path))
            o3d.io.write_triangle_mesh(str(output_path), mesh)
        elif HAS_TRIMESH:
            mesh = trimesh.load(str(mesh_path))
            mesh.export(str(output_path), file_type='ply')
    
    def _export_stl(
        self,
        mesh_path: Path,
        output_path: Path,
    ):
        """Export to STL format"""
        
        if HAS_OPEN3D:
            mesh = o3d.io.read_triangle_mesh(str(mesh_path))
            o3d.io.write_triangle_mesh(str(output_path), mesh)
        elif HAS_TRIMESH:
            mesh = trimesh.load(str(mesh_path))
            mesh.export(str(output_path), file_type='stl')
        else:
            raise ValueError("No mesh library available for STL export")


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Export mesh to various formats')
    parser.add_argument('mesh', help='Path to mesh file')
    parser.add_argument('--output', '-o', default='./exports')
    parser.add_argument('--formats', nargs='+', default=['glb', 'obj'])
    parser.add_argument('--texture', help='Path to texture image')
    
    args = parser.parse_args()
    
    exporter = MeshExporter()
    
    results = exporter.export_all(
        Path(args.mesh),
        texture_path=Path(args.texture) if args.texture else None,
        formats=args.formats,
        output_dir=Path(args.output),
    )
    
    print(f"\nExport Results:")
    for fmt, path in results.items():
        size = path.stat().st_size / 1024 / 1024
        print(f"  {fmt}: {path} ({size:.1f} MB)")
