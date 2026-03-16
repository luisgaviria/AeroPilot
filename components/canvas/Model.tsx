"use client";

import { useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { Box3, Vector3 } from "three";
import { ThreeElements } from "@react-three/fiber";
import { useAeroStore } from "@/store/useAeroStore";
import { getRoomDimensions } from "@/utils/spatial";

type ModelProps = ThreeElements["group"];

export function Model(props: ModelProps) {
  const { scene } = useGLTF("/models/apartment.glb");
  const centeredRef = useRef(false);
  const setRoomDimensions = useAeroStore((s) => s.setRoomDimensions);
  const setGltfScene      = useAeroStore((s) => s.setGltfScene);

  // Runs synchronously on the first render — before any useFrame or raycasting.
  // Centers the GLTF so its bounding-box XZ midpoint is at world (0, ?, 0) and
  // lifts it so the bounding-box floor sits at y = 0.  This eliminates the
  // "room stuck in corner" drift and keeps ROOM_Y_MIN / ROOM_Y_MAX valid.
  if (!centeredRef.current) {
    centeredRef.current = true;
    const box = new Box3().setFromObject(scene);
    const center = new Vector3();
    box.getCenter(center);
    scene.position.set(-center.x, -box.min.y, -center.z);
    scene.updateMatrixWorld(true);
    // Store the absolute GLB bounding box AFTER centering so getRoomDimensions
    // can read it without relying on mesh-name heuristics.  Must be computed
    // post-updateMatrixWorld so all child transforms are current.
    scene.userData.boundingBox = new Box3().setFromObject(scene);
    const dims = getRoomDimensions(scene);
    setRoomDimensions(dims, "fallback");
    setGltfScene(scene);
    console.log(
      `[Model] centred — offset (${(-center.x).toFixed(2)}, ${(-box.min.y).toFixed(2)}, ${(-center.z).toFixed(2)})` +
      ` room ${(box.max.x - box.min.x).toFixed(1)}×${(box.max.y - box.min.y).toFixed(1)}×${(box.max.z - box.min.z).toFixed(1)} m`,
      dims ? `| dims ${dims.width}×${dims.length}×${dims.height} m` : ""
    );
  }

  return <primitive object={scene} {...props} />;
}

// Preload so the model is fetched before the canvas mounts
useGLTF.preload("/models/apartment.glb");
