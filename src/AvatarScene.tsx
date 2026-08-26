import { Canvas } from "@react-three/fiber";
import { Environment, ContactShadows } from "@react-three/drei";
import AvatarRPM from "./AvatarRPM";

const RPM_URL =
  "https://models.readyplayer.me/6411a3e7a243e6d6e6c8c7bc.glb";

interface AvatarSceneProps {
  width?: number;
  height?: number;
}

export default function AvatarScene({ width = 160, height = 200 }: AvatarSceneProps) {
  return (
    <div style={{ width, height, borderRadius: "12px", overflow: "hidden" }}>
      <Canvas 
        shadows 
        camera={{ position: [0, 1.6, 3.2], fov: 40 }} 
        dpr={[1, 2]}
        style={{ background: "transparent" }}
      >
        <Environment preset="apartment" background={false} />
        <directionalLight castShadow position={[2.5, 6, 4]} intensity={0.8} shadow-bias={-0.0001}/>
        <hemisphereLight intensity={0.25} groundColor="#222" />
        <spotLight position={[-3, 6, -2]} angle={0.3} penumbra={0.5} intensity={0.5} color="#7fb3ff" />
        <spotLight position={[3, 4, -4]} angle={0.4} penumbra={0.8} intensity={0.4} color="#ffa876" />

        {/* Your RPM avatar */}
        <AvatarRPM url={RPM_URL} recolor />

        <ContactShadows frames={1} position={[0, 0, 0]} scale={8} blur={3.5} opacity={0.2} far={4}/>
      </Canvas>
    </div>
  );
}
