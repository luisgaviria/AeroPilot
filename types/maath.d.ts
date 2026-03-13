// Ambient declaration so TypeScript accepts the subpath import.
// The actual types are inferred from the maath package's own declaration files.
declare module "maath/easing" {
  export { damp3, damp2, damp4, dampAngle, dampLookAt, dampC, dampE, dampQ, dampS, dampM } from "maath";
}
