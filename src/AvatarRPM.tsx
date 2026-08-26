import { useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/** RPM utilities */
function setMatColor(root: THREE.Object3D, names: string[], color: string, opts: any = {}) {
  root.traverse((o: any) => {
    if (!o.isMesh || !o.material) return;
    const ok = names.some((n) => (o.material.name || "").toLowerCase().includes(n));
    if (!ok) return;

    // Convert to standard material so we can tint reliably
    if (!(o.material instanceof THREE.MeshStandardMaterial)) {
      o.material = new THREE.MeshStandardMaterial();
    }
    o.material.color = new THREE.Color(color);
    if (opts.metalness !== undefined) o.material.metalness = opts.metalness;
    if (opts.roughness !== undefined) o.material.roughness = opts.roughness;
    if (opts.removeMap) o.material.map = null;
    o.material.needsUpdate = true;
  });
}

/** Blink using ARKit morph targets on RPM heads: eyeBlinkLeft/Right (or blinkLeft/Right) */
function useBlink(root: THREE.Object3D) {
  useEffect(() => {
    const morphs: any[] = [];
    root.traverse((o: any) => {
      if (o.isMesh && o.morphTargetDictionary && o.morphTargetInfluences) {
        const dict = o.morphTargetDictionary;
        const left = dict.eyeBlinkLeft ?? dict.blinkLeft;
        const right = dict.eyeBlinkRight ?? dict.blinkRight;
        if (left !== undefined && right !== undefined) {
          morphs.push({ o, left, right });
        }
      }
    });
    if (!morphs.length) return;

    let raf = 0, t = 0, nextBlink = 0;
    const loop = () => {
      t += 1 / 60;
      if (t > nextBlink) {
        // quick blink
        const phase = (t - nextBlink) * 12; // speed
        const v = Math.max(0, 1 - Math.abs(phase - 1));
        morphs.forEach(({ o, left, right }) => {
          o.morphTargetInfluences[left] = v;
          o.morphTargetInfluences[right] = v;
        });
        if (phase > 2) {
          nextBlink = t + 1 + Math.random() * 4; // next blink in 1-5 sec
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [root]);
}

interface AvatarRPMProps {
  url: string;
  recolor?: boolean;
}

export default function AvatarRPM({ url, recolor }: AvatarRPMProps) {
  const gltf = useGLTF(url);
  const avatarRef = useRef<THREE.Group>(null);

  // Clone the scene to avoid modifying the original
  const scene = useMemo(() => gltf.scene.clone(), [gltf]);

  // Recolor materials
  useEffect(() => {
    if (!recolor || !scene) return;
    
    // Recolor shirt to blue
    setMatColor(scene, ["shirt", "top", "cloth"], "#4F46E5", {
      metalness: 0.1,
      roughness: 0.8,
    });
    
    // Optionally recolor other parts
    setMatColor(scene, ["pants", "bottom"], "#1F2937", {
      metalness: 0.1,
      roughness: 0.9,
    });
  }, [scene, recolor]);

  // Set up blinking
  useBlink(scene);

  // Idle animation
  useFrame((state) => {
    if (!avatarRef.current) return;
    
    // Gentle swaying motion
    const t = state.clock.elapsedTime;
    avatarRef.current.rotation.y = Math.sin(t * 0.5) * 0.05;
    avatarRef.current.position.y = Math.sin(t * 0.7) * 0.02;
  });

  return (
    <group ref={avatarRef} dispose={null}>
      <primitive object={scene} />
    </group>
  );
}
