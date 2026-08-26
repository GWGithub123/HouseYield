/**
 * 3D Model Viewer Component
 * Interactive Three.js viewer for displaying room scans
 */

import React, { useRef, useState, useEffect } from 'react';
import RefGaussianWebGPUViewer from './RefGaussianWebGPUViewer';
import {
  fetchRefGaussianBundleMetadata,
  fetchRefGaussianFloat32ArraySlice,
  getRefGaussianArray,
  hasRefGaussianArray,
  type RefGaussianArtifacts,
  type RefGaussianBundleMetadata,
  type RefGaussianMeshHybridArtifacts,
} from '../services/refGaussianBundleService';

interface Model3DViewerProps {
  modelUrl: string;
  framingPlyUrl?: string;
  viewerKind?: 'default' | 'refgaussian';
  refGaussianArtifacts?: RefGaussianArtifacts | null;
  refGaussianMeshHybridArtifacts?: RefGaussianMeshHybridArtifacts | null;
  overlayUrls?: string[];
  onClose?: () => void;
  showControls?: boolean;
}

const REF_GAUSSIAN_PREVIEW_POINT_LIMIT = 120000;
const SH_C0 = 0.28209479177387814;

function clamp01(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

function mat4Identity() {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

function mat4Perspective(fovyRadians: number, aspect: number, near: number, far: number) {
  const f = 1.0 / Math.tan(fovyRadians / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function normalizeVec3(value: [number, number, number]): [number, number, number] {
  const length = Math.hypot(value[0], value[1], value[2]) || 1;
  return [value[0] / length, value[1] / length, value[2] / length];
}

function crossVec3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dotVec3(a: [number, number, number], b: [number, number, number]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function mat4LookAt(
  eye: [number, number, number],
  center: [number, number, number],
  up: [number, number, number],
) {
  const z = normalizeVec3([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = normalizeVec3(crossVec3(up, z));
  const y = crossVec3(z, x);
  const out = mat4Identity();
  out[0] = x[0];
  out[1] = y[0];
  out[2] = z[0];
  out[4] = x[1];
  out[5] = y[1];
  out[6] = z[1];
  out[8] = x[2];
  out[9] = y[2];
  out[10] = z[2];
  out[12] = -dotVec3(x, eye);
  out[13] = -dotVec3(y, eye);
  out[14] = -dotVec3(z, eye);
  return out;
}

function mat4Multiply(a: Float32Array, b: Float32Array) {
  const out = new Float32Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function metadataArrayNames(metadata: RefGaussianBundleMetadata | null) {
  return metadata?.arrays?.filter((array) => array.kind === 'array').map((array) => array.name) || [];
}

// Fallback viewer using iframe for Gaussian Splat viewer
const GaussianSplatViewer: React.FC<{ url: string }> = ({ url }) => {
  return (
    <iframe
      src={url}
      className="w-full h-full border-0"
      allow="xr-spatial-tracking"
      title="3D Model Viewer"
    />
  );
};

const SplatViewer: React.FC<{ url: string; framingPlyUrl?: string; overlayUrls?: string[]; viewerKind?: 'default' | 'refgaussian' }> = ({
  url,
  framingPlyUrl,
  overlayUrls = [],
  viewerKind = 'default'
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let renderer: import('three').WebGLRenderer | null = null;
    let cleanup: (() => Promise<void>) | undefined;

    const isRefGaussianViewer = viewerKind === 'refgaussian';
    const loadViewer = async () => {
      try {
        const THREE = await import('three');
        const GaussianSplats3D = await import('@mkkellogg/gaussian-splats-3d');
        const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');

        if (!containerRef.current || disposed) return;

        const container = containerRef.current;
        const threeScene = new THREE.Scene();

        renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
        renderer.setSize(container.clientWidth, container.clientHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setClearColor(0x020617, 1);
        container.appendChild(renderer.domElement);

        const camera = new THREE.PerspectiveCamera(
          60,
          container.clientWidth / container.clientHeight,
          0.1,
          1000
        );
        camera.position.set(-1.5, -4, 6);
        camera.up.set(0, -1, -0.6).normalize();
        camera.lookAt(0, 0, 0);

        const initialCameraOffset = camera.position.clone();
        const initialCameraTarget = new THREE.Vector3(0, 0, 0);
        let robustFrame: { center: import('three').Vector3; maxDim: number } | null = null;

        if (framingPlyUrl) {
          try {
            const response = await fetch(framingPlyUrl, { cache: 'no-store' });
            if (response.ok) {
              const frameGeometry = new PLYLoader().parse(await response.arrayBuffer());
              const framePositions = frameGeometry.getAttribute('position');
              if (framePositions) {
                const frame = computeRobustPointCloudFrame(framePositions.array);
                robustFrame = {
                  center: new THREE.Vector3(...frame.center),
                  maxDim: Math.max(...frame.size, 0.001),
                };
              }
              frameGeometry.dispose();
            }
          } catch (frameError) {
            console.warn('Failed to load framing PLY for Gaussian splat viewer, using library scene bounds instead:', frameError);
          }
        }

        const viewer = new GaussianSplats3D.Viewer({
          selfDrivenMode: false,
          rootElement: container,
          renderer,
          camera,
          threeScene,
          useBuiltInControls: true,
          gpuAcceleratedSort: false,
          sharedMemoryForWorkers: false,
          integerBasedSort: false,
          sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
          renderMode: GaussianSplats3D.RenderMode.Always,
          logLevel: GaussianSplats3D.LogLevel.None,
          antialiased: true,
          kernel2DSize: isRefGaussianViewer ? 0.32 : (framingPlyUrl ? 0.18 : 0.15),
          maxScreenSpaceSplatSize: isRefGaussianViewer ? 96 : (framingPlyUrl ? 56 : 48),
          sphericalHarmonicsDegree: 0,
          freeIntermediateSplatData: true,
          optimizeSplatData: true,
        });

        let framedScene = false;
        const frameLoadedScene = () => {
          if (framedScene) return;

          const splatMesh = typeof viewer.getSplatMesh === 'function' ? viewer.getSplatMesh() : null;
          const center = robustFrame?.center || splatMesh?.calculatedSceneCenter;
          const radius = robustFrame
            ? robustFrame.maxDim * 0.5
            : splatMesh?.maxSplatDistanceFromSceneCenter;

          if (!center || !Number.isFinite(radius) || radius <= 0) {
            return;
          }

          if (typeof splatMesh?.setSplatScale === 'function') {
            splatMesh.setSplatScale(isRefGaussianViewer ? 0.85 : (framingPlyUrl ? 0.42 : 0.25));
          }

          const direction = initialCameraOffset.clone().sub(initialCameraTarget);
          if (direction.lengthSq() === 0) {
            direction.set(-0.25, -0.6, 1);
          }
          direction.normalize();

          const distance = robustFrame
            ? Math.min(Math.max(robustFrame.maxDim * 0.9, 2.25), 18)
            : Math.min(Math.max(radius * 2.25, 6), 30);
          camera.position.copy(center.clone().addScaledVector(direction, distance));
          camera.near = Math.max(distance / 200, 0.05);
          camera.far = Math.max(distance * 12, 100);
          camera.updateProjectionMatrix();

          const controls = (viewer as any).controls;
          if (controls?.target) {
            controls.target.copy(center);
            controls.update();
          } else {
            camera.lookAt(center);
          }

          framedScene = true;
          viewer.forceRenderNextFrame();
        };

        viewer.onSplatMeshChanged(() => {
          frameLoadedScene();
        });

        await viewer.addSplatScene(url, {
          format: normalizedSceneFormat(url, GaussianSplats3D),
          progressiveLoad: false,
          showLoadingUI: false,
          splatAlphaRemovalThreshold: isRefGaussianViewer ? 1 : (framingPlyUrl ? 1 : 5),
        });

        for (const overlayUrl of overlayUrls.filter(Boolean)) {
          await viewer.addSplatScene(overlayUrl, {
            format: normalizedSceneFormat(overlayUrl, GaussianSplats3D),
            progressiveLoad: false,
            showLoadingUI: false,
            splatAlphaRemovalThreshold: 1,
          });
        }

        frameLoadedScene();
        window.requestAnimationFrame(() => {
          frameLoadedScene();
        });

        if (disposed) {
          await viewer.dispose();
          return;
        }

        setLoading(false);

        let animationFrameId = 0;
        const renderLoop = () => {
          animationFrameId = window.requestAnimationFrame(renderLoop);
          viewer.update();
          viewer.render();
        };
        renderLoop();

        const handleResize = () => {
          if (!containerRef.current || !renderer) return;
          const width = containerRef.current.clientWidth;
          const height = containerRef.current.clientHeight;
          renderer.setSize(width, height);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          viewer.forceRenderNextFrame();
        };

        window.addEventListener('resize', handleResize);

        cleanup = async () => {
          window.cancelAnimationFrame(animationFrameId);
          window.removeEventListener('resize', handleResize);
          await viewer.dispose();
          if (renderer) {
            renderer.dispose();
            if (container.contains(renderer.domElement)) {
              container.removeChild(renderer.domElement);
            }
          }
        };
      } catch (err) {
        console.error('Failed to initialize Gaussian splat viewer:', err);
        setError('Failed to initialize gaussian splat viewer');
        setLoading(false);
      }
    };

    loadViewer();

    return () => {
      disposed = true;
      void cleanup?.();
    };
  }, [url, framingPlyUrl, overlayUrls, viewerKind]);

  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-950 text-white">
        <div className="text-center">
          <svg className="w-16 h-16 mx-auto mb-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full relative bg-slate-950">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950">
          <div className="text-center text-white">
            <div className="w-16 h-16 border-4 border-cyan-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p>Loading gaussian splat...</p>
          </div>
        </div>
      )}
    </div>
  );
};

function normalizedSceneFormat(url: string, GaussianSplats3D: any) {
  const normalizedUrl = url.toLowerCase();
  if (normalizedUrl.endsWith('.ksplat')) return GaussianSplats3D.SceneFormat.KSplat;
  if (normalizedUrl.endsWith('.ply')) return GaussianSplats3D.SceneFormat.Ply;
  return GaussianSplats3D.SceneFormat.Splat;
}

function quantileSorted(values: number[], q: number) {
  if (!values.length) return 0;
  const index = Math.max(0, Math.min(values.length - 1, Math.floor((values.length - 1) * q)));
  return values[index];
}

function computeRobustPointCloudFrame(positions: ArrayLike<number>) {
  const pointCount = Math.floor((positions.length || 0) / 3);
  if (!pointCount) {
    return {
      center: [0, 0, 0] as const,
      size: [1, 1, 1] as const,
    };
  }

  const maxSamples = 50000;
  const stride = Math.max(1, Math.floor(pointCount / maxSamples));
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += stride) {
    const offset = pointIndex * 3;
    xs.push(Number(positions[offset]) || 0);
    ys.push(Number(positions[offset + 1]) || 0);
    zs.push(Number(positions[offset + 2]) || 0);
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);

  const minX = quantileSorted(xs, 0.01);
  const minY = quantileSorted(ys, 0.01);
  const minZ = quantileSorted(zs, 0.01);
  const maxX = quantileSorted(xs, 0.99);
  const maxY = quantileSorted(ys, 0.99);
  const maxZ = quantileSorted(zs, 0.99);

  return {
    center: [
      (minX + maxX) * 0.5,
      (minY + maxY) * 0.5,
      (minZ + maxZ) * 0.5,
    ] as const,
    size: [
      Math.max(maxX - minX, 0.001),
      Math.max(maxY - minY, 0.001),
      Math.max(maxZ - minZ, 0.001),
    ] as const,
  };
}

const RefGaussianWebGPUPreview: React.FC<{ artifacts: RefGaussianArtifacts }> = ({ artifacts }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [metadata, setMetadata] = useState<RefGaussianBundleMetadata | null>(null);
  const [status, setStatus] = useState('Loading Ref-Gaussian bundle metadata...');
  const [error, setError] = useState<string | null>(null);
  const [pointCount, setPointCount] = useState(0);
  const [webgpuAvailable, setWebgpuAvailable] = useState(false);

  useEffect(() => {
    let disposed = false;
    let animationFrameId = 0;
    let device: any = null;
    let context: any = null;
    const cameraState = { yaw: 0.8, pitch: 0.35, radius: 3.2 };
    const dragState = { active: false, x: 0, y: 0 };

    const cleanupHandlers: Array<() => void> = [];

    const run = async () => {
      try {
        if (!artifacts.bundleJsonUrl) {
          setError('No Ref-Gaussian bundle metadata URL is available for this scan.');
          setStatus('Bundle unavailable');
          return;
        }

        const loadedMetadata = await fetchRefGaussianBundleMetadata(artifacts.bundleJsonUrl);
        if (disposed) return;
        setMetadata(loadedMetadata);

        const gpu = (navigator as any).gpu;
        if (!gpu) {
          setStatus('WebGPU is not available in this browser. Use Native Renders or Fallback Splat.');
          return;
        }

        const adapter = await gpu.requestAdapter();
        if (!adapter) {
          setStatus('WebGPU adapter unavailable. Use Native Renders or Fallback Splat.');
          return;
        }

        device = await adapter.requestDevice();
        const canvas = canvasRef.current;
        if (!canvas || disposed) return;
        context = (canvas.getContext as any)('webgpu');
        if (!context) {
          setStatus('WebGPU canvas context unavailable.');
          return;
        }

        setWebgpuAvailable(true);
        setStatus('Loading sampled positions and SH colors...');
        const previewRows = Math.min(REF_GAUSSIAN_PREVIEW_POINT_LIMIT, loadedMetadata.pointCount || REF_GAUSSIAN_PREVIEW_POINT_LIMIT);
        const positions = await fetchRefGaussianFloat32ArraySlice({
          bundleJsonUrl: artifacts.bundleJsonUrl,
          bundleBinUrl: artifacts.bundleBinUrl,
          metadata: loadedMetadata,
          arrayName: 'positions',
          maxRows: previewRows,
        });
        const shDc = hasRefGaussianArray(loadedMetadata, 'shDc')
          ? await fetchRefGaussianFloat32ArraySlice({
              bundleJsonUrl: artifacts.bundleJsonUrl,
              bundleBinUrl: artifacts.bundleBinUrl,
              metadata: loadedMetadata,
              arrayName: 'shDc',
              maxRows: positions.rowCount,
            })
          : null;

        if (disposed) return;

        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;
        for (let idx = 0; idx < positions.rowCount; idx += 1) {
          const sourceIdx = idx * positions.componentCount;
          const x = positions.data[sourceIdx + 0];
          const y = positions.data[sourceIdx + 1];
          const z = positions.data[sourceIdx + 2];
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          minZ = Math.min(minZ, z);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          maxZ = Math.max(maxZ, z);
        }

        const centerX = (minX + maxX) * 0.5;
        const centerY = (minY + maxY) * 0.5;
        const centerZ = (minZ + maxZ) * 0.5;
        const sceneScale = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
        const vertexData = new Float32Array(positions.rowCount * 6);
        for (let idx = 0; idx < positions.rowCount; idx += 1) {
          const positionSourceIdx = idx * positions.componentCount;
          const vertexIdx = idx * 6;
          vertexData[vertexIdx + 0] = (positions.data[positionSourceIdx + 0] - centerX) / sceneScale;
          vertexData[vertexIdx + 1] = (positions.data[positionSourceIdx + 1] - centerY) / sceneScale;
          vertexData[vertexIdx + 2] = (positions.data[positionSourceIdx + 2] - centerZ) / sceneScale;

          if (shDc) {
            const colorSourceIdx = idx * shDc.componentCount;
            vertexData[vertexIdx + 3] = clamp01(0.5 + SH_C0 * shDc.data[colorSourceIdx + 0]);
            vertexData[vertexIdx + 4] = clamp01(0.5 + SH_C0 * shDc.data[colorSourceIdx + 1]);
            vertexData[vertexIdx + 5] = clamp01(0.5 + SH_C0 * shDc.data[colorSourceIdx + 2]);
          } else {
            vertexData[vertexIdx + 3] = 0.8;
            vertexData[vertexIdx + 4] = 0.9;
            vertexData[vertexIdx + 5] = 1.0;
          }
        }

        setPointCount(positions.rowCount);

        const presentationFormat = typeof gpu.getPreferredCanvasFormat === 'function'
          ? gpu.getPreferredCanvasFormat()
          : 'bgra8unorm';
        const configureCanvas = () => {
          const width = Math.max(1, canvas.clientWidth);
          const height = Math.max(1, canvas.clientHeight);
          const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = Math.floor(width * pixelRatio);
          canvas.height = Math.floor(height * pixelRatio);
          context.configure({
            device,
            format: presentationFormat,
            alphaMode: 'opaque',
          });
        };
        configureCanvas();

        const shaderModule = device.createShaderModule({
          code: `
struct Uniforms {
  viewProj: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
};

@vertex
fn vertexMain(
  @location(0) position: vec3<f32>,
  @location(1) color: vec3<f32>,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = uniforms.viewProj * vec4<f32>(position, 1.0);
  output.color = color;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.color, 1.0);
}
          `,
        });

        const pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: {
            module: shaderModule,
            entryPoint: 'vertexMain',
            buffers: [{
              arrayStride: 6 * Float32Array.BYTES_PER_ELEMENT,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 3 * Float32Array.BYTES_PER_ELEMENT, format: 'float32x3' },
              ],
            }],
          },
          fragment: {
            module: shaderModule,
            entryPoint: 'fragmentMain',
            targets: [{ format: presentationFormat }],
          },
          primitive: {
            topology: 'point-list',
          },
        });

        const vertexBuffer = device.createBuffer({
          size: vertexData.byteLength,
          usage: 0x20 | 0x08,
          mappedAtCreation: true,
        });
        new Float32Array(vertexBuffer.getMappedRange()).set(vertexData);
        vertexBuffer.unmap();

        const uniformBuffer = device.createBuffer({
          size: 16 * Float32Array.BYTES_PER_ELEMENT,
          usage: 0x40 | 0x08,
        });
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
        });

        const updateCamera = () => {
          const width = Math.max(canvas.width, 1);
          const height = Math.max(canvas.height, 1);
          const eye: [number, number, number] = [
            Math.cos(cameraState.pitch) * Math.sin(cameraState.yaw) * cameraState.radius,
            Math.sin(cameraState.pitch) * cameraState.radius,
            Math.cos(cameraState.pitch) * Math.cos(cameraState.yaw) * cameraState.radius,
          ];
          const view = mat4LookAt(eye, [0, 0, 0], [0, 1, 0]);
          const projection = mat4Perspective(Math.PI / 3, width / height, 0.05, 100);
          device.queue.writeBuffer(uniformBuffer, 0, mat4Multiply(projection, view));
        };

        const render = () => {
          if (disposed) return;
          updateCamera();
          const commandEncoder = device.createCommandEncoder();
          const textureView = context.getCurrentTexture().createView();
          const pass = commandEncoder.beginRenderPass({
            colorAttachments: [{
              view: textureView,
              clearValue: { r: 0.01, g: 0.02, b: 0.05, a: 1 },
              loadOp: 'clear',
              storeOp: 'store',
            }],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.setVertexBuffer(0, vertexBuffer);
          pass.draw(positions.rowCount);
          pass.end();
          device.queue.submit([commandEncoder.finish()]);
          animationFrameId = window.requestAnimationFrame(render);
        };

        const handleResize = () => configureCanvas();
        const handlePointerDown = (event: PointerEvent) => {
          dragState.active = true;
          dragState.x = event.clientX;
          dragState.y = event.clientY;
          canvas.setPointerCapture(event.pointerId);
        };
        const handlePointerMove = (event: PointerEvent) => {
          if (!dragState.active) return;
          const dx = event.clientX - dragState.x;
          const dy = event.clientY - dragState.y;
          dragState.x = event.clientX;
          dragState.y = event.clientY;
          cameraState.yaw += dx * 0.006;
          cameraState.pitch = Math.min(Math.max(cameraState.pitch + dy * 0.006, -1.2), 1.2);
        };
        const handlePointerUp = (event: PointerEvent) => {
          dragState.active = false;
          try {
            canvas.releasePointerCapture(event.pointerId);
          } catch {
            // Pointer capture may already be released by the browser.
          }
        };
        const handleWheel = (event: WheelEvent) => {
          event.preventDefault();
          cameraState.radius = Math.min(Math.max(cameraState.radius + event.deltaY * 0.003, 0.8), 12);
        };
        window.addEventListener('resize', handleResize);
        canvas.addEventListener('pointerdown', handlePointerDown);
        canvas.addEventListener('pointermove', handlePointerMove);
        canvas.addEventListener('pointerup', handlePointerUp);
        canvas.addEventListener('pointercancel', handlePointerUp);
        canvas.addEventListener('wheel', handleWheel, { passive: false });
        cleanupHandlers.push(() => window.removeEventListener('resize', handleResize));
        cleanupHandlers.push(() => canvas.removeEventListener('pointerdown', handlePointerDown));
        cleanupHandlers.push(() => canvas.removeEventListener('pointermove', handlePointerMove));
        cleanupHandlers.push(() => canvas.removeEventListener('pointerup', handlePointerUp));
        cleanupHandlers.push(() => canvas.removeEventListener('pointercancel', handlePointerUp));
        cleanupHandlers.push(() => canvas.removeEventListener('wheel', handleWheel));

        setStatus('WebGPU geometry preview loaded from exported Ref-Gaussian bundle.');
        render();
      } catch (err) {
        console.error('Ref-Gaussian WebGPU preview failed:', err);
        if (!disposed) {
          setError(err instanceof Error ? err.message : 'Failed to load Ref-Gaussian WebGPU preview');
          setStatus('WebGPU preview unavailable.');
        }
      }
    };

    run();

    return () => {
      disposed = true;
      if (animationFrameId) {
        window.cancelAnimationFrame(animationFrameId);
      }
      cleanupHandlers.forEach((handler) => handler());
      device?.destroy?.();
    };
  }, [artifacts]);

  const pbrFields = ['reflectionStrength', 'metalness', 'roughness', 'diffuseColor']
    .filter((fieldName) => hasRefGaussianArray(metadata, fieldName));
  const interreflectionFields = ['indirectDc', 'indirectRest', 'indirectAsg']
    .filter((fieldName) => hasRefGaussianArray(metadata, fieldName));

  return (
    <div className="w-full h-full relative bg-slate-950 text-white">
      <canvas ref={canvasRef} className="w-full h-full block" />
      <div className="absolute left-4 top-4 max-w-md rounded-xl border border-white/10 bg-slate-950/85 p-4 shadow-xl backdrop-blur">
        <div className="flex items-center justify-between gap-4">
          <h3 className="font-semibold">WebGPU Ref-Gaussian Preview</h3>
          <span className={`rounded-full px-2 py-0.5 text-xs ${webgpuAvailable ? 'bg-emerald-500/20 text-emerald-200' : 'bg-amber-500/20 text-amber-200'}`}>
            {webgpuAvailable ? 'WebGPU active' : 'Detecting'}
          </span>
        </div>
        <p className="mt-2 text-sm text-slate-300">{status}</p>
        {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
        {metadata && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-300">
            <span>Total Gaussians</span>
            <span className="text-right text-white">{metadata.pointCount.toLocaleString()}</span>
            <span>Preview Points</span>
            <span className="text-right text-white">{pointCount.toLocaleString()}</span>
            <span>Checkpoint Iteration</span>
            <span className="text-right text-white">{metadata.source?.actualIteration ?? 'unknown'}</span>
            <span>Camera Calibration</span>
            <span className="text-right text-white">{metadata.cameraCalibration?.available ? 'available' : 'missing'}</span>
          </div>
        )}
        {metadata && (
          <div className="mt-3 space-y-2 text-xs text-slate-400">
            <p>
              MVP scope: draws sampled point geometry using exported positions and SH DC color.
              True anisotropic Gaussian splatting, depth sorting, opacity, scale/rotation footprint,
              deferred PBR, and native Ref-Gaussian reflection equations are still pending.
            </p>
            <p>PBR scaffold fields: {pbrFields.length ? pbrFields.join(', ') : 'none detected'}.</p>
            <p>Indirect-lighting scaffold fields: {interreflectionFields.length ? interreflectionFields.join(', ') : 'none detected'}.</p>
            <p>Arrays: {metadataArrayNames(metadata).join(', ')}</p>
          </div>
        )}
      </div>
    </div>
  );
};

const RefGaussianNativeRenderViewer: React.FC<{ viewerUrl?: string }> = ({ viewerUrl }) => {
  if (!viewerUrl) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-slate-950 text-white">
        <div className="max-w-md text-center">
          <h3 className="text-lg font-semibold">Native render gallery unavailable</h3>
          <p className="mt-2 text-sm text-slate-300">
            The Ref-Gaussian adapter did not publish a native render gallery for this scan.
          </p>
        </div>
      </div>
    );
  }

  return <GaussianSplatViewer url={viewerUrl} />;
};

const TexturedMeshViewer: React.FC<{ objUrl: string; mtlUrl?: string }> = ({ objUrl, mtlUrl }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let renderer: import('three').WebGLRenderer | null = null;
    let animationFrameId = 0;
    let disposed = false;

    const loadViewer = async () => {
      try {
        const THREE = await import('three');
        const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
        const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
        const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js');

        if (!containerRef.current || disposed) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0f172a);

        const camera = new THREE.PerspectiveCamera(
          75,
          containerRef.current.clientWidth / containerRef.current.clientHeight,
          0.01,
          5000,
        );
        camera.position.set(3, 2, 3);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        containerRef.current.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;

        scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
        directionalLight.position.set(8, 10, 6);
        scene.add(directionalLight);
        scene.add(new THREE.GridHelper(20, 20, 0x475569, 0x1e293b));

        const basePath = objUrl.substring(0, objUrl.lastIndexOf('/') + 1);
        const objLoader = new OBJLoader();
        if (mtlUrl) {
          const materials = await new Promise<any>((resolve, reject) => {
            const mtlLoader = new MTLLoader();
            mtlLoader.setResourcePath(basePath);
            mtlLoader.load(mtlUrl, resolve, undefined, reject);
          });
          materials.preload();
          objLoader.setMaterials(materials);
        }

        const object = await new Promise<THREE.Group>((resolve, reject) => {
          objLoader.load(objUrl, resolve, undefined, reject);
        });

        if (disposed || !containerRef.current) return;

        object.traverse((child) => {
          if (!(child as THREE.Mesh).isMesh) {
            return;
          }

          const mesh = child as THREE.Mesh;
          const hasUv = !!mesh.geometry?.attributes?.uv;
          const hasVertexColors = !!mesh.geometry?.attributes?.color;

          if (Array.isArray(mesh.material)) {
            mesh.material = mesh.material.map((material: any) => {
              const texture = material?.map || null;
              if (texture && hasUv) {
                texture.colorSpace = THREE.SRGBColorSpace;
                texture.needsUpdate = true;
                return new THREE.MeshBasicMaterial({
                  map: texture,
                  side: THREE.DoubleSide,
                  transparent: false,
                  opacity: 1,
                });
              }
              if (hasVertexColors) {
                return new THREE.MeshBasicMaterial({
                  vertexColors: true,
                  side: THREE.DoubleSide,
                  transparent: false,
                  opacity: 1,
                });
              }
              return new THREE.MeshBasicMaterial({
                color: material?.color || 0x888888,
                side: THREE.DoubleSide,
                transparent: false,
                opacity: 1,
              });
            });
          } else if (mesh.material) {
            const originalMaterial: any = mesh.material;
            const texture = originalMaterial?.map || null;
            if (texture && hasUv) {
              texture.colorSpace = THREE.SRGBColorSpace;
              texture.needsUpdate = true;
              mesh.material = new THREE.MeshBasicMaterial({
                map: texture,
                side: THREE.DoubleSide,
                transparent: false,
                opacity: 1,
              });
            } else if (hasVertexColors) {
              mesh.material = new THREE.MeshBasicMaterial({
                vertexColors: true,
                side: THREE.DoubleSide,
                transparent: false,
                opacity: 1,
              });
            } else {
              mesh.material = new THREE.MeshBasicMaterial({
                color: originalMaterial?.color || 0x888888,
                side: THREE.DoubleSide,
                transparent: false,
                opacity: 1,
              });
            }
          }

          mesh.geometry.computeVertexNormals();
          mesh.geometry.computeBoundingSphere();
        });

        const box = new THREE.Box3().setFromObject(object);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 0.001);
        object.position.sub(center);
        camera.position.set(maxDim * 1.4, maxDim * 0.9, maxDim * 1.4);
        controls.target.set(0, 0, 0);
        controls.update();
        scene.add(object);
        setLoading(false);

        const animate = () => {
          animationFrameId = window.requestAnimationFrame(animate);
          controls.update();
          renderer?.render(scene, camera);
        };
        animate();

        const handleResize = () => {
          if (!containerRef.current || !renderer) return;
          camera.aspect = containerRef.current.clientWidth / containerRef.current.clientHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
        };
        window.addEventListener('resize', handleResize);

        return () => {
          window.removeEventListener('resize', handleResize);
        };
      } catch (loadError) {
        console.error('[TexturedMeshViewer] Failed to load mesh:', loadError);
        if (!disposed) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load textured mesh');
          setLoading(false);
        }
      }
    };

    const cleanupPromise = loadViewer();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrameId);
      cleanupPromise.then((removeResizeListener) => removeResizeListener?.());
      if (renderer && containerRef.current?.contains(renderer.domElement)) {
        containerRef.current.removeChild(renderer.domElement);
      }
      renderer?.dispose();
    };
  }, [objUrl, mtlUrl]);

  return (
    <div className="relative w-full h-full bg-slate-950">
      <div ref={containerRef} className="w-full h-full" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 text-white">
          <div className="text-center">
            <div className="w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-sm text-slate-300">Loading textured mesh…</p>
            <p className="text-xs text-slate-500 mt-1">Large meshes can take a minute.</p>
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/90 text-white p-6">
          <div className="max-w-md text-center">
            <h3 className="text-lg font-semibold text-red-300">Mesh failed to load</h3>
            <p className="mt-2 text-sm text-slate-300">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
};

const RefGaussianTabbedViewer: React.FC<{
  artifacts: RefGaussianArtifacts;
  meshHybridArtifacts?: RefGaussianMeshHybridArtifacts | null;
  fallbackUrl: string;
  overlayUrls?: string[];
}> = ({ artifacts, meshHybridArtifacts = null, fallbackUrl, overlayUrls = [] }) => {
  type RefGaussianTab = 'webgpu' | 'native' | 'splat' | 'mesh';
  const fallbackSplatUrl = artifacts.splatUrl || artifacts.plyUrl || fallbackUrl;
  const meshObjUrl = meshHybridArtifacts?.texturedObjUrl;
  const meshMtlUrl = meshHybridArtifacts?.mtlUrl;
  const initialTab: RefGaussianTab = meshObjUrl
    ? 'mesh'
    : fallbackSplatUrl
      ? 'splat'
      : artifacts.viewerUrl
        ? 'native'
        : 'webgpu';
  const [activeTab, setActiveTab] = useState<RefGaussianTab>(initialTab);
  const tabs: Array<{ id: RefGaussianTab; label: string; available: boolean; detail: string }> = [
    {
      id: 'mesh',
      label: 'Textured Mesh',
      available: Boolean(meshObjUrl),
      detail: meshHybridArtifacts?.numFaces
        ? `${meshHybridArtifacts.numFaces.toLocaleString()} faces from Ref-Gaussian Poisson + OpenMVS`
        : 'Ref-Gaussian hybrid mesh',
    },
    {
      id: 'webgpu',
      label: 'WebGPU Parity Debug',
      available: Boolean(artifacts.bundleJsonUrl),
      detail: 'Experimental native render_surfel parity path',
    },
    {
      id: 'native',
      label: 'Native Renders',
      available: Boolean(artifacts.viewerUrl),
      detail: 'Official Ref-Gaussian render gallery',
    },
    {
      id: 'splat',
      label: 'Interactive Splat',
      available: Boolean(fallbackSplatUrl),
      detail: 'Current interactive baseline while WebGPU parity is validated',
    },
  ];

  return (
    <div className="w-full h-full flex flex-col bg-slate-950">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-slate-900 px-4 py-3 text-white">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              disabled={!tab.available}
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'bg-cyan-600 text-white'
                  : tab.available
                    ? 'bg-white/10 text-slate-200 hover:bg-white/15'
                    : 'bg-white/5 text-slate-500 cursor-not-allowed'
              }`}
              title={tab.detail}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-slate-400">
          {meshHybridArtifacts?.numVertices
            ? `${meshHybridArtifacts.numVertices.toLocaleString()} mesh vertices`
            : `${Number(artifacts.pointCount || 0).toLocaleString()} Ref-Gaussian points`}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {activeTab === 'mesh' && meshObjUrl && (
          <TexturedMeshViewer objUrl={meshObjUrl} mtlUrl={meshMtlUrl} />
        )}
        {activeTab === 'webgpu' && artifacts.bundleJsonUrl && (
          <RefGaussianWebGPUViewer artifacts={artifacts} />
        )}
        {activeTab === 'webgpu' && !artifacts.bundleJsonUrl && (
          <div className="w-full h-full flex items-center justify-center text-white">
            <p>Ref-Gaussian bundle metadata is not published for this scan.</p>
          </div>
        )}
        {activeTab === 'native' && <RefGaussianNativeRenderViewer viewerUrl={artifacts.viewerUrl} />}
        {activeTab === 'splat' && fallbackSplatUrl && (
          fallbackSplatUrl.toLowerCase().endsWith('.ply')
            ? <PLYViewer url={fallbackSplatUrl} />
            : <SplatViewer url={fallbackSplatUrl} overlayUrls={overlayUrls} viewerKind="refgaussian" />
        )}
      </div>
    </div>
  );
};

const PLYViewer: React.FC<{ url: string }> = ({ url }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let renderer: import('three').WebGLRenderer | null = null;
    let cleanup: (() => void) | undefined;

    const loadViewer = async () => {
      try {
        const THREE = await import('three');
        const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
        const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');

        if (!containerRef.current) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0f172a);

        const camera = new THREE.PerspectiveCamera(
          75,
          containerRef.current.clientWidth / containerRef.current.clientHeight,
          0.01,
          5000
        );
        camera.position.set(3, 2, 3);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        containerRef.current.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.enableZoom = true;
        controls.enablePan = true;

        scene.add(new THREE.AmbientLight(0xffffff, 0.9));

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
        directionalLight.position.set(8, 10, 6);
        scene.add(directionalLight);

        const gridHelper = new THREE.GridHelper(20, 20, 0x475569, 0x1e293b);
        scene.add(gridHelper);

        const loader = new PLYLoader();
        loader.load(
          url,
          (geometry) => {
            geometry.computeBoundingBox();
            const rawBox = geometry.boundingBox?.clone() || new THREE.Box3();
            const positions = geometry.getAttribute('position');
            const robustFrame = positions
              ? computeRobustPointCloudFrame(positions.array)
              : {
                  center: [
                    rawBox.getCenter(new THREE.Vector3()).x,
                    rawBox.getCenter(new THREE.Vector3()).y,
                    rawBox.getCenter(new THREE.Vector3()).z,
                  ] as const,
                  size: [
                    rawBox.getSize(new THREE.Vector3()).x,
                    rawBox.getSize(new THREE.Vector3()).y,
                    rawBox.getSize(new THREE.Vector3()).z,
                  ] as const,
                };
            const center = new THREE.Vector3(...robustFrame.center);
            const maxDim = Math.max(...robustFrame.size, 0.001);

            geometry.translate(-center.x, -center.y, -center.z);

            const hasFaces = Boolean(geometry.index && geometry.index.count > 0);
            const hasVertexColors = Boolean(geometry.getAttribute('color'));

            const object = hasFaces
              ? new THREE.Mesh(
                  geometry,
                  new THREE.MeshStandardMaterial({
                    color: hasVertexColors ? 0xffffff : 0x94a3b8,
                    vertexColors: hasVertexColors,
                    metalness: 0.05,
                    roughness: 0.9,
                  })
                )
              : new THREE.Points(
                  geometry,
                  new THREE.PointsMaterial({
                    color: hasVertexColors ? 0xffffff : 0xcbd5e1,
                    vertexColors: hasVertexColors,
                    size: Math.max(maxDim / 1200, 0.003),
                    sizeAttenuation: true,
                    transparent: true,
                    opacity: hasVertexColors ? 0.92 : 0.8,
                  })
                );

            scene.add(object);
            setLoading(false);

            const fitDistance = Math.max(maxDim * 1.35, 1.5);
            camera.position.set(fitDistance, fitDistance * 0.6, fitDistance);
            controls.target.set(0, 0, 0);
            controls.update();
          },
          undefined,
          (err) => {
            console.error('PLY loading error:', err);
            setError('Failed to load point cloud');
            setLoading(false);
          }
        );

        const animate = () => {
          if (!renderer) return;
          requestAnimationFrame(animate);
          controls.update();
          renderer.render(scene, camera);
        };
        animate();

        const handleResize = () => {
          if (!containerRef.current || !renderer) return;
          camera.aspect = containerRef.current.clientWidth / containerRef.current.clientHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
        };
        window.addEventListener('resize', handleResize);

        cleanup = () => {
          window.removeEventListener('resize', handleResize);
          controls.dispose();
          scene.traverse((child) => {
            const geometry = (child as { geometry?: import('three').BufferGeometry }).geometry;
            const material = (child as { material?: import('three').Material | import('three').Material[] }).material;
            geometry?.dispose?.();
            if (Array.isArray(material)) {
              material.forEach((entry) => entry.dispose());
            } else {
              material?.dispose?.();
            }
          });
          if (containerRef.current && renderer) {
            containerRef.current.removeChild(renderer.domElement);
          }
          renderer?.dispose();
        };
      } catch (err) {
        console.error('Failed to initialize PLY viewer:', err);
        setError('Failed to initialize point cloud viewer');
        setLoading(false);
      }
    };

    loadViewer();

    return () => {
      cleanup?.();
    };
  }, [url]);

  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-900 text-white">
        <div className="text-center">
          <svg className="w-16 h-16 mx-auto mb-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full relative">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
          <div className="text-center text-white">
            <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p>Loading point cloud...</p>
          </div>
        </div>
      )}
    </div>
  );
};

// Simple WebGL-based GLB/GLTF viewer
const GLBViewer: React.FC<{ url: string }> = ({ url }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Dynamic import of Three.js to reduce bundle size
    const loadViewer = async () => {
      try {
        const THREE = await import('three');
        const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

        if (!containerRef.current) return;

        // Scene setup
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1a1a2e);

        // Camera
        const camera = new THREE.PerspectiveCamera(
          75,
          containerRef.current.clientWidth / containerRef.current.clientHeight,
          0.1,
          1000
        );
        camera.position.set(5, 5, 5);

        // Renderer
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.shadowMap.enabled = true;
        containerRef.current.appendChild(renderer.domElement);

        // Controls
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.enableZoom = true;
        controls.enablePan = true;
        controls.autoRotate = false;

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(10, 10, 10);
        directionalLight.castShadow = true;
        scene.add(directionalLight);

        const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.5);
        directionalLight2.position.set(-10, 10, -10);
        scene.add(directionalLight2);

        // Grid helper
        const gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
        scene.add(gridHelper);

        // Load model
        const loader = new GLTFLoader();
        loader.load(
          url,
          (gltf) => {
            const model = gltf.scene;

            // Center and scale model
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());

            model.position.sub(center);

            // Scale to fit
            const maxDim = Math.max(size.x, size.y, size.z);
            if (maxDim > 10) {
              const scale = 10 / maxDim;
              model.scale.setScalar(scale);
            }

            scene.add(model);
            setLoading(false);

            // Adjust camera to fit model
            const boundingSphere = new THREE.Sphere();
            box.getBoundingSphere(boundingSphere);
            const distance = boundingSphere.radius * 2.5;
            camera.position.set(distance, distance, distance);
            controls.target.set(0, 0, 0);
            controls.update();
          },
          (progress) => {
            console.log('Loading progress:', (progress.loaded / progress.total) * 100, '%');
          },
          (err) => {
            console.error('Model loading error:', err);
            setError('Failed to load 3D model');
            setLoading(false);
          }
        );

        // Animation loop
        const animate = () => {
          requestAnimationFrame(animate);
          controls.update();
          renderer.render(scene, camera);
        };
        animate();

        // Handle resize
        const handleResize = () => {
          if (!containerRef.current) return;
          camera.aspect = containerRef.current.clientWidth / containerRef.current.clientHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
        };
        window.addEventListener('resize', handleResize);

        // Cleanup
        return () => {
          window.removeEventListener('resize', handleResize);
          if (containerRef.current) {
            containerRef.current.removeChild(renderer.domElement);
          }
          renderer.dispose();
        };
      } catch (err) {
        console.error('Failed to load Three.js:', err);
        setError('Failed to initialize 3D viewer');
        setLoading(false);
      }
    };

    loadViewer();
  }, [url]);

  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-900 text-white">
        <div className="text-center">
          <svg className="w-16 h-16 mx-auto mb-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full relative">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
          <div className="text-center text-white">
            <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p>Loading 3D model...</p>
          </div>
        </div>
      )}
    </div>
  );
};

const Model3DViewer: React.FC<Model3DViewerProps> = ({
  modelUrl,
  framingPlyUrl,
  viewerKind = 'default',
  refGaussianArtifacts = null,
  refGaussianMeshHybridArtifacts = null,
  overlayUrls = [],
  onClose,
  showControls = true
}) => {
  const [viewMode, setViewMode] = useState<'orbit' | 'walkthrough' | 'floorplan'>('orbit');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Determine viewer type based on URL
  const normalizedModelUrl = modelUrl.toLowerCase();
  const isHostedGaussianViewer = normalizedModelUrl.includes('lumalabs');
  const isHtmlViewer = normalizedModelUrl.endsWith('.html');
  const isSplat = normalizedModelUrl.endsWith('.splat') || normalizedModelUrl.endsWith('.ksplat');
  const isGLB = normalizedModelUrl.endsWith('.glb') || normalizedModelUrl.endsWith('.gltf');
  const isPLY = normalizedModelUrl.endsWith('.ply');
  const isIframeViewer = isHostedGaussianViewer || isHtmlViewer;
  const isRefGaussianViewer = viewerKind === 'refgaussian';
  const sourceLabel = isRefGaussianViewer
    ? 'RefGaussian reflective model'
    : isHtmlViewer
    ? 'Embedded room-tour viewer'
    : isSplat
      ? 'Gaussian splat asset'
    : isPLY
      ? 'Gaussian point-cloud asset'
    : isGLB
      ? 'Mesh model asset'
      : '3D scene asset';

  // Toggle fullscreen
  const toggleFullscreen = async () => {
    if (!containerRef.current) return;

    try {
      if (!document.fullscreenElement) {
        await containerRef.current.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch (err) {
      console.error('Fullscreen error:', err);
    }
  };

  // Handle fullscreen change
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  return (
    <div
      ref={containerRef}
      className="w-full h-screen min-h-screen bg-gray-900 flex flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-4">
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-700 rounded-lg transition-colors text-white"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <h2 className="text-xl font-semibold text-white">
            {isRefGaussianViewer ? 'RefGaussian Room View' : '3D Room View'}
          </h2>
        </div>

        {showControls && (
          <div className="flex items-center gap-2">
            {/* View mode buttons */}
            <div className="flex bg-gray-700 rounded-lg p-1">
              <button
                onClick={() => setViewMode('orbit')}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  viewMode === 'orbit'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-300 hover:text-white'
                }`}
              >
                Orbit
              </button>
              <button
                onClick={() => setViewMode('walkthrough')}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  viewMode === 'walkthrough'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-300 hover:text-white'
                }`}
              >
                Walk
              </button>
              <button
                onClick={() => setViewMode('floorplan')}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  viewMode === 'floorplan'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-300 hover:text-white'
                }`}
              >
                Floor Plan
              </button>
            </div>

            {/* Fullscreen button */}
            <button
              onClick={toggleFullscreen}
              className="p-2 hover:bg-gray-700 rounded-lg transition-colors text-white"
            >
              {isFullscreen ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                </svg>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Viewer */}
      <div className="flex-1 min-h-0 relative">
        {isRefGaussianViewer && refGaussianArtifacts && (
          <RefGaussianTabbedViewer
            artifacts={refGaussianArtifacts}
            meshHybridArtifacts={refGaussianMeshHybridArtifacts}
            fallbackUrl={modelUrl}
            overlayUrls={overlayUrls}
          />
        )}
        {!(isRefGaussianViewer && refGaussianArtifacts) && isIframeViewer && <GaussianSplatViewer url={modelUrl} />}
        {!(isRefGaussianViewer && refGaussianArtifacts) && isSplat && <SplatViewer url={modelUrl} framingPlyUrl={framingPlyUrl} overlayUrls={overlayUrls} viewerKind={viewerKind} />}
        {!(isRefGaussianViewer && refGaussianArtifacts) && isGLB && <GLBViewer url={modelUrl} />}
        {!(isRefGaussianViewer && refGaussianArtifacts) && isPLY && <PLYViewer url={modelUrl} />}
        {!(isRefGaussianViewer && refGaussianArtifacts) && !isIframeViewer && !isSplat && !isGLB && !isPLY && (
          <div className="w-full h-full flex items-center justify-center text-white">
            <div className="text-center">
              <svg className="w-16 h-16 mx-auto mb-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
              <p className="text-gray-400 mb-4">Preview not available for this format</p>
              <a
                href={modelUrl}
                download
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download Model
              </a>
            </div>
          </div>
        )}

        {/* Controls hint */}
        <div className="absolute bottom-4 left-4 bg-black/50 backdrop-blur-sm rounded-lg px-4 py-2 text-white text-sm">
          <p>🖱️ Drag to rotate • Scroll to zoom • Right-click to pan</p>
        </div>
      </div>

      {/* Bottom toolbar */}
      <div className="flex items-center justify-between p-4 bg-gray-800 border-t border-gray-700">
        <div className="flex items-center gap-4 text-gray-400 text-sm">
          <span>{sourceLabel}</span>
        </div>

        <div className="flex items-center gap-2">
          {/* Download button */}
          <a
            href={modelUrl}
            download
            className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Download
          </a>

          {/* Share button */}
          <button
            onClick={() => {
              navigator.clipboard.writeText(modelUrl);
              alert('Link copied to clipboard!');
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
            Share
          </button>
        </div>
      </div>
    </div>
  );
};

export default Model3DViewer;
