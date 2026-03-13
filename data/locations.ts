import { Vector3Tuple } from "three";
import { CameraConfig } from "@/store/useAeroStore";

export interface RoomLocation {
  id: string;
  label: string;
  camera: CameraConfig;
}

export const locations: Record<string, RoomLocation> = {
  "living-room": {
    id: "living-room",
    label: "Living Room",
    camera: {
      position: [0, 1.6, 4],
      lookAt: [0, 1, 0],
    },
  },
  kitchen: {
    id: "kitchen",
    label: "Kitchen",
    camera: {
      position: [4, 1.6, 2],
      lookAt: [4, 1, -1],
    },
  },
  balcony: {
    id: "balcony",
    label: "Balcony",
    camera: {
      position: [-3, 2, 6],
      lookAt: [-3, 1.5, 0],
    },
  },
};

// Typed helper — ensures Vector3Tuple usage is not accidentally widened to number[]
export type LocationKey = keyof typeof locations;
