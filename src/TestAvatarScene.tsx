import { Canvas } from "@react-three/fiber";
import { Box, Sphere } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";

// Simple test avatar without GLTF loading
function TestAvatar() {
  const groupRef = useRef<THREE.Group>(null);
  
  useFrame((state) => {
    if (groupRef.current) {
      // Gentle rotation
      groupRef.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.5) * 0.1;
      groupRef.current.position.y = Math.sin(state.clock.elapsedTime * 0.7) * 0.02;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Head */}
      <Sphere args={[0.3]} position={[0, 0.5, 0]}>
        <meshStandardMaterial color="#ffdbac" />
      </Sphere>
      
      {/* Body */}
      <Box args={[0.4, 0.6, 0.2]} position={[0, -0.1, 0]}>
        <meshStandardMaterial color="#4F46E5" />
      </Box>
      
      {/* Eyes */}
      <Sphere args={[0.03]} position={[-0.1, 0.55, 0.25]}>
        <meshStandardMaterial color="#000" />
      </Sphere>
      <Sphere args={[0.03]} position={[0.1, 0.55, 0.25]}>
        <meshStandardMaterial color="#000" />
      </Sphere>
    </group>
  );
}

interface TestAvatarSceneProps {
  width?: number;
  height?: number;
}

export default function TestAvatarScene({ width = 160, height = 200 }: TestAvatarSceneProps) {
  return (
    <div style={{ width, height, borderRadius: "12px", overflow: "hidden" }}>
      <Canvas 
        camera={{ position: [0, 0, 2], fov: 50 }} 
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[2, 2, 1]} intensity={1} />
        <TestAvatar />
      </Canvas>
    </div>
  );
}
